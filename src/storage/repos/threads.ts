import type { Db } from "../db.js";
import { row, rows, withTransaction } from "../db.js";
import type { Thread, ThreadEvent, ThreadStatus } from "../../types.js";
import { newId, nowIso } from "../../ids.js";

interface ThreadRow {
  id: string;
  source: string;
  external_key: string;
  status: string;
  owner_task_id: string | null;
  last_seq: number;
  created_at: string;
  updated_at: string;
}

interface ThreadEventRow {
  id: string;
  thread_id: string;
  seq: number;
  trigger_id: string | null;
  kind: string;
  summary: string;
  payload_ref: string | null;
  created_at: string;
}

function mapThread(r: ThreadRow): Thread {
  return {
    id: r.id,
    source: r.source,
    externalKey: r.external_key,
    status: r.status as ThreadStatus,
    ownerTaskId: r.owner_task_id,
    lastSeq: Number(r.last_seq),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapThreadEvent(r: ThreadEventRow): ThreadEvent {
  return {
    id: r.id,
    threadId: r.thread_id,
    seq: Number(r.seq),
    triggerId: r.trigger_id,
    kind: r.kind,
    summary: r.summary,
    payloadRef: r.payload_ref,
    createdAt: r.created_at,
  };
}

export class ThreadRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Thread | null {
    const r = row<ThreadRow>(
      this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id),
    );
    return r ? mapThread(r) : null;
  }

  /** Create the Thread projection if absent and touch its activity time. */
  ensure(input: {
    id: string;
    source: string;
    externalKey?: string | null;
  }): Thread {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO threads
         (id, source, external_key, status, owner_task_id, last_seq, created_at, updated_at)
         VALUES (?, ?, ?, 'active', NULL, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.source,
        input.externalKey ?? input.id,
        now,
        now,
      );
    return this.get(input.id)!;
  }

  /** Append one ordered Thread event. */
  appendEvent(input: {
    threadId: string;
    triggerId?: string | null;
    kind: string;
    summary: string;
    payloadRef?: string | null;
  }): ThreadEvent {
    return withTransaction(this.db, () => {
      const thread = this.get(input.threadId);
      if (!thread) throw new Error(`Unknown Thread ${input.threadId}`);
      const seq = thread.lastSeq + 1;
      const now = nowIso();
      const updated = this.db
        .prepare(
          "UPDATE threads SET last_seq = ?, updated_at = ? WHERE id = ? AND last_seq = ?",
        )
        .run(seq, now, thread.id, thread.lastSeq);
      if (Number(updated.changes) !== 1)
        throw new Error(`Thread ${thread.id} sequence conflict`);

      const event: ThreadEvent = {
        id: newId("tev"),
        threadId: thread.id,
        seq,
        triggerId: input.triggerId ?? null,
        kind: input.kind,
        summary: input.summary,
        payloadRef: input.payloadRef ?? null,
        createdAt: now,
      };
      this.db
        .prepare(
          `INSERT INTO thread_events
           (id, thread_id, seq, trigger_id, kind, summary, payload_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.threadId,
          event.seq,
          event.triggerId,
          event.kind,
          event.summary,
          event.payloadRef,
          event.createdAt,
        );
      return event;
    });
  }

  listEvents(threadId: string, afterSeq = 0, limit = 100): ThreadEvent[] {
    return rows<ThreadEventRow>(
      this.db
        .prepare(
          `SELECT * FROM thread_events
           WHERE thread_id = ? AND seq > ?
           ORDER BY seq
           LIMIT ?`,
        )
        .all(threadId, afterSeq, Math.max(1, Math.min(limit, 500))),
    ).map(mapThreadEvent);
  }
}
