import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CompanionBridge } from "./bridge.js";

const AskParams = Type.Object({
  question: Type.String({ description: "Question to ask through Pi Companion" }),
  options: Type.Optional(Type.Array(Type.String()))
});

export default function companionExtension(pi: ExtensionAPI) {
  const bridge = new CompanionBridge(pi);

  pi.on("session_start", (_event, ctx) => {
    bridge.setContext(ctx);
    bridge.connect();
    bridge.emit("session.start", { cwd: ctx.cwd });
  });
  pi.on("session_info_changed", (event, ctx) => {
    bridge.setContext(ctx);
    bridge.setName(event.name);
  });
  pi.on("agent_start", (_event, ctx) => {
    bridge.setContext(ctx);
    bridge.updateIdle(false);
    bridge.emit("agent.start", {});
  });
  pi.on("agent_end", (event, ctx) => {
    bridge.setContext(ctx);
    bridge.updateIdle(true);
    bridge.emit("agent.end", event);
  });
  pi.on("message_update", (event, ctx) => {
    bridge.setContext(ctx);
    bridge.emit("message.update", event);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    bridge.setContext(ctx);
    bridge.emit("tool.start", event);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    bridge.setContext(ctx);
    bridge.emit("tool.end", event);
  });
  pi.on("session_shutdown", event => {
    bridge.emit("session.shutdown", event);
    bridge.close();
  });

  pi.registerTool({
    name: "companion_ask_user",
    label: "Ask via Companion",
    description: "Ask the user through the Pi Companion web UI when remote control is active.",
    parameters: AskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const answer = await bridge.ask(params.question, params.options);
      return {
        content: [{ type: "text", text: answer || "No answer received from Pi Companion." }],
        details: { question: params.question, answer }
      };
    }
  });

  pi.registerCommand("companion", {
    description: "Show the local Pi Companion address",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Pi Companion: http://127.0.0.1:43721", "info");
    }
  });
}
