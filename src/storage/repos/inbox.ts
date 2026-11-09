import type { Db } from "../db.js";
import { row, rows } from "../db.js";
import type { InboxItem, InboxMode, InboxStatus } from "../../types.js";
import { newId, nowIso } from "../../ids.js";

interface InboxRow {
  id: string;
  target: string;
  trigger_id: string;
  steer: number;
  mode: string;
  status: string;
  run_id: string | null;
  created_at: string;
}

function mapInbox(r: InboxRow): InboxItem {
  return {
    id: r.id,
    target: r.target,
    triggerId: r.trigger_id,
    steer: r.steer === 1,
    mode: r.mode as InboxMode,
    status: r.status as InboxStatus,
    runId: r.run_id,
    createdAt: r.created_at,
  };
}

export class InboxRepo {
  constructor(private readonly db: Db) {}

  insert(input: {
    target: string;
    triggerId: string;
    steer?: boolean;
    mode?: InboxMode;
  }): InboxItem {
    const id = newId("inb");
    const createdAt = nowIso();
    const mode = input.mode ?? "execute";
    const status: InboxStatus = mode === "observe" ? "observed" : "pending";
    this.db
      .prepare(
        `INSERT INTO inbox
         (id, target, trigger_id, steer, mode, status, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        input.target,
        input.triggerId,
        input.steer ? 1 : 0,
        mode,
        status,
        createdAt,
      );
    return {
      id,
      target: input.target,
      triggerId: input.triggerId,
      steer: !!input.steer,
      mode,
      status,
      runId: null,
      createdAt,
    };
  }

  insertOrGet(input: {
    target: string;
    triggerId: string;
    steer?: boolean;
    mode?: InboxMode;
  }): { item: InboxItem; created: boolean } {
    const existing = this.findByTargetTrigger(input.target, input.triggerId);
    if (existing) return { item: existing, created: false };
    try {
      return { item: this.insert(input), created: true };
    } catch (err) {
      const again = this.findByTargetTrigger(input.target, input.triggerId);
      if (again) return { item: again, created: false };
      throw err;
    }
  }

  findByTargetTrigger(target: string, triggerId: string): InboxItem | null {
    const r = row<InboxRow>(
      this.db
        .prepare(
          "SELECT * FROM inbox WHERE target = ? AND trigger_id = ?",
        )
        .get(target, triggerId),
    );
    return r ? mapInbox(r) : null;
  }

  listPending(target: string): InboxItem[] {
    return rows<InboxRow>(
      this.db
        .prepare(
          `SELECT * FROM inbox
           WHERE target = ? AND mode = 'execute' AND status = 'pending'
           ORDER BY created_at`,
        )
        .all(target),
    ).map(mapInbox);
  }

  listAccepted(runId: string): InboxItem[] {
    return rows<InboxRow>(
      this.db
        .prepare(
          `SELECT * FROM inbox
           WHERE run_id = ? AND mode = 'execute' AND status = 'accepted'
           ORDER BY created_at, rowid`,
        )
        .all(runId),
    ).map(mapInbox);
  }

  bindToRun(ids: string[], runId: string): void {
    const stmt = this.db.prepare(
      "UPDATE inbox SET run_id = ?, status = 'accepted' WHERE id = ? AND mode = 'execute' AND status = 'pending'",
    );
    for (const id of ids) {
      stmt.run(runId, id);
    }
  }

  markDone(ids: string[]): void {
    const stmt = this.db.prepare(
      "UPDATE inbox SET status = 'done' WHERE id = ? AND status IN ('pending', 'accepted')",
    );
    for (const id of ids) {
      stmt.run(id);
    }
  }

  cancelPending(target: string): number {
    const result = this.db
      .prepare(
        "UPDATE inbox SET status = 'cancelled' WHERE target = ? AND mode = 'execute' AND status = 'pending'",
      )
      .run(target);
    return Number(result.changes);
  }
}
