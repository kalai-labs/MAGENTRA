import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CoreEvent } from "@magentra/protocol";
import type { BackgroundApi, BackgroundTaskInfo } from "../agent/tool.js";

interface Handle {
  info: BackgroundTaskInfo;
  stop(): void;
}

/**
 * Tracks background work (bash jobs, monitors, background agents). Output
 * streams to .magentra/tasks/<id>.output; completion queues a
 * <task-notification> system-reminder for the next model turn and emits a
 * background_notification event immediately.
 */
export class BackgroundManager implements BackgroundApi {
  private readonly handles = new Map<string, Handle>();
  private readonly dir: string;

  constructor(
    stateDir: string,
    private readonly emit: (event: CoreEvent) => void,
    private readonly remind: (text: string) => void,
  ) {
    this.dir = join(stateDir, "tasks");
    mkdirSync(this.dir, { recursive: true });
  }

  launch(opts: {
    kind: BackgroundTaskInfo["kind"];
    description: string;
    start: (outputFile: string, onExit: (code: number | null) => void) => { stop(): void };
  }): BackgroundTaskInfo {
    const id = `${opts.kind}_${randomBytes(4).toString("hex")}`;
    const outputFile = join(this.dir, `${id}.output`);
    const info: BackgroundTaskInfo = {
      id,
      kind: opts.kind,
      description: opts.description,
      outputFile,
      status: "running",
    };
    const child = opts.start(outputFile, (code) => {
      if (info.status === "running") {
        info.status = code === 0 ? "completed" : "failed";
        info.exitCode = code ?? -1;
        this.emit({
          type: "background_notification",
          taskId: id,
          kind: "exit",
          payload: { code, description: opts.description, outputFile },
        });
        this.remind(
          `<task-notification>Background ${opts.kind} task ${id} ("${opts.description}") finished with exit code ${code}. Output file: ${outputFile}</task-notification>`,
        );
      }
    });
    this.handles.set(id, { info, stop: child.stop });
    return info;
  }

  get(id: string): BackgroundTaskInfo | undefined {
    return this.handles.get(id)?.info;
  }

  list(): BackgroundTaskInfo[] {
    return [...this.handles.values()].map((h) => h.info);
  }

  stop(id: string): boolean {
    const handle = this.handles.get(id);
    if (!handle || handle.info.status !== "running") return false;
    handle.info.status = "stopped";
    handle.stop();
    return true;
  }

  stopAll(): void {
    for (const handle of this.handles.values()) {
      if (handle.info.status === "running") {
        handle.info.status = "stopped";
        handle.stop();
      }
    }
  }
}
