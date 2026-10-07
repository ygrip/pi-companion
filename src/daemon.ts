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

export async function isDaemonUp(timeoutMs = 800) {
  try {
    const response = await fetch(adminHttpUrl() + "/api/context", { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
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
  const base = "https://github.com/" + REPO + "/releases/download/v" + version + "/";

  log("Downloading Pi Companion daemon v" + version + "…");
  const [archiveRes, sumsRes] = await Promise.all([
    fetch(base + asset, { signal: AbortSignal.timeout(120_000) }),
    fetch(base + "SHA256SUMS", { signal: AbortSignal.timeout(30_000) })
  ]);
  if (!archiveRes.ok) throw new Error("download failed: " + archiveRes.status + " " + asset);
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

async function waitForDaemon(ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isDaemonUp(500)) return true;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * Make sure a daemon is reachable. Returns true when one answers.
 * Never spawns when a daemon (manual `cargo run`, another session's daemon, …) is already up.
 */
export async function ensureDaemon(log: DaemonLog) {
  if (await isDaemonUp()) return true;
  if (process.env.PI_COMPANION_AUTOSTART === "0" || !isLocalTarget()) return false;

  const release = await acquireLock();
  if (!release) return await waitForDaemon(10_000); // another Pi session is starting it
  try {
    if (await isDaemonUp()) return true; // started while we were taking the lock
    const binary = await resolveDaemonBinary(log);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, [], { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
    const up = await waitForDaemon(10_000);
    if (!up) log("Pi Companion daemon did not become ready (" + binary + ")", "warning");
    return up;
  } catch (error) {
    log("Could not start Pi Companion daemon: " + (error instanceof Error ? error.message : String(error)), "warning");
    return false;
  } finally {
    await release();
  }
}
