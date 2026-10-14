#!/usr/bin/env python3
"""Generate the narration with OpenAI text-to-speech into ../media/vo_*.wav.

Each line is placed in its scene by `voice()` in src/lib.rs (same file names). Needs an
OpenAI API key in OPENAI_TOKEN (or OPENAI_API_KEY) and ffmpeg.

    python3 tools/promo-video/audio/voiceover.py
"""
import json
import os
import subprocess
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "media"
MODEL = "gpt-4o-mini-tts"
VOICE = "coral"
INSTRUCTIONS = (
    "Narrator for a short product demo video. Warm, calm and confident, like a friendly developer "
    "showing a tool they love. Natural pace, clear diction, light smile in the voice, no hype."
)

LINES = {
    "vo_intro": "Meet Pi Companion.",
    "vo_terminal_0": "This is a real Pi session in the terminal. Pi fixes a bug while you watch.",
    "vo_terminal_1": "Need to step away? Type slash remote-control, and the session is shared.",
    "vo_pair": "On the dashboard, pair a device. You get a one-time code.",
    "vo_connect": "On your phone, enter the code, name it, and connect.",
    "vo_session": "Your live session is right there. Follow along, and send Pi a follow-up from your phone.",
    "vo_ask": "When Pi needs a decision, it asks you. Pick an option, and it gets back to work.",
    "vo_automation": "Routine work becomes an automation. Here, a weekday research digest: a schedule, and a Pi step.",
    "vo_runs_0": "Trigger it from anywhere with Run now.",
    "vo_runs_1": "Then check the run history, and read the result.",
    "vo_outro": "Pi Companion. Do things with Pi, from anywhere.",
}


def speak(text: str) -> bytes:
    key = os.environ.get("OPENAI_TOKEN") or os.environ.get("OPENAI_API_KEY")
    if not key:
        raise SystemExit("set OPENAI_TOKEN or OPENAI_API_KEY")
    body = json.dumps({"model": MODEL, "voice": VOICE, "input": text, "instructions": INSTRUCTIONS, "response_format": "wav"})
    request = urllib.request.Request(
        "https://api.openai.com/v1/audio/speech",
        data=body.encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def main() -> None:
    for name, text in LINES.items():
        raw = OUT / f"{name}.raw.wav"
        raw.write_bytes(speak(text))
        # 44.1 kHz mono, leading/trailing silence trimmed, consistent speech loudness.
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af",
                        "silenceremove=start_periods=1:start_threshold=-45dB,areverse,"
                        "silenceremove=start_periods=1:start_threshold=-45dB,areverse,"
                        "loudnorm=I=-16:TP=-2:LRA=7", "-ar", "44100", "-ac", "1", str(OUT / f"{name}.wav")], check=True)
        raw.unlink()
        seconds = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                        str(OUT / f"{name}.wav")], capture_output=True, text=True, check=True).stdout)
        print(f"{name}: {seconds:.2f}s")


if __name__ == "__main__":
    main()
