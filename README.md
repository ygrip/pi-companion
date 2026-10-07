# Pi Companion

Local-first remote control for Pi sessions.

Pi Companion has two parts:

- TypeScript Pi extension: runs inside each Pi process and translates Pi events/actions into a small control protocol.
- Rust companion server: owns the live session registry, WebSocket routing, and browser UI.

Pi remains the source of truth for model state and execution. The Rust layer is only the broker/control plane.

## Initial vertical slice

- register and list multiple live Pi sessions
- open a session and watch lifecycle, message, and tool events
- send a prompt
- steer an active turn
- abort an active run
- invoke /plan
- request working-tree git diff
- answer companion_ask_user from the browser
- reconnect browser and extension WebSockets
- bind to localhost only by default

## Architecture

    Browser
       |
       | HTTP + WebSocket
       v
    Rust companion server
    127.0.0.1:43721
       |
       | one WebSocket per Pi process
       +-------------------+
       v                   v
    Pi session A        Pi session B
    extension           extension
       |                   |
       +---- Pi ExtensionAPI/events

## Development

Requirements: Node 22+ and current stable Rust.

    npm install
    npm run server:dev

In another shell:

    pi -e ./src/index.ts

Then open http://127.0.0.1:43721

For development, either put pi-companion-server on PATH or disable extension autostart:

    PI_COMPANION_AUTOSTART=0 pi -e ./src/index.ts

## Protocol

Browser to server messages are typed and target a registered session.

    {"sessionId":"...","command":{"type":"prompt","text":"inspect this failure"}}
    {"sessionId":"...","command":{"type":"steer","text":"focus on the parser"}}
    {"sessionId":"...","command":{"type":"abort"}}
    {"sessionId":"...","command":{"type":"git_diff","staged":false}}

There is deliberately no arbitrary shell command endpoint.

## Security boundary

The scaffold binds to loopback only. Do not expose port 43721 directly to a network.

A future remote mode should add authenticated pairing, origin checks, scoped capabilities, expiring credentials, and TLS/tunnel integration before listening beyond localhost.

## Next milestones

1. Render transcript entries instead of raw event JSON.
2. Add typed plan/todo presentation instead of treating /plan as a remote command.
3. Add free-text ask-user answers and richer choice handling.
4. Package prebuilt Rust binaries for macOS, Linux, and Windows and resolve the correct binary from the extension.
5. Persist lightweight session metadata and prune stale sessions.
6. Add authenticated pairing before any non-loopback mode.
7. Add protocol, reconnect, and multi-session isolation tests.
