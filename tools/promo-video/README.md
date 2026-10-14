# Pi Companion promo video

The narrated ~2-minute walkthrough in [`docs/pi-companion-promo.mp4`](../../docs/pi-companion-promo.mp4), composed in Rust with [fframes](https://github.com/dmtrKovalenko/fframes). The footage is real: an actual Pi session in a terminal and the actual Companion UI in desktop and phone-sized Chromium windows, driven against an isolated daemon. fframes frames the footage and adds captions, pointer and tap overlays, narration, music and sound effects. Waits (Pi working, an automation running) are sped up and labelled as such.

Scenes: start a session → `/remote-control` → pair a device from the dashboard → enter the code on the phone → inspect the session and send a prompt → answer Pi's question → create a research automation → run it and review the run history.

Requires Rust, ffmpeg and the system libraries in the fframes README (macOS: `brew install pkg-config ffmpeg x264 x265 opus nasm ninja`), plus `pi`, `tmux`, `asciinema`, `agg` and Playwright for recording. The default backend is Skia on Metal.

## 1. Record the footage

```bash
npm run ui:build && cargo build --release --manifest-path server/Cargo.toml
PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node tools/promo-video/capture/record.mjs
python3 tools/promo-video/capture/cut.py
```

`record.mjs` writes `captures/` (screencast frames, the terminal cast and an event log with every tap and keystroke). `cut.py` cuts it into `clips/*.mp4` and generates `src/cues.rs`, so overlays and sound effects land on the recorded interactions. Both folders are git-ignored; re-record to change the footage.

## 2. Render

```bash
cd tools/promo-video
cargo run --release -- timeline                 # scenes and timings
cargo run --release -- strip Session -n 8       # contact sheet of one scene
cargo run --release -- preview 0s               # real-time preview window
cargo run --release -- render -o ../../docs/pi-companion-promo.mp4
```

## Sound

- Narration: `audio/voiceover.py` generates `media/vo_*.wav` with OpenAI text-to-speech (`gpt-4o-mini-tts`, needs `OPENAI_TOKEN` or `OPENAI_API_KEY`). The script holds the text; `voice()` in `src/lib.rs` places each line in its scene.
- Music and UI effects (taps, keystrokes, whooshes, chimes) are synthesized by `audio/generate.py` from oscillators and noise, so they are original and royalty-free.

```bash
python3 audio/voiceover.py                      # regenerate the narration
python3 audio/generate.py                       # regenerate media/music.mp3 and the effect WAVs (numpy, ffmpeg)
cargo run --release -- audio analyze            # target about -14 to -16 LUFS, true peak near -1 dBTP
```

Fonts in `media/`: Inter and JetBrains Mono (SIL Open Font License).
