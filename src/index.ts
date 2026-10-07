import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CompanionBridge } from "./bridge.js";

const AskParams = Type.Object({
  question: Type.String({ description: "Question to ask through Pi Companion" }),
  options: Type.Optional(Type.Array(Type.String()))
});

const DeleteTempFileParams = Type.Object({
  fileId: Type.String({ description: "Opaque Pi Companion temporary file id" })
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
    description: "Show the local Pi Companion address",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Pi Companion: http://127.0.0.1:43721", "info");
    }
  });

  pi.registerCommand("remote-control", {
    description: "Toggle remote control for this Pi session",
    handler: async (_args, ctx) => {
      const enabled = !bridge.isRemoteEnabled();
      bridge.setRemoteEnabled(enabled);
      ctx.ui.notify(
        enabled
          ? "Remote control enabled for this session. Pair a device from Pi Companion."
          : "Remote control disabled for this session.",
        enabled ? "info" : "warning"
      );
    }
  });
}
