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

Sound: the music and UI effects (taps, keystrokes, whooshes, chimes) are synthesized by `audio/generate.py` from oscillators and noise, so they are original and royalty-free. Effect times come from the same cue helpers that drive the animation in `src/lib.rs`. To change the sound:

```bash
python3 audio/generate.py                       # regenerate media/music.mp3 and the effect WAVs (numpy, ffmpeg)
cargo run --release -- audio analyze            # target about -14 LUFS, true peak at or below -1 dBTP
```

Fonts in `media/`: Inter and JetBrains Mono (SIL Open Font License).
