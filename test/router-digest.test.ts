import { it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { formatRouterBatch } from "../src/router/prompts.js";
import { temporaryApp } from "./helpers/harness.js";

it("formats Thread observations in the Router batch", () => {
  const text = formatRouterBatch({
    openTasks: [],
    observations: [
      {
        threadId: "thread-digest",
        unread: true,
        lastSeq: 3,
        events: [{ seq: 2, kind: "trigger", summary: "hello" }],
      },
    ],
    items: [],
  });
  assert.match(text, /Thread observations since last Router turn/);
  assert.match(text, /thread-digest/);
  assert.match(text, /seq=2 trigger/);
});

it("does not start a Router turn for an executor-only Thread event", async () => {
  const h = temporaryApp();
  const { app } = h;
  try {
    const def = app.store.catalog.getDefinition("coding")!;
    const task = app.store.tasks.insert({
      ownerId: "owner",
      objective: "executor task",
      definition: def,
      originTriggerId: "fixture",
      workspacePath: join(h.dir, "executor"),
      status: "active",
    });
    app.store.tasks.addSubscription(task.id, "thread-direct", "executor");
    app.ingress.accept({
      source: "console",
      externalId: "direct-1",
      threadId: "thread-direct",
      preview: "direct event",
      payload: { text: "direct event" },
    });

    const observation = app.store.threads.getObservation("thread-direct");
    assert.equal(observation?.unread, true);
    assert.equal(await app.routerLoop.tick(), false);
    assert.equal(
      app.store.threads.getObservation("thread-direct")?.unread,
      true,
    );
  } finally {
    await h.close();
  }
});

it("consumes unread observations after a Router turn", async () => {
  const h = temporaryApp();
  const { app } = h;
  try {
    app.ingress.accept({
      source: "console",
      externalId: "router-digest-1",
      threadId: "thread-digest",
      preview: "needs routing",
      payload: { text: "needs routing" },
    });
    assert.equal(
      app.store.threads.getObservation("thread-digest")?.unread,
      true,
    );

    assert.equal(await app.routerLoop.tick(), true);
    const observation = app.store.threads.getObservation("thread-digest");
    assert.equal(observation?.unread, false);
    assert.equal(observation?.consumedSeq, 1);
    assert.equal(app.store.tasks.listOpen().length, 1);
  } finally {
    await h.close();
  }
});
