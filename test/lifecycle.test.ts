import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

// Startup is intentionally inert. These source-contract checks also catch accidental
// reintroduction of the eager connect in extension lifecycle callbacks.
it("session_start resets opt-in without connecting or starting the daemon", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = source.split('pi.on("session_start"')[1].split('pi.on("session_info_changed"')[0];
  assert.match(start, /bridge\.close\(\)/);
  assert.match(start, /bridge = new CompanionBridge\(pi\)/);
  assert.doesNotMatch(start, /bridge\.connect|ensureDaemon|bridge\.activate/);
});

it("connecting and reconnecting require explicit per-session activation", async () => {
  const source = await readFile(new URL("../src/bridge.ts", import.meta.url), "utf8");
  const connect = source.split("async connect() {")[1].split("private open()")[0];
  assert.match(connect, /if \(!this\.activated \|\| !this\.snapshot\.remoteEnabled \|\| this\.closed \|\| this\.connecting\) return/);
  const reconnect = source.split("private scheduleReconnect() {")[1].split("private async handle")[0];
  assert.match(reconnect, /if \(!this\.activated \|\| !this\.snapshot\.remoteEnabled \|\| this\.closed\) return/);
});

it("companion off never starts the daemon and remote-control cannot opt in", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const companion = source.split('pi.registerCommand("companion"')[1].split('pi.registerCommand("remote-control"')[0];
  assert.ok(companion.indexOf('=== "off"') < companion.indexOf("await ensureDaemon"));
  const remote = source.split('pi.registerCommand("remote-control"')[1];
  assert.match(remote, /if \(!bridge\.isActivated\(\)\)/);
  assert.doesNotMatch(remote, /ensureDaemon|bridge\.activate|bridge\.connect/);
});
