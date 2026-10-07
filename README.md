# Pi Companion

Lightweight, local-first remote control for Pi sessions.

Pi Companion is deliberately not another agent runtime. Pi owns execution and conversation state. A single Rust daemon owns session discovery, pairing, temporary file exchange, and browser fan-out.

## Architecture

    local browser :43721
            |
            v
    +---------------------------+
    | pi-companion-server       |
    | single Rust daemon        |
    |                           |
    | live session registry     |
    | pairing/device registry   |
    | per-session temp sandbox  |
    +-------------+-------------+
                  |
          localhost WebSocket
        +---------+---------+
        v                   v
    Pi session A        Pi session B
    extension           extension

    paired phone
         |
      HTTPS/WSS
         |
    tunnel / reverse proxy
         |
         v
    remote surface :43722
         |
         +---- same daemon

The local administration surface and paired-device surface are separate listeners. If you expose Pi Companion through a tunnel, target only port 43722. Never expose port 43721.

## Daemon

The extension connects to the shared daemon automatically. If it is not running, the first extension instance starts pi-companion-server as a detached process. Later Pi sessions reuse the same daemon.

Local admin:

    http://127.0.0.1:43721

Paired-device surface:

    http://127.0.0.1:43722

The remote listener is still loopback-only. Use an authenticated HTTPS tunnel or reverse proxy for access outside the machine.

Set the externally reachable paired-device URL before starting the daemon:

    PI_COMPANION_PUBLIC_URL=https://companion.example.com pi-companion-server

The configured public URL is used only to construct pairing invitations.

## Per-session remote control

Inside any Pi session:

    /remote-control

This toggles whether that session is visible and controllable from paired devices.

A paired device cannot access sessions that have not explicitly enabled remote control.

## Pairing

Pairing is daemon-wide rather than session-specific:

1. Open the local dashboard on port 43721.
2. Select Pair device.
3. The daemon creates a single-use invitation valid for five minutes.
4. The dashboard shows a short human-readable code and a QR containing the invitation URL.
5. Scan the QR on the phone.
6. The phone names itself and claims the invitation.
7. The daemon returns a long random device credential and stores only its SHA-256 hash.
8. The paired device appears on the local dashboard with its last-seen time and can be revoked there.

A phone pairs once with the daemon. Individual Pi sessions still opt in using /remote-control.

## Temporary files

Each session has an isolated temporary directory beneath the operating system temp directory:

    <temp>/pi-companion/<session-id>/

On Unix the daemon attempts to set the Pi Companion and session directories to mode 0700.

The browser can upload a file from the Files tab. Current constraints:

- 25 MiB maximum per upload
- filename is reduced to its final path component
- generated opaque file id prefixes the on-disk name
- the daemon never accepts a client-provided destination path
- file deletion accepts only the opaque file id
- deletion verifies the stored path is still inside that session sandbox
- sandbox content is removed 30 seconds after a disconnected session fails to reconnect

The Pi extension exposes:

    companion_temp_files

which returns the sandbox file paths available to the agent, and:

    companion_delete_temp_file

which destroys one temporary file by opaque id.

This means the agent can consume uploaded artifacts using its normal file capabilities while Pi Companion retains ownership of upload placement and cleanup.

## Browser controls

The initial slice supports:

- multiple live Pi sessions
- prompt
- steer
- abort
- /plan
- git diff
- streamed lifecycle/tool/message events
- companion ask-user requests
- temporary file upload/list/delete
- paired-device management
- per-session remote-control opt-in

There is deliberately no arbitrary shell, arbitrary tool invocation, or arbitrary filesystem API.

## Development

Requirements: Node 22+ and stable Rust.

    npm install
    npm run server:dev

In another shell:

    pi -e ./src/index.ts

For extension work while running the server manually:

    PI_COMPANION_AUTOSTART=0 pi -e ./src/index.ts

## Security boundary

The design follows a few non-negotiable rules:

- local admin and remote device surfaces use different ports
- both listeners bind to loopback
- only the remote listener should ever sit behind a tunnel
- pairing invitations are single-use and expire after five minutes
- paired-device secrets are not stored in plaintext by the daemon
- remote devices only see sessions with remoteEnabled=true
- uploads are placed only in daemon-created session sandboxes
- file deletion is id-based and boundary checked
- there is no generic shell endpoint
- Pi remains the authority that performs agent actions

The current paired-device registry is process-local. Persistent encrypted/restricted device state and explicit origin checking are the next hardening step before treating this as a finished internet-facing product.

## Next hardening milestones

1. Persist device metadata and credential hashes in a 0600 state file.
2. Add strict Origin checks to the paired-device HTTP and WebSocket surface.
3. Add per-device session permissions in addition to session opt-in.
4. Bound browser event queues by both item count and bytes, dropping low-priority deltas first.
5. Add upload count/quota limits per session and optional MIME allowlists.
6. Add proper transcript rendering instead of raw event JSON.
7. Package signed/notarized daemon binaries and service installation for macOS/Linux/Windows.
8. Add protocol, pairing expiry, reconnect, traversal, upload-limit, and multi-session isolation tests.
