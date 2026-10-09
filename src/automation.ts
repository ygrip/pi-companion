import { adminHttpUrl } from "./daemon.ts";

export type AutomationAction =
  | { type: "command"; command: string; args: string[]; cwd?: string; timeoutSeconds?: number }
  | { type: "pi"; prompt: string; cwd: string; timeoutSeconds?: number };
export type AutomationDefinition = {
  name: string;
  enabled: boolean;
  schedule: string | null;
  preconditions: AutomationAction[];
  actions: AutomationAction[];
  postActions: AutomationAction[];
  historyLimit?: number;
  maxRetries?: number;
  retryIntervalSeconds?: number;
};
export type AutomationParams = {
  action: "list" | "get" | "create" | "update" | "delete" | "enable" | "disable" | "start" | "stop" | "runs" | "run";
  id?: string;
  runId?: string;
  automation?: AutomationDefinition;
};

const actionSchema = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["type", "command", "args"], properties: {
      type: { const: "command" }, command: { type: "string", minLength: 1 },
      args: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 }
    } },
    { type: "object", additionalProperties: false, required: ["type", "prompt", "cwd"], properties: {
      type: { const: "pi" }, prompt: { type: "string", minLength: 1 }, cwd: { type: "string", minLength: 1 },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 }
    } }
  ]
};

export const automationTool = {
  name: "companion_automation",
  description: "Manage Pi Companion automations: list, get, create, update, delete, enable, disable, start, stop, runs, or run detail. Definitions use preconditions, actions, postActions and optional five-field UTC cron schedule. Commands execute argv without a shell. Mutations require the user's authorization; running actions has the computer user's permissions. Does not start the daemon or enable session sharing.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["action"],
    properties: {
      action: { type: "string", enum: ["list", "get", "create", "update", "delete", "enable", "disable", "start", "stop", "runs", "run"] },
      id: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 },
      automation: {
        type: "object", additionalProperties: false,
        required: ["name", "enabled", "schedule", "preconditions", "actions", "postActions"],
        properties: {
          name: { type: "string", minLength: 1 }, enabled: { type: "boolean" },
          schedule: { type: ["string", "null"], description: "Five-field UTC cron; null for manual only." },
          preconditions: { type: "array", items: actionSchema },
          actions: { type: "array", minItems: 1, items: actionSchema },
          postActions: { type: "array", items: actionSchema },
          historyLimit: { type: "integer", minimum: 1, maximum: 1000, description: "Retain latest N finished runs; default 30." },
          maxRetries: { type: "integer", minimum: 0, maximum: 5, description: "Optional retries of the failed main action only; default 0. May repeat side effects." },
          retryIntervalSeconds: { type: "integer", minimum: 1, maximum: 86400, description: "Optional delay between retries; default 10 seconds; total retry delay must fit before the next scheduled trigger." }
        }
      }
    }
  }
};

/** Explicit tool calls only: never probe, download, or launch a daemon here. */
export async function executeAutomation(params: AutomationParams, signal?: AbortSignal) {
  const actions = ['list', 'get', 'create', 'update', 'delete', 'enable', 'disable', 'start', 'stop', 'runs', 'run'];
  if (!params || typeof params !== 'object' || !actions.includes(params.action)) throw new Error("Unknown automation action.");
  if (params.id !== undefined && (typeof params.id !== 'string' || !params.id.trim())) throw new Error("id must be a nonempty string.");
  if (params.runId !== undefined && (typeof params.runId !== 'string' || !params.runId.trim())) throw new Error("runId must be a nonempty string.");
  const base = adminHttpUrl();
  const target = new URL(base);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol)) {
    throw new Error("Automation management requires the local Companion admin address.");
  }
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Companion ${response.status}: ${await response.text()}`);
    return response.status === 204 ? { ok: true } : await response.json();
  };
  if (params.action === "list") return request("/api/automations");
  if (params.action === "create") {
    if (!params.automation) throw new Error("create requires automation.");
    return request("/api/automations", "POST", params.automation);
  }
  if (!params.id) throw new Error(`${params.action} requires id.`);
  const path = "/api/automations/" + encodeURIComponent(params.id);
  switch (params.action) {
    case "get": return request(path);
    case "update":
      if (!params.automation) throw new Error("update requires a complete automation definition.");
      return request(path, "PUT", params.automation);
    case "delete": return request(path, "DELETE");
    case "enable": case "disable": {
      const current = await request(path) as AutomationDefinition;
      // PUT only definition fields, never server-generated metadata.
      const { name, schedule, preconditions, actions, postActions, maxRetries, retryIntervalSeconds, historyLimit } = current;
      return request(path, "PUT", { name, schedule, preconditions, actions, postActions, maxRetries, retryIntervalSeconds, historyLimit, enabled: params.action === "enable" });
    }
    case "start": case "stop": return request(path + "/" + params.action, "POST");
    case "runs": return request(path + "/runs");
    case "run":
      if (!params.runId) throw new Error("run requires runId.");
      return request(path + "/runs/" + encodeURIComponent(params.runId));
    default: throw new Error("Unknown automation action.");
  }
}
