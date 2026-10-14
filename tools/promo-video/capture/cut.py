#!/usr/bin/env python3
"""Cut the recorded footage into the clips the video plays.

Reads tools/promo-video/captures/ (from record.mjs) and writes tools/promo-video/clips/*.mp4
plus src/cues.rs: per clip its duration and the taps, clicks and keystrokes in clip time,
so overlays and sound effects land on the real interactions.

Every clip is a list of wall-clock pieces. Pieces play at 1x unless they are waits (Pi
thinking, an automation running), which are sped up and marked "fast" in the video.

    python3 tools/promo-video/capture/cut.py
"""
import json
import subprocess
from bisect import bisect_right
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CAP = ROOT / "captures"
CLIPS = ROOT / "clips"
FPS = 30
IDLE = 1.49  # speed for idle UI gaps; below the 1.5 threshold that marks a range "sped up"

events = json.loads((CAP / "events.json").read_text())["events"]


def at(name: str, nth: int = 0) -> float:
    """Wall-clock seconds of the nth event called `name`."""
    hits = [e for e in events if e["name"] == name]
    return hits[nth]["at"] / 1000


def tap_at(source: str, label: str) -> float:
    return next(e for e in events if e["name"] == f"{source}.tap" and e["label"] == label)["at"] / 1000


class Source:
    """Frames of one recording, looked up by wall-clock time."""

    def __init__(self, files: list[Path], times: list[float], size: tuple[int, int], outputs=()):
        self.files, self.times, self.size = files, times, size
        self.outputs = list(outputs)  # wall-clock times of terminal output (keystroke echoes)

    @staticmethod
    def screencast(name: str) -> "Source":
        meta = json.loads((CAP / name / "frames.json").read_text())
        frames = meta["frames"]
        return Source([CAP / name / f["file"] for f in frames], [f["at"] / 1000 for f in frames], (meta["width"], meta["height"]))

    def frame(self, wall: float) -> Path:
        return self.files[max(0, bisect_right(self.times, wall) - 1)]


def terminal_source() -> Source:
    """Render the asciinema cast with agg and align it to wall-clock time."""
    cast = CAP / "terminal.cast"
    lines = cast.read_text().splitlines()
    header = json.loads(lines[0])
    gif = CAP / "terminal.gif"
    subprocess.run(["agg", "--font-family", "JetBrains Mono", "--font-size", "30", "--line-height", "1.3",
                    "--theme", "0c0c0e,f3f0e9,1b1b1f,f0756b,4fc58c,f5b027,6aa8ff,c792ea,5fd7d7,b2ada3,"
                    "5c5c66,ff8b80,6ee0a6,ffc247,8dbbff,d6a6ff,7fe5e5,f3f0e9",
                    "--idle-time-limit", "1000", "--fps-cap", "30", "--last-frame-duration", "1", str(cast), str(gif)], check=True)
    frames = CAP / "terminal"
    frames.mkdir(exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(gif), "-vf", "fps=30", "-q:v", "2", str(frames / "%06d.jpg")], check=True)
    files = sorted(frames.glob("*.jpg"))
    # Cast times are relative to its start; anchor on the "Remote control enabled" output,
    # which appears just before the daemon reports the session as shared.
    t = 0.0
    anchor = None
    outputs = []
    for line in lines[1:]:
        if not line.startswith("["):
            continue
        ev = json.loads(line)
        t = ev[0] if header.get("version") == 2 else t + ev[0]
        if ev[1] == "o":
            outputs.append(t)
            if anchor is None and "Remote control enabled" in ev[2]:
                anchor = t
    if anchor is None:
        raise SystemExit("could not find the remote-control output in the cast")
    origin = at("terminal.shared") - 0.15 - anchor
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height",
                            "-of", "csv=p=0", str(files[0])], capture_output=True, text=True, check=True).stdout.strip()
    w, h = map(int, probe.split(","))
    return Source(files, [origin + i / FPS for i in range(len(files))], (w, h), [origin + o for o in outputs])


