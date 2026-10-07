import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Zero-config daemon lifecycle.
 *
 * The extension never needs to be told whether a daemon is already running:
 * it probes the admin port first and only launches a daemon when nothing answers.
 * Concurrent Pi sessions coordinate through a lock file so only one of them spawns.
 * The daemon itself also refuses to start twice (port bind), so this is defence in depth.
 */

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.platform === "win32" ? "pi-companion-server.exe" : "pi-companion-server";
const REPO = "ygrip/pi-companion";
const LOCK_STALE_MS = 20_000;
const DOWNLOAD_RETRY_MS = 10 * 60_000;
let lastDownloadFailure: { at: number; error: Error } | null = null;

export type DaemonLog = (message: string, level?: "info" | "warning" | "error") => void;

export function adminHttpUrl() {
  const ws = process.env.PI_COMPANION_URL ?? "ws://127.0.0.1:43721";
  return ws.replace(/^ws/, "http").replace(/\/$/, "");
}

function isLocalTarget() {
  try {
    const host = new URL(adminHttpUrl()).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

type DaemonContext = { version?: string; pid?: number };

async function daemonContext(timeoutMs = 800): Promise<DaemonContext | null> {
  try {
    const response = await fetch(adminHttpUrl() + "/api/context", { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json() as DaemonContext;
  } catch {
    return null;
  }
}

export async function isDaemonUp(timeoutMs = 800) {
  return Boolean(await daemonContext(timeoutMs));
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
}

function cacheDir(version: string) {
  return join(homedir(), ".pi", "agent", "pi-companion", "bin", version);
}

function releaseAsset() {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : null;
  if (!os || !arch) return null;
  const supported = new Set(["linux-x86_64", "darwin-arm64", "darwin-x86_64", "windows-x86_64"]);
  if (!supported.has(os + "-" + arch)) return null;
  return "pi-companion-server-" + os + "-" + arch + (os === "windows" ? ".zip" : ".tar.gz");
}

function onPath() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, EXE))) return join(dir, EXE);
  }
  return null;
}

async function newest(paths: string[]) {
  let best: { path: string; mtime: number } | null = null;
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!best || info.mtimeMs > best.mtime) best = { path, mtime: info.mtimeMs };
    } catch { /* missing */ }
  }
  return best?.path ?? null;
}

/** Download the release binary matching this package version and verify it against SHA256SUMS. */
async function downloadRelease(version: string, log: DaemonLog) {
  const asset = releaseAsset();
  if (!asset) throw new Error("no prebuilt daemon for " + process.platform + "/" + process.arch);
  const dir = cacheDir(version);
  const target = join(dir, EXE);
  const exact = "https://github.com/" + REPO + "/releases/download/v" + version + "/";
  // A git install from a branch can be ahead of the newest tag; fall back to the latest release.
  const latest = "https://github.com/" + REPO + "/releases/latest/download/";

  log("Downloading Pi Companion daemon v" + version + "…");
  let base = exact;
  let archiveRes = await fetch(base + asset, { signal: AbortSignal.timeout(120_000) });
  if (archiveRes.status === 404) {
    log("No daemon release for v" + version + "; using the latest release.", "warning");
    base = latest;
    archiveRes = await fetch(base + asset, { signal: AbortSignal.timeout(120_000) });
  }
  if (!archiveRes.ok) throw new Error("download failed: " + archiveRes.status + " " + asset);
  const sumsRes = await fetch(base + "SHA256SUMS", { signal: AbortSignal.timeout(30_000) });
  if (!sumsRes.ok) throw new Error("checksum download failed: " + sumsRes.status);

  const archive = Buffer.from(await archiveRes.arrayBuffer());
  const expected = (await sumsRes.text())
    .split("\n")
    .map(line => line.trim().split(/\s+\*?/))
    .find(([, name]) => name === asset)?.[0];
  const actual = createHash("sha256").update(archive).digest("hex");
  if (!expected || expected.toLowerCase() !== actual) throw new Error("checksum mismatch for " + asset);

  await mkdir(dir, { recursive: true });
  const staging = join(dir, ".staging-" + process.pid);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const archivePath = join(staging, asset);
  await writeFile(archivePath, archive);
  // bsdtar (macOS, Windows 10+) and GNU tar both handle .tar.gz; bsdtar also handles .zip.
  await execFileAsync("tar", ["-xf", archivePath, "-C", staging]);
  if (process.platform !== "win32") await chmod(join(staging, EXE), 0o755);
  await rename(join(staging, EXE), target);
  await rm(staging, { recursive: true, force: true });
  log("Pi Companion daemon installed at " + target);
  return target;
}

