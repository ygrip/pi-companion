import { execFile } from 'node:child_process';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const name = 'pi-companion';

/** A fixed, per-user service name: multiple extensions update the same service under the spawn lock. */
export async function startBackgroundService(binary: string): Promise<void> {
  const home = process.env.PI_COMPANION_HOME ?? join(homedir(), '.pi', 'agent', 'pi-companion');
  const dir = join(home, 'service');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const script = join(dir, 'supervisor.mjs');
  const config = join(dir, 'daemon.json');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value && (key.startsWith('PI_COMPANION_') || key === 'PATH')));
  await writeFile(config + '.tmp', JSON.stringify({ binary, env }), { mode: 0o600 });
  await rename(config + '.tmp', config);
  await writeFile(script, `import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
let child; let stopping = false;
function run() {
  if (stopping) return;
  try {
    const { binary, env } = JSON.parse(readFileSync(new URL('./daemon.json', import.meta.url), 'utf8'));
    child = spawn(binary, [], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
    let scheduled = false;
    const retry = () => { if (!scheduled && !stopping) { scheduled = true; setTimeout(run, 3000); } };
    child.once('error', retry); child.once('exit', retry);
  } catch { setTimeout(run, 3000); }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; child?.kill('SIGTERM'); setTimeout(() => process.exit(), 1000); });
run();
`, { mode: 0o600 });
  const run = (command: string, args: string[]) => exec(command, args, { timeout: 15_000 });
  if (process.platform === 'darwin') {
    const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const label = 'dev.pi-companion.daemon';
    const plist = join(homedir(), 'Library', 'LaunchAgents', label + '.plist');
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(script)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`, { mode: 0o600 });
    const domain = 'gui/' + process.getuid!();
    try { await run('launchctl', ['print', domain + '/' + label]); }
    catch { await run('launchctl', ['bootstrap', domain, plist]); }
    await run('launchctl', ['kickstart', domain + '/' + label]);
  } else if (process.platform === 'linux') {
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    await mkdir(unitDir, { recursive: true });
    const quote = (text: string) => '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
    await writeFile(join(unitDir, name + '.service'), `[Unit]\nDescription=Pi Companion daemon\n[Service]\nExecStart=${quote(process.execPath)} ${quote(script)}\nRestart=always\nRestartSec=3\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', name + '.service']);
  } else if (process.platform === 'win32') {
    const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const user = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\');
    if (!user) throw new Error('Cannot resolve the current Windows account');
    const task = join(dir, 'task.xml');
    // No default 72-hour limit, battery/idle stop, or overlapping task instances.
    await writeFile(task, `\uFEFF<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escape(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="User"><UserId>${escape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions Context="User"><Exec><Command>${escape(process.execPath)}</Command><Arguments>&quot;${escape(script)}&quot;</Arguments></Exec></Actions></Task>`, { encoding: 'utf16le', mode: 0o600 });
    await run('schtasks', ['/Create', '/F', '/TN', 'Pi Companion', '/XML', task]);
    await run('schtasks', ['/Run', '/TN', 'Pi Companion']);
  } else {
    throw new Error('No supported per-user background service on ' + process.platform);
  }
}
