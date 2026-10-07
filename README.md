# Pi Companion

Lightweight, local-first remote control for Pi sessions.

Pi Companion is deliberately not another agent runtime. Pi owns execution and conversation state. A single Rust daemon owns session discovery, pairing, temporary file exchange, browser fan-out, and the embedded web UI.

The UI is a static SvelteKit application. There is no Node runtime in production and no Tauri shell. Rust embeds the generated frontend into the daemon binary.

![Pi Companion overview, dark theme](docs/dashboard.webp)

<p>
  <img src="docs/session-light.webp" alt="Session detail, light theme" width="68%" />
  <img src="docs/mobile.webp" alt="Session detail on a phone" width="28%" />
</p>

## Install

    pi install npm:@ygrip/pi-companion

or straight from git:

    pi install git:github.com/ygrip/pi-companion

Then start pi as usual and run /companion in each session you want to follow from the dashboard or your phone. It starts the daemon if needed, prints the dashboard address and shares that session with paired devices (`/companion off` stops sharing). Nothing else to configure: the extension finds or starts the daemon on its own, downloading the matching sha256-verified daemon binary from GitHub Releases on first use (see Daemon).

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

There is exactly one daemon per machine, shared by every Pi session. The extension manages it with no configuration:

1. It probes http://127.0.0.1:43721. If anything answers (a daemon started by another session, or one you ran yourself with cargo run), it just connects. It never starts a second copy.
2. If nothing answers, one Pi session takes a lock (so several sessions starting at once don't race), launches the daemon detached, and waits for it to be ready. The others wait for that daemon.
3. If a live connection drops, the extension waits 20 seconds before launching a replacement, so restarting a dev daemon doesn't get pre-empted.
4. The daemon also refuses to run twice: if its ports are taken it prints a message and exits 0.

The daemon binary is resolved in this order:

| Order | Source |
|---|---|
| 1 | PI_COMPANION_SERVER (explicit path override) |
| 2 | a cargo build inside the package checkout: newest of server/target/release and server/target/debug |
| 3 | cached download: ~/.pi/agent/pi-companion/bin/<version>/ |
| 4 | pi-companion-server on PATH |
| 5 | download of the GitHub release matching the package version, verified against SHA256SUMS, then cached |

Optional environment variables (none are required):

| Variable | Effect |
|---|---|
| PI_COMPANION_SERVER | use this daemon binary |
| PI_COMPANION_URL | daemon WebSocket URL (default ws://127.0.0.1:43721); autostart only happens for loopback URLs |
| PI_COMPANION_AUTOSTART=0 | never launch a daemon, only connect |
| PI_COMPANION_PUBLIC_URL | daemon-side: public URL embedded in pairing QR codes |
| PI_COMPANION_ALLOWED_ORIGINS | daemon-side: extra comma-separated browser origins accepted besides the loopback addresses and the public URL |

Local admin:

    http://127.0.0.1:43721

Paired-device surface:

    http://127.0.0.1:43722

The remote listener is still loopback-only. Use an authenticated HTTPS tunnel or reverse proxy for access outside the machine.

Set the externally reachable paired-device URL before starting the daemon:

    PI_COMPANION_PUBLIC_URL=https://companion.example.com pi-companion-server

The configured public URL is used to construct pairing invitations and is the browser origin the paired-device surface accepts (see Security boundary).

## Per-session remote control

Inside any Pi session:

    /companion          # enable for this session (and print the dashboard address)
    /companion off      # stop sharing this session
    /remote-control     # toggle sharing on/off

A paired device cannot access sessions that have not explicitly enabled remote control.

## Questions from Pi

Pi's `companion_ask_user` tool asks one to four questions at once. Each question can offer options with descriptions, allow several choices (`multiSelect`), and accept a free-text "Other" answer; a question without options is free text. The browser shows them in a bottom sheet within thumb reach; "Later" hides it until you tap the waiting-question badge.

Dialogs from other extensions (`ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.input`) are relayed to the same sheet while the terminal dialog stays open: whichever side answers first wins and the other closes. Question tools that draw their own `ctx.ui.custom` picker are relayed through a small adapter: pi-jar's `jar_ask` is supported, and a companion answer completes its terminal picker. Other `ctx.ui.custom` components and `ctx.ui.editor` stay terminal-only because they cannot be answered from outside. Pending questions are part of the session snapshot, so a browser that connects later still sees them.

## Pairing and devices

Pairing is daemon-wide rather than session-specific. Everything lives on the **Devices** page of the local console (port 43721):

1. Choose **Pair a device**. The daemon creates a single-use invitation (5 minutes by default, configurable in Settings) and shows it as a QR code, a copyable link and a short code (`XXXX-XXXX`).
2. On the phone, open the paired-device address. An unpaired device gets a connect screen: scan the QR code with the in-app camera (needs HTTPS; otherwise use the phone's camera app, which opens the invitation link) or type the short code, then give the device a name.
3. The daemon issues a long random credential and stores only its SHA-256 hash.

Typed codes are short, so wrong ones are counted: after ten misses within ten minutes every open invitation is withdrawn and code entry is refused (HTTP 429) until the window passes.

Each paired device shows a live **Connected** / **Disconnected** status (with the number of open tabs), when it was last seen and when it was paired. From the console you can:

- **Disconnect**: end the device's live connections (WebSocket close code 4001). It stays paired and can reconnect when its user chooses.
- **Revoke**: delete its credential and drop its connections (close code 4003). The device clears its stored credential and must scan a new code.

Paired devices (name, browser user agent, pairing and last-seen times, credential hash) and settings survive daemon restarts. They are stored in `~/.pi/agent/pi-companion/state.json`, created with mode 0600 inside a 0700 directory and replaced atomically; a looser mode found on startup is tightened. Override the directory with `PI_COMPANION_HOME`.

A phone pairs once with the daemon. Individual Pi sessions still opt in using /companion.

## Settings

The **Settings** page (local console only) covers:

| Setting | Default | Notes |
|---|---|---|
| Theme | System | Light, dark or follow the OS. Stored per browser. |
| Public address | empty | The tunnel / reverse-proxy URL embedded in pairing codes. `PI_COMPANION_PUBLIC_URL` overrides it and locks the field. |
| Pairing code lifetime | 5 minutes | 1 to 60. |
| Largest file | 25 MB | 1 to 100 MB per upload. |
| Allowed file types | any | Optional MIME allowlist such as `image/*, application/pdf`. Uploads outside it get HTTP 415. |

It also shows the daemon version, both addresses, and where settings and session files are stored.

## Temporary files

Each session has an isolated temporary directory beneath the operating system temp directory:

    <temp>/pi-companion/<session-id>/

On Unix the daemon attempts to set the Pi Companion and session directories to mode 0700.

The browser can upload a file from the Files tab. Current constraints:

- 25 MiB maximum per upload by default (Settings); a rejected or interrupted upload leaves no partial file
- optional MIME allowlist: the type guessed from the file name and any specific declared Content-Type must both be allowed
- session ids in paths are limited to `[A-Za-z0-9_-]`, so they can never name a directory outside the sandbox
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

## Session identity

Every registered Pi session publishes a compact display model to the daemon:

- session name
- short title
- status: active, idle, or stopped
- main model
- thinking effort
- working directory and process id
- remote-control state

Stopped sessions remain visible in the daemon registry so the dashboard does not lose context when a Pi process exits. Their controls are disabled and their temporary sandbox is cleaned after the reconnect grace period.

## UI

A single-page SvelteKit app, embedded in the daemon binary:

| Page | Who sees it | What it is for |
|---|---|---|
| Overview | everyone | Dot-field hero, live counts, sessions that need your answer, live sessions, Help entry |
| Sessions | everyone | Searchable, filterable list (Working / Waiting / Ended). Paired devices only see shared sessions |
| Session detail | everyone | Shell-style transcript that follows the theme: Markdown replies with highlight.js code and Mermaid diagrams, collapsible tool output and thinking. Question sheet, files, git changes, /plan; the composer (message / steer) appears on Activity only. Session details are collapsed under the title |
| Devices, Settings | local console only | Pairing, connection status, disconnect and revoke; daemon settings with a save bar that appears only for unsaved edits |
| Help, Privacy, Terms | everyone | Setup stepper, commands, tools, troubleshooting; data handling; terms of use. Help is opened from the Overview |

The Live indicator in the header and sidebar opens the connection sheet (status, version and, on this computer, the console and device addresses and data folders).

Git problems on the Changes tab (for example a folder that is not a git repository) show as a toast, never in the transcript.

Design notes:

- light and dark themes with a system default, applied before first paint so there is no flash
- claymorphism: solid surfaces with an outer drop shadow plus inset highlight and shade (no blur or glass); small icons are Lucide line icons on raised clay wells, feature art is 3D clay renders from [3dicons](https://3dicons.co) (CC0)
- warm amber on graphite or paper, matching the logo; system fonts only, so nothing loads from the network. highlight.js and Mermaid load only when a reply contains code or a diagram
- the window never scrolls. The sidebar, page content, activity feed, file list, diff, chips and tabs each scroll inside their own container, and the composer and mobile tab bar stay put
- the activity feed follows new output and stops following when you scroll up ("Jump to latest" brings you back)
- mobile: bottom tab bar, safe-area insets, 44px touch targets, 16px inputs (no iOS zoom), Enter inserts a newline on touch keyboards
- accessibility: skip link, visible focus rings, arrow-key tabs, labelled controls, live regions for the feed and questions, reduced-motion support
- the dot field is Raksara's component, loaded when the browser is idle, paused when hidden, and static under reduced motion
- dropping a file anywhere outside the Files drop zone is ignored. Without this, the browser tries to open the file itself (Firefox reports this as "may not load or link to file:///")

### Caching and updates

The UI is built with `adapter-static` in SPA mode (`200.html` fallback) and embedded with `rust-embed`:

- `/_app/immutable/**` is content-hashed and served with `Cache-Control: public, max-age=31536000, immutable`
- the shell, `version.json` and icons are served with `no-cache` and a strong ETag, so a reload costs a 304 until something changes
- unknown file-like paths return 404 instead of the HTML shell, so a stale tab never parses HTML as JavaScript
- the app polls `version.json` every minute; when a new build is detected it shows a reload banner and the next navigation loads the new version
- HTML responses carry a same-origin Content-Security-Policy and `X-Frame-Options: DENY`

Generated `server/web-dist` files are not committed. CI builds them once and every native build embeds the same bundle.

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

Requirements: Node 22.17+ and stable Rust.

    npm install
    npm run serve

This builds the UI, starts the daemon and prints where it is listening:

      Pi Companion v0.1.0

      Console          http://127.0.0.1:43721
      Paired devices   http://127.0.0.1:43722
      Pairing links    http://127.0.0.1:43722  (default, this computer only; set one in Settings)
      Data             ~/.pi/agent/pi-companion  (0 paired)

If a daemon is already running (for example one a Pi session started automatically), `npm run serve` prints its console address and exits instead of starting a second copy. Stop the running one first (`pkill -f pi-companion-server`) if you want your fresh build to take over. Set `RUST_LOG` (for example `RUST_LOG=debug`) for more detailed logs.

Type checks cover the extension (`tsc`) and the UI (`svelte-check`, warnings fail):

    npm run check

Tests cover the question relay (`node --test`) and the daemon's wire protocol, pairing expiry and code throttling, origin policy, bridge and device reconnects, path traversal, upload limits, MIME allowlist, state-file permissions and multi-session isolation (`cargo test`):

    npm test

UI modules import shared code through the `#lib/*` subpath import declared in `ui/package.json` (SvelteKit 3 replaced `$lib`). Subpath imports do not guess extensions, so always write the full file name: `#lib/format.ts`, `#lib/companion.svelte.ts`, `#lib/Icon.svelte`. `ui/tsconfig.json` extends SvelteKit's generated `$app/tsconfig`.

Then, in another shell, start Pi with the extension from this checkout:

    pi -e ./src/index.ts

For hot-reloading UI work, keep the daemon running and use:

    npm run ui:dev

which proxies /api and /ws to the daemon on 43721.

Running the daemon manually with npm run serve and the extension side by side just works: the extension sees the running daemon and connects to it. If you don't run it, the extension launches your local cargo build automatically.

## Releases

The package carries the pi-package keyword, so published npm versions appear in the Pi package gallery (https://pi.dev/packages). Host-provided packages (@earendil-works/pi-coding-agent, typebox) are peer dependencies, as Pi requires.

GitHub Actions run only for release tags. Pushing ordinary commits or opening pull requests does not trigger any workflow; CI can also be started manually with workflow_dispatch.

A tag matching vX.Y.Z triggers both the CI and release workflows.

Before publishing, the workflow requires X.Y.Z to match both package.json and server/Cargo.toml. It then runs TypeScript and Rust checks, builds native daemon archives for Linux x86_64, macOS arm64, macOS x86_64, and Windows x86_64, generates SHA-256 checksums, and creates a GitHub Release.

Only after the GitHub Release exists, and only if the repository has an NPM_TOKEN secret, the same tag publishes @ygrip/pi-companion to npm with provenance, so an npm install never looks for a daemon binary that is not uploaded yet. Git installs need no token.

On first use the extension downloads `pi-companion-server-<os>-<arch>` for its own package version (`releases/download/v<version>/`), verifies it against `SHA256SUMS`, and caches it under `~/.pi/agent/pi-companion/bin/<version>/`. A git install from a branch that is ahead of the newest tag falls back to the latest release.

## Security boundary

The design follows a few non-negotiable rules:

- local admin and remote device surfaces use different ports
- both listeners bind to loopback
- only the remote listener should ever sit behind a tunnel
- pairing invitations are single-use and expire after five minutes; wrong short codes are throttled
- paired-device secrets are stored only as SHA-256 hashes, in a 0600 state file
- strict Origin checks: the paired-device surface accepts WebSocket upgrades and POST/DELETE only from its own loopback address, the public URL or `PI_COMPANION_ALLOWED_ORIGINS`, and refuses any foreign Origin; the console accepts only its own loopback origin, so a web page cannot drive Pi through it
- remote devices only see sessions with remoteEnabled=true
- uploads are placed only in daemon-created session sandboxes, within the size limit and optional MIME allowlist
- file deletion is id-based and boundary checked
- there is no generic shell endpoint
- Pi remains the authority that performs agent actions

## Next hardening milestones

1. Add per-device session permissions in addition to session opt-in.
2. Bound browser event queues by both item count and bytes, dropping low-priority deltas first.
3. Add upload count/quota limits per session.
4. Package signed/notarized daemon binaries and service installation for macOS/Linux/Windows.

## License

MIT. See [LICENSE](LICENSE).
