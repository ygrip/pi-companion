# Security model

Pi Companion intentionally exposes less power than Pi itself.

## Trust zones

### Local admin surface

127.0.0.1:43721

Trusted local administrator only. It can create pairing invitations, view and revoke paired devices, and inspect all registered sessions.

Do not place this listener behind a tunnel or reverse proxy.

### Paired-device surface

127.0.0.1:43722

Designed to sit behind an HTTPS/WSS tunnel. Every control/data endpoint requires a paired-device credential, except the one-time pairing claim endpoint and static pairing UI.

Paired devices can see only sessions that explicitly enabled remote control.

### Pi bridge

Each Pi process keeps one outbound localhost WebSocket to the daemon. The browser cannot invoke arbitrary extension tools. The allowed command set is a closed protocol.

## Files

Uploads are daemon-owned and session-scoped.

The browser cannot choose a destination path. The daemon derives a final filename, prefixes it with an opaque id, and places it in the current session sandbox.

Agent deletion uses the opaque id rather than a path. Before unlinking, the daemon verifies that the recorded file is still beneath the expected session sandbox.

## Non-goals

Pi Companion does not provide:

- remote shell access
- arbitrary filesystem browsing
- arbitrary tool invocation
- direct git push/commit endpoints
- a second copy of Pi conversation state

These should remain Pi actions, where Pi's existing policies and agent loop remain in control.
