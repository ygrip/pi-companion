import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAnswers, toQuestions } from "./ask.js";
import { CompanionBridge } from "./bridge.js";
import { adminHttpUrl, ensureDaemon } from "./daemon.js";
import { automationTool, executeAutomation, type AutomationParams } from "./automation.ts";

const AskOptionParam = Type.Union([
  Type.String(),
  Type.Object({
    label: Type.String({ description: "Short choice label (1-5 words)" }),
    description: Type.Optional(Type.String({ description: "What choosing this means" }))
  })
]);

const AskQuestionParam = Type.Object({
  question: Type.String({ description: "The full question" }),
  header: Type.Optional(Type.String({ description: "Very short topic label shown as a chip, e.g. \"Database\"" })),
  options: Type.Optional(Type.Array(AskOptionParam, { description: "2-6 choices. Omit for a free-text answer." })),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow choosing several options" })),
  allowCustom: Type.Optional(Type.Boolean({ description: "Offer an 'Other' free-text answer (default true)" }))
});

const AskParams = Type.Object({
  question: Type.Optional(Type.String({ description: "Single question (shorthand for one entry in questions)" })),
  options: Type.Optional(Type.Array(Type.String(), { description: "Choices for the single question" })),
  questions: Type.Optional(Type.Array(AskQuestionParam, { minItems: 1, maxItems: 4, description: "1-4 related questions answered together" }))
});

const ASK_TIMEOUT_MS = 10 * 60_000;

const DeleteTempFileParams = Type.Object({
  fileId: Type.String({ description: "Opaque Pi Companion temporary file id" })
});

function summarize(value: unknown, max = 400) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * Bounded copy of tool arguments for the transcript: long strings cut, long arrays and deep
 * nesting elided, so a huge `write` payload never floods the companion socket.
 */
function compactInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 2000 ? value.slice(0, 2000) + "…" : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map(item => compactInput(item, depth + 1));
    return value.length > 20 ? [...items, "… " + (value.length - 20) + " more"] : items;
  }
  const entries = Object.entries(value).slice(0, 30);
  return Object.fromEntries(entries.map(([key, item]) => [key, compactInput(item, depth + 1)]));
}

