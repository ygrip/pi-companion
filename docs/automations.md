# Automations (0.3.0)

Automations are persisted, named JSON scripts run by the Companion daemon. Open **Automations** in the navigation to view definitions, start/stop runs, and inspect timestamped run history. Click a run to view its captured output and Pi summary. Desktop console users can create, edit, delete, and enable/disable definitions; mobile and paired-device users can only inspect and start/stop them.

## JSON DSL

```json
{
  "name": "Daily repository check",
  "enabled": true,
  "schedule": "0 9 * * 1-5",
  "preconditions": [
    { "type": "command", "command": "git", "args": ["rev-parse", "--is-inside-work-tree"], "cwd": "/absolute/project" }
  ],
  "actions": [
    { "type": "command", "command": "npm", "args": ["test"], "cwd": "/absolute/project", "timeoutSeconds": 600 },
    { "type": "pi", "prompt": "Summarize the repository's current health. Do not edit files.", "cwd": "/absolute/project", "timeoutSeconds": 900 }
  ],
  "postActions": []
}
```

Commands run as executable + argv, not through an implicit shell. A nonzero precondition skips the main actions. Actions execute in order. Post-actions provide a finalization stage. `schedule: null` is manual-only; otherwise use five cron fields (minute, hour, day of month, month, day of week), evaluated in **UTC**. Scheduled execution requires the daemon to remain running; it does not catch up missed executions. A definition cannot have overlapping runs. Disabling scheduling and stopping a run are separate operations.

A Pi action starts `pi --mode rpc --no-session` in the specified directory. Pi must be on PATH and already configured with credentials/model settings. It exposes a read-only Companion session: the feed and questions are visible, but steering, prompts, plan changes, file uploads, and diffs are unavailable. This restriction applies to browser control, **not** the agent's own tools or filesystem access. Pi's final assistant output is stored in the run result. Supported RPC `select`, `confirm`, `input`, and `editor` questions are forwarded; terminal-only custom dialogs cannot be displayed. The native `companion_ask_user` tool falls back to these RPC dialogs for daemon-owned runs.

**Security:** automations run with the daemon user's operating-system privileges. They are not sandboxed. Paired devices can start an existing automation, including commands with side effects. Pair only devices you trust, and review commands, prompts, working directories, and schedules before saving/enabling a definition. Native agent tools and MCP management use the local admin surface; do not expose that surface publicly.

## Agent surface

The extension registers `companion_automation` and ships the `companion-automations` skill. Operations: `list`, `get`, `create`, `update`, `delete`, `enable`, `disable`, `start`, `stop`, `runs`, and `run`. Supply `id` except for list/create, a full `automation` definition for create/update, and `runId` for run detail.

```json
{"action":"create","automation":{"name":"Check","enabled":true,"schedule":null,"preconditions":[],"actions":[{"type":"command","command":"git","args":["status","--short"],"cwd":"/absolute/project"}],"postActions":[]}}
```

Tools only contact an already-running daemon. They never download/start one or activate sharing for a normal Pi session. Start Companion explicitly via `/companion` or `npm run serve` first. Inspect the final run status rather than assuming an accepted start means success.

## Standalone MCP

Node >=22.17 can run the shipped stdio MCP server, without an MCP SDK dependency:

```bash
pi mcp add companion-automations -- node --experimental-strip-types --no-warnings /absolute/path/to/pi-companion/src/automation-mcp.ts
```

Other MCP clients can configure the same executable and arguments. The server exposes `companion_automation` with the same schema as the native extension tool. Configure only one surface if you want to avoid duplicate tools. It uses the default local admin address, overridable with `PI_COMPANION_URL=ws://127.0.0.1:PORT`; non-loopback management targets are rejected.

## HTTP API

Admin console:

- `GET /api/automations` → `{automations}`; `POST` creates a definition.
- `GET /api/automations/{id}` → definition; `PUT` replaces it; `DELETE` removes it.
- `POST /api/automations/{id}/start` and `/stop`.
- `GET /api/automations/{id}/runs` → `{runs}`.
- `GET /api/automations/{id}/runs/{runId}` → run details including result.

The paired-device surface requires valid device authentication and allowed Origin, and exposes only GET/start/stop. Mobile layout is a UI restriction, not a separate authentication role; local console API callers remain administrators.

## Automatic archiving

Disconnected/stopped session records older than seven days are archived automatically. Live command channels, active/idle sessions, and recent disconnections are retained. Archiving removes only the daemon registry/feed entries, never the project, local Pi history, or files. Automation definitions and run history are independent of session archiving.