/**
 * Binary resolution order:
 * 1. PI_COMPANION_SERVER (explicit override)
 * 2. a local cargo build inside this package checkout (newest of release/debug) — dev workflow
 * 3. cached release download for this package version
 * 4. pi-companion-server on PATH
 * 5. download the matching GitHub release (sha256-verified) into the cache
 */
export async function resolveDaemonBinary(log: DaemonLog) {
  if (process.env.PI_COMPANION_SERVER) return process.env.PI_COMPANION_SERVER;
  const dev = await newest([
    join(PACKAGE_ROOT, "server", "target", "release", EXE),
    join(PACKAGE_ROOT, "server", "target", "debug", EXE)
  ]);
  if (dev) return dev;
  const version = packageVersion();
  const cached = join(cacheDir(version), EXE);
  if (existsSync(cached)) return cached;
  const path = onPath();
  if (path) return path;
  // Reconnect loops call this repeatedly; don't hammer GitHub after a failed download.
  if (lastDownloadFailure && Date.now() - lastDownloadFailure.at < DOWNLOAD_RETRY_MS) throw lastDownloadFailure.error;
  try {
    return await downloadRelease(version, log);
  } catch (error) {
    lastDownloadFailure = { at: Date.now(), error: error instanceof Error ? error : new Error(String(error)) };
    throw lastDownloadFailure.error;
  }
}

async function acquireLock() {
  const lock = join(tmpdir(), "pi-companion-spawn.lock");
  try {
    const handle = await open(lock, "wx");
    await handle.writeFile(String(process.pid));
    await handle.close();
    return async () => { await rm(lock, { force: true }); };
  } catch {
    try {
      const info = await stat(lock);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        return await acquireLock();
      }
    } catch { /* raced with release */ }
    return null;
  }
}

async function waitForDaemon(ms: number, expectedVersion?: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const context = await daemonContext(500);
    if (context && (!expectedVersion || context.version === expectedVersion)) return true;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

async function waitForDaemonDown(ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await isDaemonUp(300))) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

async function stopDaemonForUpgrade(context: DaemonContext, log: DaemonLog) {
  try {
    const response = await fetch(adminHttpUrl() + "/api/shutdown", {
      method: "POST",
      signal: AbortSignal.timeout(2_000)
    });
    if (response.ok && await waitForDaemonDown(5_000)) return true;
  } catch {
    // Older daemons do not have /api/shutdown. Fall through to a local process stop.
  }

  try {
    if (typeof context.pid === "number" && Number.isInteger(context.pid) && context.pid > 1) {
      process.kill(context.pid, "SIGTERM");
    } else if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/IM", "pi-companion-server.exe", "/F"]);
    } else {
      await execFileAsync("pkill", ["-f", "pi-companion-server"]);
    }
  } catch {
    // The process may already have exited between the probe and the stop attempt.
  }

  const stopped = await waitForDaemonDown(5_000);
  if (!stopped) log("Could not stop the older Pi Companion daemon automatically.", "warning");
  return stopped;
}

/**
 * Make sure a daemon is reachable. Returns true when one answers.
 * Never spawns when a daemon (manual `cargo run`, another session's daemon, …) is already up.
 */
export async function ensureDaemon(log: DaemonLog) {
  const expectedVersion = packageVersion();
  const running = await daemonContext();
  if (running?.version === expectedVersion) return true;
  if (process.env.PI_COMPANION_AUTOSTART === "0" || !isLocalTarget()) return Boolean(running);

  const release = await acquireLock();
  if (!release) return await waitForDaemon(10_000, expectedVersion); // another Pi session is starting/upgrading it
  try {
    const current = await daemonContext();
    if (current?.version === expectedVersion) return true;

    if (current) {
      log(
        "Updating Pi Companion daemon from v" + (current.version ?? "unknown") + " to v" + expectedVersion + "…"
      );
      if (!(await stopDaemonForUpgrade(current, log))) return false;
    }

    const binary = await resolveDaemonBinary(log);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, [], { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
    const up = await waitForDaemon(10_000, expectedVersion);
    if (!up) log("Pi Companion daemon v" + expectedVersion + " did not become ready (" + binary + ")", "warning");
    return up;
  } catch (error) {
    log("Could not start Pi Companion daemon: " + (error instanceof Error ? error.message : String(error)), "warning");
    return false;
  } finally {
    await release();
  }
}
