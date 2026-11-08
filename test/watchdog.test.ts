import { it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { temporaryApp } from "./helpers/harness.js";
import { WATCHDOG_CHAT_TOOLS } from "../src/llm/tools-router.js";

it("exposes only read-only tools to the Watchdog", () => {
  assert.deepEqual(
    WATCHDOG_CHAT_TOOLS.map((tool) => tool.function.name),
    ["list_tasks", "read_task", "read_trigger"],
  );
});

it("escalates a stalled waiting Task to a read-only Watchdog run", async () => {
  const h = temporaryApp();
  const { app } = h;
  app.config.supervisor.stall_after_sec = 60;
  try {
    const def = app.store.catalog.getDefinition("coding")!;
    const task = app.store.tasks.insert({
      ownerId: "owner",
      objective: "stalled task",
      definition: def,
      originTriggerId: "fixture",
      workspacePath: join(h.dir, "stalled"),
      status: "waiting",
    });
    const old = new Date(Date.now() - 120_000).toISOString();
    app.store.db
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(old, task.id);

    const first = await app.watchdogLoop.tick();
    assert.equal(first, true);

    const externalId = `stall:${task.id}:${old}`;
    const trigger = app.store.triggers.findByExternal("watchdog", externalId);
    assert.ok(trigger);
    assert.equal(app.store.inbox.listPending("watchdog").length, 0);
    assert.ok(
      app.events.list("system").some((event) => event.kind === "watchdog"),
    );
    assert.ok(
      app.events.list("watchdog").some((event) => event.kind === "assistant"),
    );

    assert.ok(
      app.events
        .list("watchdog")
        .some((event) => event.summary.includes(task.id)),
    );

    const progressed = app.store.tasks.insert({
      ownerId: "owner",
      objective: "recent progress",
      definition: def,
      originTriggerId: "fixture",
      workspacePath: join(h.dir, "progressed"),
      status: "waiting",
    });
    app.store.db
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(old, progressed.id);
    app.events.emit({
      scope: progressed.id,
      kind: "progress",
      summary: "task is still active",
    });

    const terminal = app.store.tasks.insert({
      ownerId: "owner",
      objective: "terminal",
      definition: def,
      originTriggerId: "fixture",
      workspacePath: join(h.dir, "terminal"),
      status: "completed",
    });
    app.store.db
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(old, terminal.id);

    const second = await app.watchdogLoop.tick();
    assert.equal(second, false);
    const count = app.store.db
      .prepare("SELECT COUNT(*) AS c FROM triggers WHERE source = 'watchdog'")
      .get() as { c: number };
    assert.equal(count.c, 1);
  } finally {
    await h.close();
  }
});