def cut(name: str, source: Source, pieces, kinds=("tap", "type"), key_walls=(), chimes=()) -> dict:
    """Write clips/<name>.mp4 from (start, end, speed) wall-clock pieces; return its cues."""
    walls = []  # wall-clock time of every output frame
    for start, end, speed in pieces:
        n = int(round((end - start) / speed * FPS))
        walls += [start + i * speed / FPS for i in range(n)]
    w, h = source.size
    w, h = w - w % 2, h - h % 2
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "-",
                           "-vf", f"scale={w}:{h}:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-preset", "slow",
                           "-tune", "animation", str(CLIPS / f"{name}.mp4")], stdin=subprocess.PIPE)
    for wall in walls:
        ff.stdin.write(source.frame(wall).read_bytes())
    ff.stdin.close()
    if ff.wait():
        raise SystemExit(f"ffmpeg failed for {name}")

    def clip_time(wall: float):
        t = 0.0
        for start, end, speed in pieces:
            if start <= wall < end:
                return t + (wall - start) / speed
            t += (end - start) / speed
        return None

    fast = []
    t = 0.0
    for start, end, speed in pieces:
        if speed > 1.5:
            fast.append((round(t, 3), round(t + (end - start) / speed, 3)))
        t += (end - start) / speed
    prefix = name.split("_")[0]
    taps, keys = [], []
    for e in events:
        if not e["name"].startswith(prefix + "."):
            continue
        ct = clip_time(e["at"] / 1000)
        if ct is None:
            continue
        if e["name"].endswith(".tap") and "tap" in kinds:
            taps.append((round(ct, 3), e["x"], e["y"]))
        if e["name"].endswith(".type") and "type" in kinds:
            delay = e.get("delay") or {"Pairing code": 0.14, "Message": 0.045, "Automation name": 0.055, "Cron expression": 0.09, "Pi step": 0.012}.get(e["label"], 0.07)
            for i, ch in enumerate(e["text"]):
                kt = clip_time(e["at"] / 1000 + i * delay)
                if kt is not None and ch != " ":
                    keys.append(round(kt, 3))
    for wall in key_walls:
        kt = clip_time(wall)
        if kt is not None:
            keys.append(round(kt, 3))
    keys.sort()
    thinned = []
    for k in keys:  # fast typing would sound like a buzz
        if not thinned or k - thinned[-1] >= 0.065:
            thinned.append(k)
    chime_times = [round(c, 3) for c in (clip_time(w) for w in chimes) if c is not None]
    return {"name": name, "chimes": chime_times, "seconds": round(len(walls) / FPS, 3), "size": [w, h], "taps": taps, "keys": thinned, "fast": fast}


