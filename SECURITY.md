# Security model

Pi Companion intentionally exposes less power than Pi itself.

## Trust zones

### Local admin surface

127.0.0.1:43721

Trusted local administrator only. It can create pairing invitations, see which paired devices are connected, disconnect or revoke them, change daemon settings, and inspect all registered sessions.

Do not place this listener behind a tunnel or reverse proxy.

It has no credentials, so it refuses any request whose `Origin` is not its own loopback address (`http://127.0.0.1:43721`, `localhost`, `[::1]`) or listed in `PI_COMPANION_ALLOWED_ORIGINS`. A web page on another origin can therefore not open its WebSocket and steer Pi. Requests without `Origin` (the Pi bridge, CLI tools) are accepted.

### Paired-device surface

127.0.0.1:43722

Designed to sit behind an HTTPS/WSS tunnel. Every control/data endpoint requires a paired-device credential, except the one-time pairing claim endpoint and static pairing UI.

Strict Origin checks: WebSocket upgrades and POST/DELETE requests must carry an `Origin` equal to the loopback device address, the configured public URL, or an entry of `PI_COMPANION_ALLOWED_ORIGINS`; GET requests may omit `Origin` but are refused with any foreign one.

Pairing invitations are single-use and expire (5 minutes by default). The short typed code is rate limited: ten wrong codes within ten minutes withdraw every open invitation and further code claims get HTTP 429 until the window passes.

Paired devices can see only sessions that explicitly enabled remote control.

Revoking a device deletes its credential hash and closes its open connections immediately (WebSocket close 4003). Disconnecting closes them without deleting the credential (close 4001).

### Stored state

Paired devices (name, browser user agent, pairing and last-seen times, and the SHA-256 hash of the credential; never the credential) and settings are written atomically to `~/.pi/agent/pi-companion/state.json`. On Unix the directory is 0700 and the file is created 0600 before any byte is written; a looser mode found at startup is tightened.

### Web UI hardening

HTML responses send a same-origin Content-Security-Policy (no third-party scripts, styles, fonts or connections), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. The UI loads nothing from the network beyond the daemon itself.

### Pi bridge

Each Pi process keeps one outbound localhost WebSocket to the daemon. The browser cannot invoke arbitrary extension tools. The allowed command set is a closed protocol.

## Files

Uploads are daemon-owned and session-scoped.

The browser cannot choose a destination path. The daemon derives a final filename (last path component, no control characters or leading dots), prefixes it with an opaque id, and places it in the current session sandbox. Session ids that reach the filesystem are restricted to `[A-Za-z0-9_-]`.

Uploads above the configured size limit are refused (HTTP 413) and their partial file is removed. An optional MIME allowlist (Settings) refuses other types with HTTP 415; both the type implied by the file name and any specific declared Content-Type must be allowed.

Agent deletion uses the opaque id rather than a path. Before unlinking, the daemon verifies that the recorded file is still beneath the expected session sandbox.

## Non-goals

Pi Companion does not provide:

- remote shell access
- arbitrary filesystem browsing
- arbitrary tool invocation
- direct git push/commit endpoints
- a second copy of Pi conversation state

These should remain Pi actions, where Pi's existing policies and agent loop remain in control.
