import type { ChatTool } from "./types.js";
import type { RouterTools } from "../router/tools.js";
import type { Store } from "../storage/index.js";

export const ROUTER_CHAT_TOOLS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List open tasks (pending/active/waiting).",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_task",
      description: "Read one task by id.",
      parameters: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_trigger",
      description: "Read one inbound trigger by id.",
      parameters: {
        type: "object",
        properties: { triggerId: { type: "string" } },
        required: ["triggerId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_task",
      description:
        "Create a Task with a worker definition snapshot and assign triggerIds as first inputs. Same trigger can only be assigned once.",
      parameters: {
        type: "object",
        properties: {
          triggerIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
          definition: {
            type: "string",
            description: "Worker definition id, e.g. coding",
          },
          objective: { type: "string" },
        },
        required: ["triggerIds", "definition", "objective"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_to_task",
      description: "Forward triggerIds to an existing open Task.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          triggerIds: { type: "array", items: { type: "string" }, minItems: 1 },
          steer: { type: "boolean" },
        },
        required: ["taskId", "triggerIds"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_task",
      description: "Cancel a task.",
      parameters: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply",
      description:
        "Send one reply to a current input trigger without starting a task. Repeated calls for that trigger reuse its delivery.",
      parameters: {
        type: "object",
        properties: {
          triggerId: { type: "string" },
          content: { type: "string" },
        },
        required: ["triggerId", "content"],
        additionalProperties: false,
      },
    },
  },
];

const WATCHDOG_TOOL_NAMES = new Set(["list_tasks", "read_task", "read_trigger"]);

export const WATCHDOG_CHAT_TOOLS: ChatTool[] = ROUTER_CHAT_TOOLS.filter((tool) =>
  WATCHDOG_TOOL_NAMES.has(tool.function.name),
);

export async function executeRouterTool(input: {
  tools: RouterTools;
  store: Store;
  sessionId: string;
  runId: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}): Promise<unknown> {
  const { tools, name, args } = input;
  switch (name) {
    case "list_tasks":
      return tools.listTasks().map((t) => ({
        id: t.id,
        status: t.status,
        objective: t.objective,
        definition: t.definition.id,
      }));
    case "read_task":
      return tools.readTask(String(args.taskId));
    case "read_trigger":
      return tools.readTrigger(String(args.triggerId));
    case "start_task":
      return tools.startTask({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        runId: input.runId,
        triggerIds: args.triggerIds as string[],
        definition: String(args.definition),
        objective: String(args.objective),
      });
    case "send_to_task":
      return tools.sendToTask({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        runId: input.runId,
        taskId: String(args.taskId),
        triggerIds: args.triggerIds as string[],
        steer: !!args.steer,
      });
    case "stop_task":
      return tools.stopTask({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        runId: input.runId,
        taskId: String(args.taskId),
      });
    case "reply":
      if (
        !input.store.db
          .prepare(
            "SELECT 1 FROM inbox WHERE target = 'router' AND trigger_id = ? AND run_id = ?",
          )
          .get(String(args.triggerId), input.runId)
      )
        return {
          error:
            "Only reply to a trigger in the current Router Run; prior context is already processed",
        };
      return tools.reply({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        runId: input.runId,
        triggerId: String(args.triggerId),
        content: String(args.content),
      });
    default:
      return { error: `unknown tool ${name}` };
  }
}
