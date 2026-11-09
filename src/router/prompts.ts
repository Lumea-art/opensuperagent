import type { AppConfig } from "../config.js";
import type { Task, WorkerDefinitionSpec } from "../types.js";

export const ROUTER_SYSTEM_PROMPT = `You are the OpenSuperAgent Router.

You receive new user requests and messages that could not be routed deterministically.
You do NOT execute commands or edit files.

Available tools:
- list_tasks / read_task / read_trigger — inspect state
- start_task({ triggerIds, definition, objective }) — create a Task with a Worker definition snapshot
- send_to_task({ taskId, triggerIds, steer? }) — forward inputs to an existing open Task
- stop_task({ taskId }) — cancel a Task
- reply({ triggerId, content }) — reply to the conversation of an input

Every input in this turn must be handled (dispatched or replied). Choose the most specific active Worker definition matching the goal: frontend for UI, backend for services, qa for verification, review for change reviews, docs for documentation, data for datasets, and ops for runtime diagnosis. Use research for evidence gathering, triage for essential clarification, and coding as the general implementation fallback. Preserve explicit user selection of an available Worker.
`;

export function buildRouterSystemPrompt(
  config: AppConfig,
  definitions: WorkerDefinitionSpec[],
): string {
  const defs = definitions.map((d) => `- ${d.id}: ${d.description}`).join("\n");
  const org = config.router.instructions?.trim()
    ? `\n\nOrganization rules:\n${config.router.instructions.trim()}`
    : "";
  return `${ROUTER_SYSTEM_PROMPT}\n\nActive Worker definitions:\n${defs || "(none)"}${org}`;
}

export function formatRouterBatch(input: {
  openTasks: Task[];
  observations?: {
    threadId: string;
    unread: boolean;
    lastSeq: number;
    events: { seq: number; kind: string; summary: string }[];
  }[];
  items: {
    triggerId: string;
    source: string;
    actorId: string | null;
    threadId?: string | null;
    preview: string;
  }[];
}): string {
  const tasks =
    input.openTasks.length === 0
      ? "(no open tasks)"
      : input.openTasks
          .map(
            (t) =>
              `- ${t.id} [${t.status}] def=${t.definition.id} objective=${JSON.stringify(t.objective)}`,
          )
          .join("\n");

  const msgs = input.items
    .map(
      (i) =>
        `- trigger=${i.triggerId} source=${i.source} thread=${i.threadId ?? "-"} actor=${i.actorId ?? "-"} preview=${JSON.stringify(i.preview)}`,
    )
    .join("\n");

  const observations =
    !input.observations || input.observations.length === 0
      ? "(none)"
      : input.observations
          .map((observation) => {
            const events = observation.events
              .map(
                (event) =>
                  `  - seq=${event.seq} ${event.kind}: ` +
                  JSON.stringify(event.summary),
              )
              .join("\n");
            return (
              `- thread=${observation.threadId} ` +
              `last_seq=${observation.lastSeq} unread=${observation.unread}\n` +
              events
            );
          })
          .join("\n");

  return (
    `## Thread observations since last Router turn\n${observations}\n\n` +
    `## Open tasks\n${tasks}\n\n## New inputs\n${msgs}`
  );
}