def main() -> None:
    CLIPS.mkdir(exist_ok=True)
    desktop = Source.screencast("desktop")
    phone = Source.screencast("phone")
    term = terminal_source()
    clips = []

    # Terminal: start Pi, give it the task, let it work (fast), then /remote-control.
    t_pi, t_prompt, t_done, t_shared = at("terminal.pi"), at("terminal.prompt"), at("terminal.done"), at("terminal.shared")
    typing = t_prompt - 0.3 - 103 / 22
    t_remote = at("terminal.remote")
    windows = [(t_pi - 0.6, t_pi - 0.02), (typing - 0.3, t_prompt - 0.25), (t_remote - 0.6 - 15 / 10 * 1.3, t_remote - 0.45)]
    echoes = []
    for wall in term.outputs:
        if any(a <= wall <= b for a, b in windows) and (not echoes or wall - echoes[-1] > 0.03):
            echoes.append(wall)
    clips.append(cut("terminal", term, [(t_pi - 0.8, t_pi + 1.6, 1), (typing - 0.6, t_prompt + 2.5, 1),
                                         (t_prompt + 2.5, t_done - 1.5, max(1.0, (t_done - 4 - t_prompt) / 4.0)), (t_done - 1.5, t_shared + 3.0, 1)],
                     kinds=(), key_walls=echoes, chimes=[t_shared - 0.2]))
    # Dashboard: Devices, Pair a device, the code.
    clips.append(cut("desktop_pair", desktop, [(at("desktop.overview") + 0.6, at("phone.pair"), 1)]))
    # Phone: enter the code and connect.
    clips.append(cut("phone_pair", phone, [(at("phone.pair") - 0.3, at("phone.paired") + 2.2, 1)], chimes=[at("phone.paired") + 0.5]))
    # Phone: open the session and send a prompt; Pi works (fast) and asks; answer.
    # Idle UI gaps (waiting to start typing or tapping) play at IDLE speed without a badge.
    t_open, t_sess, t_msg = tap_at("phone", "Sessions"), at("phone.session"), tap_at("phone", "Message")
    t_sent, t_ask, t_answered, t_idle = at("phone.sent"), at("phone.ask"), at("phone.answered"), at("phone.idle")
    clips.append(cut("phone_session", phone, [(t_open - 0.5, t_sess + 1.2, 1), (t_sess + 1.2, t_msg - 0.6, IDLE), (t_msg - 0.6, t_sent + 1.5, 1),
                                              (t_sent + 1.5, t_ask - 0.2, max(1.0, (t_ask - t_sent - 1.7) / 2.0))]))
    work = max(1.0, (t_idle - t_answered - 2.0) / 4.0)
    clips.append(cut("phone_ask", phone, [(t_ask - 0.2, t_answered + 2.0, 1), (t_answered + 2.0, t_idle, work), (t_idle, t_idle + 2.5, 1)], chimes=[t_idle]))
    # Dashboard: create the automation.
    t_auto, t_saved = tap_at("desktop", "Automations"), at("desktop.saved")
    clips.append(cut("desktop_automation", desktop, [(t_auto - 0.6, t_saved + 2.5, 1)], chimes=[t_saved + 0.3]))
    # Phone: open it, Run now, the run finishes (fast), open the result.
    t_list, t_open_auto, t_run, t_done_run, t_end = tap_at("phone", "Automations"), at("phone.automation"), at("phone.run"), at("phone.run.done"), at("phone.result") + 4.0
    clips.append(cut("phone_automation", phone, [(t_list - 0.5, t_open_auto + 1.0, 1), (t_open_auto + 1.0, t_run - 0.6, IDLE), (t_run - 0.6, t_run + 2.5, 1),
                                                 (t_run + 2.5, t_done_run, max(1.0, (t_done_run - t_run - 2.5) / 3.0)),
                                                 (t_done_run, t_end, 1)], chimes=[t_done_run]))
    write_cues(clips)
    print("\n".join(f'{c["name"]}: {c["seconds"]:.1f}s, {len(c["taps"])} taps, {len(c["keys"])} keys, fast {c["fast"]}' for c in clips))


def write_cues(clips) -> None:
    lines = ["// Generated by capture/cut.py from the recorded footage. Do not edit.", "use crate::Clip;", ""]
    for c in clips:
        taps = ", ".join(f"({t}, {x}.0, {y}.0)" for t, x, y in c["taps"])
        keys = ", ".join(str(k) for k in c["keys"])
        fast = ", ".join(f"({a}, {b})" for a, b in c["fast"])
        chimes = ", ".join(str(x) for x in c["chimes"])
        lines.append(f'pub const {c["name"].upper()}: Clip = Clip {{ file: "{c["name"]}.mp4", seconds: {c["seconds"]}, width: {c["size"][0]}.0, height: {c["size"][1]}.0, '
                     f"taps: &[{taps}], keys: &[{keys}], fast: &[{fast}], chimes: &[{chimes}] }};")
    (ROOT / "src" / "cues.rs").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
