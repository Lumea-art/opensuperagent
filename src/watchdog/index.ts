import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { EventBus } from "../events/bus.js";
import type { DataPaths } from "../paths.js";
import type { SessionManager } from "../session/manager.js";
import type { Store } from "../storage/index.js";
import type { InboxItem } from "../types.js";
import { newId } from "../ids.js";

export const WATCHDOG_OWNER = "watchdog";
export const WATCHDOG_SOURCE = "watchdog";

const WATCHDOG_SYSTEM_PROMPT = `You are the independent Watchdog for OpenSuperAgent.

You receive structured alerts about Tasks that appear stalled. Inspect the
reported Tasks with the read-only tools available to you: list_tasks, read_task,
and read_trigger. Do not start, stop, retry, or message Tasks. Your job in this
phase is diagnosis: state whether the Task is actually stalled, what evidence
supports that, and what a human or Router should do next. Be concise and do not
invent progress that is not present in the records.`;

interface WatchdogEvidence {
  readonly taskId: string;
  readonly status: string;
  readonly objective: string;
  readonly ageMs: number;
  readonly lastProgressAt: string;
}

/** Dedicated, read-only Watchdog loop. Detection lives here; execution uses a separate session. */
export class WatchdogLoop {
  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly paths: DataPaths,
    private readonly events: EventBus,
    private readonly config: AppConfig,
  ) {}

  async tick(): Promise<boolean> {
    this.enqueueStalledTasks();

    if (!this.sessions.isIdle(WATCHDOG_OWNER)) return false;
    if (this.store.inbox.listPending(WATCHDOG_OWNER).length === 0) return false;

    const handle = await this.sessions.open(WATCHDOG_OWNER, {
      systemPrompt: WATCHDOG_SYSTEM_PROMPT,
    });
    const batch = this.sessions.beginRun(WATCHDOG_OWNER, (items) =>
      this.formatBatch(items),
    );
    if (!batch) return false;

    this.store.runs.transition(batch.run.id, "pending", "submitted");
    try {
      await handle.prompt(batch.promptText);
    } catch (error) {
      this.store.runs.transition(batch.run.id, "submitted", "failed");
      throw error;
    } finally {
      if (this.store.runs.get(batch.run.id)?.status === "submitted")
        this.store.runs.transition(batch.run.id, "submitted", "completed");
      this.store.inbox.markDone(batch.items.map((item) => item.id));
    }
    this.events.emit({
      scope: WATCHDOG_OWNER,
      kind: "watchdog_run",
      summary: `Watchdog diagnosis completed for ${batch.items.length} signal(s)`,
      payload: { runId: batch.run.id },
    });
    return true;
  }

  private enqueueStalledTasks(): number {
    const stallMs = this.config.supervisor.stall_after_sec * 1000;
    const now = Date.now();
    let queued = 0;

    for (const task of this.store.tasks.listOpen()) {
      if (task.status !== "waiting") continue;
      if (
        this.store.tasks.hasSubscription(task.id) &&
        !this.store.tasks.isExecutor(task.id)
      )
        continue;
      const lastProgressAt = this.events.latestAt(task.id) ?? task.updatedAt;
      const ageMs = now - Date.parse(lastProgressAt);
      if (!Number.isFinite(ageMs) || ageMs <= stallMs) continue;

      const externalId = `stall:${task.id}:${lastProgressAt}`;
      if (this.store.triggers.findByExternal(WATCHDOG_SOURCE, externalId)) continue;

      const evidence: WatchdogEvidence = {
        taskId: task.id,
        status: task.status,
        objective: task.objective,
        ageMs,
        lastProgressAt,
      };
      const payloadRef = this.writeEvidence(evidence);
      const preview =
        `Task ${task.id} (${task.status}) has made no progress for ` +
        `${Math.round(ageMs / 1000)}s. Objective: ${task.objective}`;

      this.store.transaction(() => {
        const trigger = this.store.triggers.insert({
          source: WATCHDOG_SOURCE,
          externalId,
          threadId: null,
          actorId: WATCHDOG_OWNER,
          payloadRef,
          preview,
          status: "routed",
        });
        this.store.inbox.insertOrGet({
          target: WATCHDOG_OWNER,
          triggerId: trigger.id,
        });
      });
      this.events.emit({
        scope: "system",
        kind: "watchdog",
        summary: preview.slice(0, 240),
        payload: evidence,
      });
      queued += 1;
    }
    return queued;
  }

  private writeEvidence(evidence: WatchdogEvidence): string {
    mkdirSync(this.paths.blobs, { recursive: true });
    const ref = `${newId("blob")}.json`;
    writeFileSync(join(this.paths.blobs, ref), JSON.stringify(evidence, null, 2));
    return ref;
  }

  private formatBatch(items: readonly InboxItem[]): string {
    const lines = [
      "Watchdog alert batch.",
      "Inspect each Task with the read-only tools before diagnosing.",
      "",
    ];
    for (const item of items) {
      const trigger = this.store.triggers.get(item.triggerId);
      if (!trigger) {
        lines.push(`- triggerId=${item.triggerId} (missing trigger)`);
        continue;
      }
      const evidence = this.readEvidence(trigger.payloadRef);
      lines.push(
        `- triggerId=${item.triggerId} taskId=${evidence?.taskId ?? "unknown"} ` +
          `status=${evidence?.status ?? "unknown"} ` +
          `ageSec=${evidence ? Math.round(evidence.ageMs / 1000) : "unknown"} ` +
          `lastProgressAt=${evidence?.lastProgressAt ?? "unknown"}`,
      );
      if (evidence?.objective)
        lines.push(`  objective=${JSON.stringify(evidence.objective)}`);
      else lines.push(`  preview=${JSON.stringify(trigger.preview)}`);
    }
    return lines.join("\n");
  }

  private readEvidence(ref: string): WatchdogEvidence | null {
    try {
      return JSON.parse(
        readFileSync(join(this.paths.blobs, ref), "utf8"),
      ) as WatchdogEvidence;
    } catch {
      return null;
    }
  }
}
