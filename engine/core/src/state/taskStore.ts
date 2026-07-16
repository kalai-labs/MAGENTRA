import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreEvent, TaskItem } from "@magentra/protocol";
import type { TaskPatch, TaskStoreApi } from "../agent/tool.js";
import { writeFileAtomic } from "../util/fsAtomic.js";

/**
 * Session task list, persisted per-session under .magentra/tasks/<sessionId>.json.
 * A brand-new session therefore starts with zero tasks; resuming a session by
 * id reloads that same session's tasks. Every mutation emits task_list_updated
 * so frontends can render live.
 */
export class TaskStore implements TaskStoreApi {
  private tasks = new Map<string, TaskItem>();
  private nextId = 1;
  private readonly file: string;
  /**
   * Fires after a persisted status change (not deletion), with the previous
   * status. The session uses it to record crew experience when an owned task
   * is verified completed; it must never throw into the mutation path.
   */
  onStatusChange?: (task: TaskItem, prevStatus: TaskItem["status"]) => void;

  constructor(
    stateDir: string,
    sessionId: string,
    private readonly emit: (event: CoreEvent) => void,
  ) {
    this.file = join(stateDir, "tasks", `${sessionId}.json`);
    this.load();
  }

  create(fields: {
    subject: string;
    description: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
  }): TaskItem {
    const task: TaskItem = {
      id: String(this.nextId++),
      subject: fields.subject,
      description: fields.description,
      ...(fields.activeForm ? { activeForm: fields.activeForm } : {}),
      ...(fields.metadata ? { metadata: fields.metadata } : {}),
      status: "pending",
      blocks: [],
      blockedBy: [],
    };
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  update(id: string, patch: TaskPatch): TaskItem {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`No task with id ${id}`);
    const prevStatus = task.status;

    if (patch.status === "deleted") {
      this.tasks.delete(id);
      for (const other of this.tasks.values()) {
        other.blocks = other.blocks.filter((t) => t !== id);
        other.blockedBy = other.blockedBy.filter((t) => t !== id);
      }
      this.persist();
      return task;
    }

    if (patch.subject !== undefined) task.subject = patch.subject;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.activeForm !== undefined) task.activeForm = patch.activeForm;
    if (patch.owner !== undefined) task.owner = patch.owner;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.metadata) {
      task.metadata = { ...task.metadata };
      for (const [key, value] of Object.entries(patch.metadata)) {
        if (value === null) delete task.metadata[key];
        else task.metadata[key] = value;
      }
    }
    for (const other of patch.addBlocks ?? []) {
      if (!this.tasks.has(other)) throw new Error(`No task with id ${other}`);
      if (!task.blocks.includes(other)) task.blocks.push(other);
      const target = this.tasks.get(other)!;
      if (!target.blockedBy.includes(id)) target.blockedBy.push(id);
    }
    for (const other of patch.addBlockedBy ?? []) {
      if (!this.tasks.has(other)) throw new Error(`No task with id ${other}`);
      if (!task.blockedBy.includes(other)) task.blockedBy.push(other);
      const target = this.tasks.get(other)!;
      if (!target.blocks.includes(id)) target.blocks.push(id);
    }
    this.persist();
    if (task.status !== prevStatus) {
      try {
        this.onStatusChange?.(task, prevStatus);
      } catch {
        /* observers never break a mutation */
      }
    }
    return task;
  }

  get(id: string): TaskItem | undefined {
    return this.tasks.get(id);
  }

  list(): TaskItem[] {
    return [...this.tasks.values()];
  }

  private persist(): void {
    // Atomic (write-then-rename): a crash mid-write must never leave a
    // truncated file that load() would then mistake for a fresh session.
    writeFileAtomic(this.file, JSON.stringify({ nextId: this.nextId, tasks: this.list() }, null, 2));
    this.emit({ type: "task_list_updated", tasks: this.list() });
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return; // no file — genuinely a fresh session
    }
    try {
      const data = JSON.parse(raw) as { nextId: number; tasks: TaskItem[] };
      this.nextId = data.nextId;
      this.tasks = new Map(data.tasks.map((t) => [t.id, t]));
    } catch {
      // The file exists but is unreadable — losing the task list silently
      // reads as data loss; say so instead of pretending nothing was there.
      this.emit({
        type: "error",
        message: `Task list at ${this.file} is corrupt — starting with an empty list.`,
        fatal: false,
      });
    }
  }
}
