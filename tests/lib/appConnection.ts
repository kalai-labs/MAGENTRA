/**
 * `app/main/connection.js`, loaded the way the Electron main process loads it.
 *
 * The module is CJS and deliberately imports no Electron — "Pure I/O over
 * fetch — no Electron imports, so tests can drive everything directly", in its
 * own words — so `createRequire` is enough, unchanged and unmocked. Three
 * features test through it; this is the one place that knows how to reach it.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { repoRoot } from "./inventory.ts";

const requireFromHere = createRequire(import.meta.url);

export interface EndpointResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly models?: string[];
  readonly baseUrl?: string;
  readonly note?: string;
  readonly error?: string;
  readonly contextLimit?: number;
}

export interface Validated {
  readonly ok: boolean;
  readonly error?: string;
}

export interface ConnectionModule {
  validateCredentialPayload(payload: unknown): Validated;
  testEndpoint(validated: Validated, defaultBaseUrl: string, opts?: Record<string, unknown>): Promise<EndpointResult>;
  candidateBaseUrls(baseUrl: string): string[];
  readWorkspaceEnvKeys(workspace: string): Record<string, string>;
  writeWorkspaceEnvKeys(workspace: string, entries: unknown[]): string | undefined;
}

export function connectionModule(): ConnectionModule {
  return requireFromHere(join(repoRoot(), "app", "main", "connection.js")) as ConnectionModule;
}

/** A complete openai-compatible connection, validated by the product's own validator. */
export function validatedFor(baseUrl: string, extra: Record<string, unknown> = {}): Validated {
  const validated = connectionModule().validateCredentialPayload({
    apiKey: "sk-a-key-that-is-fine",
    model: "some-model",
    provider: "openai-compat",
    baseUrl,
    insecureTls: false,
    ...extra,
  });
  if (!validated.ok) throw new Error(`the payload this test builds is invalid: ${String(validated.error)}`);
  return validated;
}
