---
name: companion-automations
description: Create, update, delete, enable, disable, run, stop, and inspect Pi Companion automations with the companion_automation tool. Use for recurring repository tasks, scheduled agent work, and automation run history.
---

# Companion automations

Use `companion_automation` (native extension or standalone MCP surface). It talks only to the local admin daemon; it does not launch the daemon or enable session sharing. The Pi extension checks/starts the daemon on load independently of session sharing. If unavailable, reload the extension or start a development daemon with `npm run serve`. `/remote-control` is only needed to share a normal session.

## Safety

Before saving or starting an automation, confirm the user's intended command, working directory, schedule, and side effects. Do not silently schedule destructive commands, spend model quota, or turn an untrusted prompt into a recurring task. Commands and Pi runs execute with the user's OS permissions, not in a sandbox. Remote/mobile clients can inspect, start, and stop existing definitions, but cannot author them.

Read the current definition with `get` before `update`, `enable`, or `disable`. Updating replaces the full definition. Preserve fields not intentionally changed. `disable` prevents scheduled runs; use `stop` separately to cancel a running automation. Definitions and run history are daemon-owned; archiving sessions never deletes local Pi data.

## Definition DSL

```json
{
  "name": "Repository check",
  "enabled": true,
  "schedule": "0 9 * * 1-5",
  "preconditions": [],
  "actions": [
    { "type": "command", "command": "npm", "args": ["test"], "cwd": "/absolute/repo", "timeoutSeconds": 600 },
    { "type": "pi", "prompt": "Summarize repository health. Do not edit files.", "cwd": "/absolute/repo", "timeoutSeconds": 900 }
  ],
  "postActions": []
}
```

- `schedule` is a five-field **UTC** cron expression; `null` means manual only. The daemon must be running for scheduling. There is no catch-up while it is stopped.
- Commands use executable plus argument array, **no implicit shell**. Shell syntax must never be passed as an executable. Avoid explicit shells unless the user requested and authorized them.
- Preconditions gate execution. Actions run sequentially. Post-actions are the cleanup/finalization stage; inspect the run result to determine failures.
- Optional `maxRetries` (integer 0–5, default 0) and `retryIntervalSeconds` (integer 1–86400, default 10) retry only the failed main action, never completed steps, preconditions, or finalizers. Stop cancels a retry delay. Retries may duplicate side effects or model usage: obtain authorization, and keep them off for non-idempotent remote submissions.
- Optional `historyLimit` (integer 1–1000, default 30) keeps the latest N finished runs per automation. Lowering it immediately removes older history on save. Retry delays must fit before the next scheduled trigger.
- A Pi action starts a daemon-owned, read-only Companion session: users can answer asks, but cannot steer, prompt, upload, request changes, or edit its plan. The agent itself still has ordinary Pi tool permissions.
- Pi must be installed on PATH and configured with model credentials. Its final assistant output is saved in run history.

## Tool operations

- `list`, `get` (`id`)
- `create` (`automation`), `update` (`id`, full `automation`)
- `delete`, `enable`, `disable`, `start`, `stop` (`id`)
- `runs` (`id`), `run` (`id`, `runId`)

After `start`, inspect `runs`/`run`; an accepted start is not completion. Report the actual final status and stored result. Do not retry a side-effecting run automatically after an ambiguous network error.
