import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

it("session_start restores only a recorded per-session opt-in", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = source.split('pi.on("session_start"')[1].split('pi.on("session_info_changed"')[0];
  assert.match(start, /bridge\.close\(\)/);
  assert.match(start, /bridge = new CompanionBridge\(pi, ctx\.sessionManager\?\.getSessionId\?\.\(\)\)/);
  assert.match(start, /checkDaemon\(ctx\)/);
  assert.match(start, /entry\.customType === "companion:sharing"/);
  assert.match(start, /enabled === true/);
  assert.match(start, /saved\.sessionId === bridge\.sessionId/);
  assert.match(start, /setSharing\(true, ctx, false\)/);
});

it("connecting and reconnecting require explicit per-session activation", async () => {
  const source = await readFile(new URL("../src/bridge.ts", import.meta.url), "utf8");
  const connect = source.split("async connect() {")[1].split("private open()")[0];
  assert.match(connect, /if \(!this\.activated \|\| !this\.snapshot\.remoteEnabled \|\| this\.closed \|\| this\.connecting\) return/);
  const reconnect = source.split("private scheduleReconnect() {")[1].split("private async handle")[0];
  assert.match(reconnect, /if \(!this\.activated \|\| !this\.snapshot\.remoteEnabled \|\| this\.closed\) return/);
});

it("remote-control can opt in directly and sharing-off never stops the daemon", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const sharing = source.split('async function setSharing')[1].split('pi.registerCommand("companion"')[0];
  assert.ok(sharing.indexOf('if (!enabled)') < sharing.indexOf('await ensureDaemon'));
  assert.match(sharing, /bridge\.activate\(\)/);
  const remote = source.split('pi.registerCommand("remote-control"')[1];
  assert.match(remote, /setSharing/);
  assert.doesNotMatch(remote, /Run \/companion|isActivated/);
});
