import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/index.js";
import { temporaryApp } from "./helpers/harness.js";

it("projects triggers into a durable Thread event sequence", async () => {
  const h = temporaryApp();
  const { app } = h;
  try {
    const first = app.ingress.accept({
      source: "console",
      externalId: "thread-event-1",
      threadId: "thread-events",
      actorId: "owner",
      preview: "first message",
      payload: { text: "first message" },
    });
    const second = app.ingress.accept({
      source: "console",
      externalId: "thread-event-2",
      threadId: "thread-events",
      actorId: "owner",
      preview: "second message",
      payload: { text: "second message" },
    });

    const thread = app.store.threads.get("thread-events");
    assert.ok(thread);
    assert.equal(thread.source, "console");
    assert.equal(thread.externalKey, "thread-events");
    assert.equal(thread.status, "active");
    assert.equal(thread.ownerTaskId, null);
    assert.equal(thread.lastSeq, 2);

    const events = app.store.threads.listEvents("thread-events");
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2],
    );
    assert.equal(events[0]!.triggerId, first.trigger.id);
    assert.equal(events[1]!.triggerId, second.trigger.id);
    assert.equal(events[0]!.summary, "first message");
    assert.equal(events[0]!.payloadRef, first.trigger.payloadRef);
    assert.equal(events[0]!.kind, "trigger");

    const afterFirst = app.store.threads.listEvents("thread-events", 1);
    assert.deepEqual(
      afterFirst.map((event) => event.seq),
      [2],
    );

    const duplicate = app.ingress.accept({
      source: "console",
      externalId: "thread-event-2",
      threadId: "thread-events",
      actorId: "owner",
      preview: "second message",
      payload: { text: "second message" },
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(app.store.threads.get("thread-events")!.lastSeq, 2);

    app.ingress.accept({
      source: "console",
      externalId: "no-thread-1",
      preview: "threadless",
      payload: { text: "threadless" },
    });
    assert.equal(app.store.threads.get("thread-events")!.lastSeq, 2);
  } finally {
    await h.close();
  }
});

it("backfills Threads and event sequences for legacy data", () => {
  const dir = mkdtempSync(join(tmpdir(), "osa-thread-backfill-"));
  const path = join(dir, "state.sqlite");
  try {
    let store = Store.open(path);
    store.triggers.insert({
      source: "console",
      externalId: "legacy-1",
      threadId: "legacy-thread",
      payloadRef: "legacy.json",
      preview: "legacy message",
      status: "routed",
    });
    store.db.exec("DELETE FROM thread_events");
    store.db.exec("DELETE FROM threads");
    store.db.exec("DELETE FROM schema_migrations WHERE version = 5");
    store.close();

    store = Store.open(path);
    const thread = store.threads.get("legacy-thread");
    assert.ok(thread);
    assert.equal(thread.lastSeq, 1);
    assert.deepEqual(
      store.threads.listEvents("legacy-thread").map((event) => event.seq),
      [1],
    );
    assert.equal(
      store.threads.listEvents("legacy-thread")[0]!.summary,
      "legacy message",
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
