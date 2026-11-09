import type { Store } from "../storage/index.js";

export type RouteDecision =
  | { kind: "control"; action: "stop"; taskId: string }
  | { kind: "task"; taskId: string; observerTaskIds?: string[] }
  | { kind: "tasks"; taskIds: string[]; observerTaskIds?: string[] }
  | { kind: "router"; observerTaskIds?: string[] }
  | { kind: "ignore"; reason: string };

/**
 * Deterministic routing — no model calls. Priority order:
 * 1. control commands
 * 2. explicit task id (if open; else router)
 * 3. open subscriptions on thread (one or many)
 * 4. otherwise router
 */
export function decideRoute(
  store: Store,
  input: {
    taskId?: string | null;
    threadId?: string | null;
    control?: { kind: "stop"; taskId: string } | null;
  },
): Exclude<RouteDecision, { kind: "ignore" }> {
  if (input.control?.kind === "stop") {
    return { kind: "control", action: "stop", taskId: input.control.taskId };
  }

  if (input.taskId) {
    const task = store.tasks.get(input.taskId);
    if (!task) return { kind: "router" };
    if (store.tasks.isTerminal(task.status)) return { kind: "router" };
    return { kind: "task", taskId: task.id };
  }

  if (input.threadId) {
    const subscribed = store.tasks.findOpenByThread(input.threadId);
    const observers = store.tasks.findOpenObserversByThread(input.threadId);
    const observerTaskIds = observers.map((task) => task.id);
    const withObservers = observerTaskIds.length > 0 ? { observerTaskIds } : {};
    if (subscribed.length === 1) {
      return {
        kind: "task",
        taskId: subscribed[0]!.id,
        ...withObservers,
      };
    }
    if (subscribed.length > 1) {
      return {
        kind: "tasks",
        taskIds: subscribed.map((task) => task.id),
        ...withObservers,
      };
    }
    return { kind: "router", ...withObservers };
  }

  return { kind: "router" };
}
