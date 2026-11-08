import type { Db } from "../storage/db.js";
import { rows } from "../storage/db.js";
import { newId, nowIso } from "../ids.js";

export interface JournalEvent {
  id: string;
  scope: string; // 'router' | task_id | 'system'
  kind: string;
  summary: string;
  payload: unknown;
  createdAt: string;
}

type Listener = (event: JournalEvent) => void;

/** In-process event bus + durable journal for Console timeline / SSE. */
export class EventBus {
  private listeners = new Set<Listener>();

  constructor(private readonly db: Db) {}

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(input: {
    scope: string;
    kind: string;
    summary: string;
    payload?: unknown;
  }): JournalEvent {
    const event: JournalEvent = {
      id: newId("evt"),
      scope: input.scope,
      kind: input.kind,
      summary: input.summary,
      payload: input.payload ?? null,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO journal (id, scope, kind, summary, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.scope,
        event.kind,
        event.summary,
        JSON.stringify(event.payload),
        event.createdAt,
      );
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error("[events]", err);
      }
    }
    return event;
  }

  latestAt(scope: string): string | null {
    const row = this.db
      .prepare("SELECT MAX(created_at) AS at FROM journal WHERE scope = ?")
      .get(scope) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  list(scope?: string, limit = 200): JournalEvent[] {
    if (scope) {
      return rows<{
        id: string;
        scope: string;
        kind: string;
        summary: string;
        payload: string;
        created_at: string;
      }>(
        this.db
          .prepare(
            `SELECT * FROM journal WHERE scope = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(scope, limit),
      ).map(mapJournal);
    }
    return rows<{
      id: string;
      scope: string;
      kind: string;
      summary: string;
      payload: string;
      created_at: string;
    }>(
      this.db
        .prepare(`SELECT * FROM journal ORDER BY created_at DESC LIMIT ?`)
        .all(limit),
    ).map(mapJournal);
  }
}

function mapJournal(r: {
  id: string;
  scope: string;
  kind: string;
  summary: string;
  payload: string;
  created_at: string;
}): JournalEvent {
  return {
    id: r.id,
    scope: r.scope,
    kind: r.kind,
    summary: r.summary,
    payload: JSON.parse(r.payload) as unknown,
    createdAt: r.created_at,
  };
}
