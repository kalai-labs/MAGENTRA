import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import type { AnyToolDefinition, ToolDefinition, ToolResult } from "../agent/tool.js";

/**
 * Hand-rolled stdio MCP client. Speaks JSON-RPC 2.0 over the child process
 * stdin/stdout. Per the MCP spec, the stdio transport is *newline-delimited*
 * JSON (one message per line, no embedded newlines) — Content-Length framing is
 * NOT used. See https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 10_000;

/** Config for a single stdio MCP server, parsed from settings.mcpServers[name]. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export const mcpServerConfigSchema: z.ZodType<McpServerConfig> = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Thrown by callTool when the MCP result carries isError: true. */
export class McpToolError extends Error {
  constructor(public readonly text: string) {
    super(text);
    this.name = "McpToolError";
  }
}

export class McpClient {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private stdoutBuf = "";
  private closed = false;
  private failure: Error | undefined;

  private constructor(
    readonly serverName: string,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Drain stderr so the pipe buffer never fills and blocks the child.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("error", (err) => this.fail(err));
    child.on("exit", (code) =>
      this.fail(new Error(`MCP server "${serverName}" process exited (code ${code ?? "null"})`)),
    );
  }

  static async connect(name: string, config: McpServerConfig): Promise<McpClient> {
    const child = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(config.env ?? {}) },
    });
    const client = new McpClient(name, child as ChildProcessWithoutNullStreams);
    await client.initialize();
    return client;
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "magentra", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request("tools/list", {})) as { tools?: unknown[] } | undefined;
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.map((t) => {
      const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
      return {
        name: String(tool.name ?? ""),
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object" },
      };
    });
  }

  /**
   * Calls a tool and returns the concatenated text content. Throws McpToolError
   * (carrying the same text) when the MCP result reports isError: true, so the
   * caller can surface it as a tool error.
   */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const result = (await this.request(
      "tools/call",
      { name, arguments: args ?? {} },
      signal,
    )) as { content?: unknown[]; isError?: boolean } | undefined;

    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts
      .map((p) => {
        const part = p as { type?: unknown; text?: unknown };
        if (part.type === "text" && typeof part.text === "string") return part.text;
        if (part.type === "image") return "[image content omitted]";
        return "";
      })
      .filter(Boolean)
      .join("\n");

    const out = text || "(tool returned no textual content)";
    if (result?.isError) throw new McpToolError(out);
    return out;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failure ??= new Error("MCP client closed");
    for (const p of this.pending.values()) p.reject(this.failure);
    this.pending.clear();
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    this.child.kill();
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.failure = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // Not a JSON-RPC message; ignore per spec tolerance.
    }
    if (typeof msg.id !== "number") return; // notification/request from server — unused.
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message || `MCP error code ${msg.error.code}`));
    else pending.resolve(msg.result);
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // ignore; a failed notify is non-fatal.
    }
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();

      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`MCP request "${method}" aborted`));
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new Error(`MCP request "${method}" aborted`));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });

      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }
}

/**
 * Connects to every configured MCP server, lists its tools, and wraps each as a
 * ToolDefinition namespaced `mcp__<server>__<tool>`.
 *
 * MCP tools ship a JSON Schema, not a zod schema. The registry validates input
 * with `inputSchema.safeParse` and separately serializes `inputSchema` to JSON
 * Schema for the provider (via zodToJsonSchema). So we set `inputSchema` to a
 * permissive `z.record(z.string(), z.unknown())` (accepts any object at
 * validation time) AND attach the server's real JSON Schema on the documented
 * extra property `rawInputSchema`. See INTEGRATION-phase3a.md — session
 * toolSchemas() should prefer `rawInputSchema` when present so the model sees
 * the real parameter shape.
 */
export async function createMcpTools(mcpServers: Record<string, unknown>): Promise<AnyToolDefinition[]> {
  const tools: AnyToolDefinition[] = [];
  for (const [serverName, rawConfig] of Object.entries(mcpServers ?? {})) {
    const parsed = mcpServerConfigSchema.safeParse(rawConfig);
    if (!parsed.success) continue; // skip malformed server entries silently
    let client: McpClient;
    try {
      client = await McpClient.connect(serverName, parsed.data);
    } catch {
      continue; // server failed to start / handshake; contribute no tools
    }
    let listed: McpToolInfo[];
    try {
      listed = await client.listTools();
    } catch {
      client.close();
      continue;
    }
    for (const info of listed) {
      tools.push(makeMcpTool(client, serverName, info));
    }
  }
  return tools;
}

function makeMcpTool(client: McpClient, serverName: string, info: McpToolInfo): AnyToolDefinition {
  const inputSchema = z.record(z.string(), z.unknown());
  const def: ToolDefinition<Record<string, unknown>> = {
    name: `mcp__${serverName}__${info.name}`,
    description: info.description || `MCP tool "${info.name}" from server "${serverName}".`,
    permissionClass: "network",
    inputSchema,
    rawInputSchema: info.inputSchema,
    describeInput: () => `${serverName}: ${info.name}`,
    execute: async (input, _ctx, signal): Promise<ToolResult> => {
      try {
        const text = await client.callTool(info.name, input, signal);
        return { content: text };
      } catch (err) {
        if (err instanceof McpToolError) return { content: err.text, isError: true };
        return { content: `MCP tool "${info.name}" failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
  return def;
}
