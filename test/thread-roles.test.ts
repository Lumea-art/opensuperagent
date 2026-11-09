import { it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { temporaryApp } from "./helpers/harness.js";

it("delivers a Thread event to observers without an executable inbox", async () => {
  const h = temporaryApp();
  const { app } = h;
  app.settings.saveAdapter("webhook", {
    enabled: true,
    secret: "observer-secret",
    callbackUrl: "http://127.0.0.1/callback",
    outboundSecret: "observer-outbound-secret",
  });
  try {
    const def = app.store.catalog.getDefinition("coding")!;
    const makeTask = (name: string) =>
      app.store.tasks.insert({
        ownerId: "owner",
        objective: name,
        definition: def,
        originTriggerId: "fixture",
        workspacePath: join(h.dir, name),
        status: "active",
      });
    const executor = makeTask("executor");
    const observer = makeTask("observer");
    app.store.tasks.addSubscription(executor.id, "thread-observer", "executor");
    app.store.tasks.addSubscription(observer.id, "thread-observer", "observer");

    const result = app.submitExternal({
      source: "webhook",
      externalId: "observer-event-1",
      threadId: "thread-observer",
      actorId: "owner",
      preview: "shared update",
      payload: { text: "shared update" },
    });

    assert.equal(result.decision?.kind, "task");
    if (result.decision?.kind !== "task") throw new Error("expected task");
    assert.equal(result.decision.taskId, executor.id);
    assert.deepEqual(result.decision.observerTaskIds, [observer.id]);
    assert.equal(result.inboxItemIds.length, 2);

    assert.equal(app.store.tasks.isExecutor(executor.id), true);
    assert.equal(app.store.tasks.isExecutor(observer.id), false);
    assert.equal(await app.workerLoop.tick(observer.id), false);
    assert.equal(app.store.inbox.listPending(executor.id).length, 1);
    assert.equal(app.store.inbox.listPending(observer.id).length, 0);
    const observed = app.store.inbox.findByTargetTrigger(
      observer.id,
      result.trigger.id,
    );
    assert.ok(observed);
    assert.equal(observed.mode, "observe");
    assert.equal(observed.status, "observed");
    assert.ok(
      app.events.list(observer.id).some((event) => event.kind === "ingress"),
    );
    assert.equal(
      app.store.threads.get("thread-observer")?.ownerTaskId,
      executor.id,
    );

    const cursors = app.store.db
      .prepare(
        "SELECT task_id, role, cursor_seq FROM subscriptions WHERE thread_id = ? ORDER BY role, task_id",
      )
      .all("thread-observer") as {
      task_id: string;
      role: string;
      cursor_seq: number;
    }[];
    assert.deepEqual(
      cursors.map((row) => [row.task_id, row.role, row.cursor_seq]),
      [
        [executor.id, "executor", 1],
        [observer.id, "observer", 1],
      ],
    );
  } finally {
    await h.close();
  }
});
