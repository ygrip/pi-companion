# Pi Companion promo video

The ~60 s walkthrough in [`docs/pi-companion-promo.mp4`](../../docs/pi-companion-promo.mp4), written in Rust with [fframes](https://github.com/dmtrKovalenko/fframes). Every screen is a vector mockup in the Companion dark theme; the sessions, codes and results are demo data.

Scenes: start a session → `/remote-control` → pair a device from the dashboard → enter the code on the phone → inspect the session and send a prompt → answer Pi's question → create a research automation → run it and review the run history.

Requires Rust, ffmpeg and the system libraries in the fframes README (macOS: `brew install pkg-config ffmpeg x264 x265 opus nasm ninja`). The default backend is Skia on Metal.

```bash
cd tools/promo-video
cargo run --release -- timeline                 # scenes and timings
cargo run --release -- strip Session -n 8       # contact sheet of one scene
cargo run --release -- preview 0s               # real-time preview window
cargo run --release -- render -o ../../docs/pi-companion-promo.mp4
```

Fonts in `media/`: Inter and JetBrains Mono (SIL Open Font License).