function toolInput(args: unknown) {
  const input = compactInput(args);
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

function resultText(result: unknown) {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (Array.isArray(content)) {
    return content.filter(part => part?.type === "text" && part.text).map(part => part.text).join("\n");
  }
  return summarize(result);
}

export default function companionExtension(pi: ExtensionAPI) {
  let bridge = new CompanionBridge(pi);
  let sharingGeneration = 0;

  // Any extension can publish the neutral contract. No dependency on a particular footer/provider.
  for (const channel of ["companion:telemetry", "usage:update", "session:usage", "provider:usage"]) {
    pi.events?.on(channel, value => bridge.ingestTelemetry(value, channel));
  }

  pi.on("session_start", (_event, ctx) => {
    // Switching or starting a Pi session must not inherit the previous opt-in.
    sharingGeneration += 1;
    bridge.close();
    bridge = new CompanionBridge(pi);
    bridge.setContext(ctx);
    bridge.emit("session.start", { cwd: ctx.cwd });
  });
  pi.on("session_info_changed", (event, ctx) => {
    bridge.setContext(ctx);
    bridge.setName(event.name);
  });
  pi.on("model_select", (_event, ctx) => {
    bridge.invalidateContext();
    bridge.setContext(ctx);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    bridge.setContext(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    bridge.setContext(ctx);
    bridge.updateStatus("active");
    bridge.emit("agent.start", {});
  });
  pi.on("agent_end", (event, ctx) => {
    bridge.setContext(ctx);
    bridge.updateStatus("idle");
    bridge.emit("agent.end", { messages: Array.isArray((event as { messages?: unknown[] }).messages) ? (event as { messages: unknown[] }).messages.length : 0 });
  });
  pi.on("message_end", (_event, ctx) => bridge.setContext(ctx));
  pi.on("session_compact", (_event, ctx) => {
    bridge.invalidateContext();
    bridge.setContext(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    bridge.invalidateContext();
    bridge.setContext(ctx);
  });
  // Forward compact deltas instead of the full partial message on every token.
  pi.on("message_update", event => {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") bridge.emit("assistant.delta", { kind: "text", delta: update.delta });
    else if (update.type === "thinking_delta") bridge.emit("assistant.delta", { kind: "thinking", delta: update.delta });
  });
  pi.on("tool_execution_start", (event, ctx) => {
    bridge.setContext(ctx);
    // Publish a relayed question before anything else so the companion shows it immediately.
    bridge.toolDialogs.start(event.toolName, event.toolCallId, event.args);
    bridge.emit("tool.start", { toolCallId: event.toolCallId, toolName: event.toolName, args: summarize(event.args), input: toolInput(event.args) });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    bridge.setContext(ctx);
    bridge.toolDialogs.end(event.toolCallId);
    bridge.emit("tool.end", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      result: summarize(resultText(event.result), 1200)
    });
  });
  pi.on("session_shutdown", event => {
    sharingGeneration += 1;
    bridge.updateStatus("stopped");
    bridge.emit("session.shutdown", event);
    bridge.close();
  });

  pi.registerTool({
    name: automationTool.name,
    label: "Companion automation",
    description: automationTool.description,
    parameters: Type.Unsafe<AutomationParams>(automationTool.inputSchema),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      try {
        const result = await executeAutomation(params, signal);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { result, error: null as string | null } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }], details: { result: null, error: String(error) } };
      }
    }
  });

  pi.registerTool({
    name: "companion_ask_user",
    label: "Ask via Companion",
    description:
      "Ask the user one to four questions through the Pi Companion web/phone UI. Each question can offer options (single or multi-select) and an optional free-text answer.",
    parameters: AskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Daemon-owned RPC runs relay supported extension UI dialogs, not a second bridge.
      // Normal sessions still require explicit /companion activation.
      if (ctx?.mode === "rpc" && process.env.PI_COMPANION_AUTOMATION_RUN_ID) {
        const items = params.questions?.length ? params.questions : params.question ? [{ question: params.question, options: params.options }] : [];
        if (!items.length) return { content: [{ type: "text", text: "Provide `question` or `questions`." }], details: { questions: [], answers: null } };
        const questions = toQuestions(items);
        const answers: Record<string, string[]> = {};
        for (const question of questions) {
          if (signal?.aborted) break;
          const choices = question.options.map(option => option.label);
          const title = question.question + (question.options.some(option => option.description) ? "\n" + question.options.map(option => option.label + (option.description ? ": " + option.description : "")).join("\n") : "");
          if (choices.length && !question.multiSelect) {
            const custom = "Other (enter a response)";
            const selected = await ctx.ui.select(title, question.allowCustom ? [...choices, custom] : choices, { signal, timeout: ASK_TIMEOUT_MS });
            if (selected === undefined) break;
            if (question.allowCustom && selected === custom) {
              const value = await ctx.ui.input(question.question, "Your response", { signal, timeout: ASK_TIMEOUT_MS });
              if (value === undefined) break;
              answers[question.id] = [value];
            } else answers[question.id] = [selected];
          } else if (question.multiSelect && choices.length) {
            answers[question.id] = [];
            for (const choice of choices) {
              if (signal?.aborted) break;
              if (await ctx.ui.confirm(question.question, "Select: " + choice, { signal, timeout: ASK_TIMEOUT_MS })) answers[question.id].push(choice);
            }
            if (question.allowCustom) {
              const value = await ctx.ui.input(question.question, "Optional additional response", { signal, timeout: ASK_TIMEOUT_MS });
              if (value?.trim()) answers[question.id].push(value);
            }
          } else {
            const value = await ctx.ui.input(title, question.placeholder, { signal, timeout: ASK_TIMEOUT_MS });
            if (value === undefined) break;
            answers[question.id] = [value];
          }
        }
        const complete = !signal?.aborted && questions.every(question => question.id in answers);
        return { content: [{ type: "text", text: complete ? formatAnswers(questions, answers) : "The user dismissed the question in Pi Companion." }], details: { questions, answers: complete ? answers : null } };
      }
      if (!bridge.isActivated()) {
        return {
          content: [{ type: "text", text: "Pi Companion is not enabled for this session. Run /companion before asking through the dashboard." }],
          details: { questions: [], answers: null }
        };
      }
      const items = params.questions?.length
        ? params.questions
        : params.question
          ? [{ question: params.question, options: params.options }]
          : [];
      if (!items.length) {
        return { content: [{ type: "text", text: "Provide `question` or `questions`." }], details: { questions: [], answers: null } };
      }
      const questions = toQuestions(items);
      const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS);
      const answers = await bridge.ask(
        { source: "companion", questions },
        signal ? AbortSignal.any([signal, timeout]) : timeout
      );
      return {
        content: [{
          type: "text",
          text: answers
            ? formatAnswers(questions, answers)
            : timeout.aborted
              ? "No answer received from Pi Companion within 10 minutes."
              : "The user dismissed the question in Pi Companion."
        }],
        details: { questions, answers }
      };
    }
  });

  pi.registerTool({
    name: "companion_temp_files",
    label: "Companion temp files",
    description: "List user-uploaded temporary files available to this Pi session. Paths are inside the session sandbox.",
    parameters: Type.Object({}),
    async execute() {
      const files = bridge.getTempFiles();
      return {
        content: [{
          type: "text",
          text: files.length
            ? files.map(file => file.id + "  " + file.path + "  (" + file.size + " bytes)").join("\n")
            : "No temporary files are available for this session."
        }],
        details: { files }
      };
    }
  });

  pi.registerTool({
    name: "companion_delete_temp_file",
    label: "Delete companion temp file",
    description: "Delete one user-uploaded temporary file from this session sandbox by opaque file id.",
    parameters: DeleteTempFileParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await bridge.deleteTempFile(params.fileId);
      return {
        content: [{ type: "text", text: result.ok ? "Temporary file deleted." : "Delete failed: " + (result.error ?? "unknown error") }],
        details: result
      };
    }
  });

  pi.registerCommand("companion", {
    description: "Enable Pi Companion for this session and show the dashboard address (`/companion off` to stop sharing)",
    handler: async (args, ctx) => {
      const generation = ++sharingGeneration;
      bridge.setContext(ctx);
      if (args.trim().toLowerCase() === "off") {
        bridge.setRemoteEnabled(false);
        ctx.ui.notify("Pi Companion sharing ended for this session. Pi continues locally.", "info");
        return;
      }
      const currentBridge = bridge;
      const up = await ensureDaemon((message, level = "info") => ctx.ui.notify(message, level));
      if (bridge !== currentBridge || generation !== sharingGeneration) return;
      if (!up) {
        ctx.ui.notify("Pi Companion daemon is not reachable at " + adminHttpUrl(), "warning");
        return;
      }
      bridge.activate();
      void bridge.connect();
      const enabled = true;
      bridge.setRemoteEnabled(enabled);
      ctx.ui.notify(
        enabled
          ? "Pi Companion enabled for this session: " + adminHttpUrl() + " (paired devices can now see it)"
          : "Pi Companion sharing ended for this session. Pi continues locally.",
        "info"
      );
    }
  });

  pi.registerCommand("remote-control", {
    description: "Toggle remote control for this Pi session",
    handler: async (_args, ctx) => {
      sharingGeneration += 1;
      if (!bridge.isActivated()) {
        ctx.ui.notify("Run /companion first to enable this session's daemon connection.", "warning");
        return;
      }
      const enabled = !bridge.isRemoteEnabled();
      bridge.setRemoteEnabled(enabled);
      ctx.ui.notify(
        enabled
          ? "Remote control enabled for this session. Pair a device from Pi Companion."
          : "Remote control disabled; this Companion session has ended. Pi continues locally.",
        enabled ? "info" : "warning"
      );
    }
  });
}
