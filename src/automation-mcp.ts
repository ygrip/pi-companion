#!/usr/bin/env node
/** Standalone stdio MCP surface. Run with Node >=22.17 (native TypeScript stripping). */
import { automationTool, executeAutomation, type AutomationParams } from "./automation.ts";

const inFlight = new Map<string | number, AbortController>();
let output = Promise.resolve();
function send(record: unknown) {
  const line = JSON.stringify(record) + "\n";
  output = output.then(() => new Promise<void>((resolve, reject) => {
    process.stdout.write(line, error => error ? reject(error) : resolve());
  }));
  void output.catch(() => { process.exitCode = 1; process.stdin.destroy(); });
}
const error = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
async function receive(line: string) {
  let message: { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };
  try { message = JSON.parse(line); }
  catch { error(null, -32700, "Invalid JSON"); return; }
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    error(message?.id ?? null, -32600, "Invalid JSON-RPC request"); return;
  }
  if (message.method === "notifications/cancelled") {
    const id = message.params?.requestId;
    if (typeof id === "string" || typeof id === "number") inFlight.get(id)?.abort();
    return;
  }
  if (message.id === undefined) return;
  const id = message.id;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
  switch (message.method) {
    case "initialize": {
      const versions = ["2025-06-18", "2025-03-26", "2024-11-05"];
      const requested = message.params?.protocolVersion;
      reply({ protocolVersion: versions.includes(String(requested)) ? requested : versions[0], capabilities: { tools: {} }, serverInfo: { name: "pi-companion-automations", version: "0.3.1" } });
      return;
    }
    case "ping": reply({}); return;
    case "tools/list": reply({ tools: [automationTool] }); return;
    case "tools/call": {
      if (message.params?.name !== automationTool.name) { error(id, -32602, "Unknown tool"); return; }
      const args = message.params?.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) { error(id, -32602, "Expected tool arguments"); return; }
      const controller = new AbortController();
      inFlight.set(id, controller);
      try {
        const result = await executeAutomation(args as AutomationParams, controller.signal);
        reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (failure) {
        reply({ isError: true, content: [{ type: "text", text: String(failure instanceof Error ? failure.message : failure) }] });
      } finally { inFlight.delete(id); }
      return;
    }
    default: error(id, -32601, "Method not found");
  }
}

// Split only LF: Unicode line separators are legal inside JSON string values.
let buffer = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  let newline: number;
  while ((newline = buffer.indexOf(10)) !== -1) {
    const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
    buffer = buffer.subarray(newline + 1);
    if (Buffer.byteLength(line) > 1024 * 1024) { error(null, -32600, "Request too large"); continue; }
    if (line.trim()) void receive(line);
  }
  if (buffer.length > 1024 * 1024) { error(null, -32600, "Request too large"); process.stdin.destroy(); break; }
}
for (const controller of inFlight.values()) controller.abort();
await output;
