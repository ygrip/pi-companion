//! Pi Companion promo: a real walkthrough rendered with fframes.
//!
//! The footage is real: `capture/record.mjs` drives an actual Pi session in a terminal and
//! the actual Companion UI in desktop and phone-sized Chromium windows, and `capture/cut.py`
//! cuts it into `clips/` plus `src/cues.rs` (durations, taps and keystrokes in clip time).
//! This file frames the clips (terminal and browser windows, a phone), adds captions, tap
//! and pointer overlays, music and sound effects. Waits are sped up and labelled as such.
use fframes::{
    AudioMap, AudioTimestamp::{Eof, Second}, AudioTrack, Color, Duration, FFramesContext, Frame, Overlap, Scene, Scenes, Svgr,
    FFramesSyncedVideoFrame, SyncVideoFrameInput, Video, include_media_dir,
};

mod cues;

include_media_dir!(pub struct PromoVideoMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;
const FADE: f32 = 0.45;

// Companion dark theme (ui/src/app.css).
const BG: &str = "#0c0c0e";
const SURFACE: &str = "#141417";
const SURFACE3: &str = "#232328";
const BORDER: &str = "#26262c";
const BORDER2: &str = "#35353d";
const TEXT: &str = "#f3f0e9";
const TEXT2: &str = "#b2ada3";
const TEXT3: &str = "#8d897f";
const ACCENT: &str = "#f5b027";
const ACCENT_TEXT: &str = "#f8bf4f";
const SANS: &str = "Inter";
const MONO: &str = "JetBrains Mono";

/// One recorded clip in `clips/` and its cues (generated into `cues.rs`).
#[derive(Debug)]
pub struct Clip {
    pub file: &'static str,
    pub seconds: f32,
    pub width: f32,
    pub height: f32,
    /// (seconds, x, y) of every tap or click, in the recording's CSS pixels.
    pub taps: &'static [(f32, f32, f32)],
    pub keys: &'static [f32],
    /// Sped-up ranges (seconds).
    pub fast: &'static [(f32, f32)],
    pub chimes: &'static [f32],
}

/// Where a clip is shown.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Stage {
    Terminal,
    Browser,
    Phone,
}

/// Phone screen, in video pixels; the recording is 390 CSS px wide.
const PHONE_X: f32 = 1190.0;
const PHONE_Y: f32 = 96.0;
const PHONE_W: f32 = 406.0;
const PHONE_CSS_W: f32 = 390.0;
/// Terminal/browser window content box.
const WIN_X: f32 = 700.0;
const WIN_W: f32 = 1100.0;
const WIN_BAR: f32 = 48.0;
/// Width of the desktop browser viewport in CSS px.
const DESKTOP_CSS_W: f32 = 1440.0;

// ---------------------------------------------------------------------------------------
// Timing helpers. `t` is always seconds since the scene start.

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

/// Ease-out expo from 0 to 1 over `dur` seconds starting at `start`.
fn ramp(t: f32, start: f32, dur: f32) -> f32 {
    let p = clamp01((t - start) / dur);
    if p >= 1.0 { 1.0 } else { 1.0 - 2f32.powf(-10.0 * p) }
}

/// Smooth in-out 0 to 1.
fn smooth(t: f32, start: f32, dur: f32) -> f32 {
    let p = clamp01((t - start) / dur);
    p * p * (3.0 - 2.0 * p)
}

/// Damped spring 0 to 1 with a small overshoot.
fn spring(t: f32, start: f32) -> f32 {
    let x = t - start;
    if x <= 0.0 {
        return 0.0;
    }
    if x > 1.6 {
        return 1.0;
    }
    1.0 - (-6.5 * x).exp() * (11.0 * x).cos()
}

/// Opacity that fades in at `start` and out at `end`.
fn shown(t: f32, start: f32, end: f32) -> f32 {
    ramp(t, start, 0.45) * (1.0 - smooth(t, end, 0.3))
}

fn mix(a: f32, b: f32, p: f32) -> f32 {
    a + (b - a) * p
}

// ---------------------------------------------------------------------------------------
// Shared pieces.

/// Opaque backdrop: theme background, amber grid and a soft glow. Fully static, so cached.
fn backdrop() -> Svgr<'static> {
    fframes::svgr!(<g>
        <defs>
            <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
                <path d="M64 0 H0 V64" fill="none" stroke="#f5b027" stroke-opacity="0.07" stroke-width="1" />
            </pattern>
            <radialGradient id="glow" cx="0.68" cy="0.42" r="0.6">
                <stop offset="0" stop-color="#f5b027" stop-opacity="0.13" />
                <stop offset="1" stop-color="#f5b027" stop-opacity="0" />
            </radialGradient>
            <linearGradient id="vignette" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#0c0c0e" stop-opacity="0" />
                <stop offset="1" stop-color="#0c0c0e" stop-opacity="0.85" />
            </linearGradient>
        </defs>
        <rect width="1920" height="1080" fill="#0c0c0e" />
        <rect width="1920" height="1080" fill="url(#grid)" />
        <rect width="1920" height="1080" fill="url(#glow)" />
        <rect y="700" width="1920" height="380" fill="url(#vignette)" />
    </g>)
}

/// The Pi Companion mark (ui/src/assets/morph/logo.svg), drawn on with `p` in 0..1.
fn logo(x: f32, y: f32, scale: f32, p: f32) -> Svgr<'static> {
    let off = 420.0 * (1.0 - p);
    let moon = spring(p * 1.6, 0.9);
    fframes::svgr!(<g transform={format!("translate({x} {y}) scale({scale})")} fill="none" stroke={ACCENT} stroke-linecap="round" stroke-linejoin="round">
        <path d="M74 104c10-14 26-20 48-20h132" stroke-width="22" stroke-dasharray="420" stroke-dashoffset={off} />
        <path d="M136 88c0 72-12 128-48 160" stroke-width="22" stroke-dasharray="420" stroke-dashoffset={off} />
        <path d="M210 88v116c0 30 12 44 36 44 10 0 20-3 30-9" stroke-width="22" stroke-dasharray="420" stroke-dashoffset={off} />
        <path d="M40 214c34 40 154 30 228-50 26-28 32-52 18-66" stroke-width="9" stroke-opacity="0.7" stroke-dasharray="420" stroke-dashoffset={off} />
        <circle cx="276" cy="86" r={(16.0 * moon).max(0.5)} fill={ACCENT} stroke="none" />
    </g>)
}

/// Brand mark top left of every content scene.
fn brand() -> Svgr<'static> {
    fframes::svgr!(<g>
        <g transform="translate(150 70) scale(0.14)" fill="none" stroke="#f5b027" stroke-linecap="round" stroke-linejoin="round">
            <path d="M74 104c10-14 26-20 48-20h132" stroke-width="26" />
            <path d="M136 88c0 72-12 128-48 160" stroke-width="26" />
            <path d="M210 88v116c0 30 12 44 36 44 10 0 20-3 30-9" stroke-width="26" />
            <circle cx="276" cy="86" r="18" fill="#f5b027" stroke="none" />
        </g>
        <text x="206" y="104" font-family="Inter" font-size="26" font-weight="600" fill="#f3f0e9">"Pi Companion"</text>
    </g>)
}

/// Step label, two-line headline and two-line body on the left column.
fn caption(t: f32, start: f32, end: f32, step: &str, head: [&str; 2], body: [&str; 2]) -> Svgr<'static> {
    let item = |delay: f32| {
        let o = shown(t, start + delay, end);
        let dy = (1.0 - ramp(t, start + delay, 0.7)) * 36.0 - smooth(t, end, 0.3) * 18.0;
        (o, dy)
    };
    let (o0, d0) = item(0.0);
    let (o1, d1) = item(0.08);
    let (o2, d2) = item(0.16);
    let (o3, d3) = item(0.3);
    let step_w = step.len() as f32 * 13.8 + 40.0;
    fframes::svgr!(<g font-family={SANS}>
        <g opacity={o0} transform={format!("translate(0 {d0})")}>
            <rect x="150" y="318" width={step_w} height="44" rx="22" fill="#f5b027" fill-opacity="0.12" stroke="#f5b027" stroke-opacity="0.38" />
            <text x="170" y="347" font-family={MONO} font-size="22" font-weight="700" letter-spacing="1" fill={ACCENT_TEXT}>{step.to_string()}</text>
        </g>
        <text opacity={o1} transform={format!("translate(0 {d1})")} x="147" y="450" font-size="62" font-weight="700" letter-spacing="-1.5" fill={TEXT}>{head[0].to_string()}</text>
        <text opacity={o2} transform={format!("translate(0 {d2})")} x="147" y="526" font-size="62" font-weight="700" letter-spacing="-1.5" fill={ACCENT}>{head[1].to_string()}</text>
        <g opacity={o3} transform={format!("translate(0 {d3})")} font-size="30" font-weight="400" fill={TEXT2}>
            <text x="150" y="608">{body[0].to_string()}</text>
            <text x="150" y="652">{body[1].to_string()}</text>
        </g>
    </g>)
}

/// Desktop mouse pointer. `press` (0..1) shrinks it while clicking.
fn pointer(x: f32, y: f32, press: f32) -> Svgr<'static> {
    let s = 1.0 - 0.15 * press;
    fframes::svgr!(<g transform={format!("translate({x} {y}) scale({s})")}>
        <path d="M0 0 L0 34 L9 26 L15 40 L21 37 L15 24 L27 24 Z" fill="#ffffff" stroke="#0c0c0e" stroke-width="2.5" stroke-linejoin="round" />
    </g>)
}

/// Click ripple at (x, y) starting at `at`.
fn ripple(t: f32, at: f32, x: f32, y: f32) -> Svgr<'static> {
    let p = clamp01((t - at) / 0.55);
    if p <= 0.0 || p >= 1.0 {
        return Svgr::empty();
    }
    let r = 10.0 + 34.0 * ramp(t, at, 0.55);
    fframes::svgr!(<circle cx={x} cy={y} r={r} fill="none" stroke="#f5b027" stroke-width="3" opacity={1.0 - p} />)
}

/// A finger tap on the phone screen: a soft dot that presses and a ripple.
fn tap(t: f32, at: f32, x: f32, y: f32) -> Svgr<'static> {
    let o = shown(t, at - 0.45, at + 0.25);
    if o <= 0.0 {
        return Svgr::empty();
    }
    let press = 1.0 - 0.18 * (smooth(t, at - 0.1, 0.1) * (1.0 - smooth(t, at + 0.05, 0.15)));
    fframes::svgr!(<g>
        <circle cx={x} cy={y} r={26.0 * press} fill="#ffffff" fill-opacity="0.22" stroke="#ffffff" stroke-opacity="0.6" stroke-width="2" opacity={o} />
        {ripple(t, at, x, y)}
    </g>)
}

/// Window chrome for desktop mockups.
fn window(x: f32, y: f32, w: f32, h: f32, title: &str, url: bool) -> Svgr<'static> {
    let bar = if url {
        fframes::svgr!(<g>
            <rect x={x + w / 2.0 - 190.0} y={y + 10.0} width="380" height="28" rx="8" fill={SURFACE3} />
            <text x={x + w / 2.0} y={y + 30.0} text-anchor="middle" font-family={SANS} font-size="16" fill={TEXT2}>{title.to_string()}</text>
        </g>)
    } else {
        fframes::svgr!(<text x={x + w / 2.0} y={y + 30.0} text-anchor="middle" font-family={MONO} font-size="16" fill={TEXT3}>{title.to_string()}</text>)
    };
    fframes::svgr!(<g>
        <rect x={x + 6.0} y={y + 24.0} width={w - 12.0} height={h} rx="18" fill="#000000" opacity="0.45" />
        <rect x={x} y={y} width={w} height={h} rx="16" fill={SURFACE} stroke={BORDER2} />
        <path d={format!("M{x} {} H{}", y + 48.0, x + w)} stroke={BORDER} />
        <circle cx={x + 26.0} cy={y + 24.0} r="7" fill="#ff5f57" />
        <circle cx={x + 50.0} cy={y + 24.0} r="7" fill="#febc2e" />
        <circle cx={x + 74.0} cy={y + 24.0} r="7" fill="#28c840" />
        {bar}
    </g>)
}

fn intro(t: f32) -> Svgr<'static> {
    let draw = smooth(t, 0.15, 1.3);
    let o1 = ramp(t, 0.9, 0.6);
    let d1 = (1.0 - ramp(t, 0.9, 0.8)) * 40.0;
    let o2 = ramp(t, 1.15, 0.6);
    let d2 = (1.0 - ramp(t, 1.15, 0.8)) * 30.0;
    let breathe = 1.0 + 0.015 * (t * 1.4).sin();
    fframes::svgr!(<g font-family={SANS}>
        <g transform={format!("translate(960 300) scale({breathe}) translate(-960 -300)")}>
            {logo(784.0, 130.0, 1.1, draw)}
        </g>
        <text opacity={o1} transform={format!("translate(0 {d1})")} x="960" y="650" text-anchor="middle" font-size="128" font-weight="700" letter-spacing="-4" fill={TEXT}>"Pi Companion"</text>
        <text opacity={o2} transform={format!("translate(0 {d2})")} x="960" y="736" text-anchor="middle" font-size="44" font-weight="400" fill={TEXT2}>"Your Pi sessions, on every device."</text>
    </g>)
}

fn outro(t: f32) -> Svgr<'static> {
    let o1 = ramp(t, 0.35, 0.6);
    let d1 = (1.0 - ramp(t, 0.35, 0.8)) * 40.0;
    let o2 = ramp(t, 0.55, 0.6);
    let d2 = (1.0 - ramp(t, 0.55, 0.8)) * 40.0;
    let o3 = ramp(t, 1.1, 0.6);
    let o4 = ramp(t, 1.5, 0.6);
    fframes::svgr!(<g font-family={SANS}>
        {logo(904.0, 150.0, 0.36, smooth(t, 0.0, 0.9))}
        <text opacity={o1} transform={format!("translate(0 {d1})")} x="960" y="420" text-anchor="middle" font-size="112" font-weight="700" letter-spacing="-3" fill={TEXT}>"Do things with Pi."</text>
        <text opacity={o2} transform={format!("translate(0 {d2})")} x="960" y="545" text-anchor="middle" font-size="112" font-weight="700" letter-spacing="-3" fill={ACCENT}>"From anywhere."</text>
        <g opacity={o3}>
            <rect x="500" y="626" width="920" height="84" rx="20" fill={SURFACE} stroke={BORDER2} />
            <text x="960" y="680" text-anchor="middle" font-family={MONO} font-size="34" fill={TEXT}><tspan fill={TEXT3}>"$ "</tspan>"pi install npm:@yunazgr/pi-companion"</text>
        </g>
        <text opacity={o4} x="960" y="790" text-anchor="middle" font-size="32" fill={TEXT2}>"Then type "<tspan font-family={MONO} fill={ACCENT_TEXT}>"/remote-control"</tspan>" in any Pi session."</text>
        <text opacity={o4} x="960" y="960" text-anchor="middle" font-family={MONO} font-size="24" fill={TEXT3}>"github.com/ygrip/pi-companion"</text>
    </g>)
}

// ---------------------------------------------------------------------------------------
// Framing the footage.

/// The clip's frame for scene time `t`, drawn at (x, y) with width `w`.
fn footage(frame: &Frame, ctx: &FFramesContext, clip: &Clip, x: f32, y: f32, w: f32) -> Svgr<'static> {
    let h = w * clip.height / clip.width;
    let input = SyncVideoFrameInput { start_from: 0.0, looping: false, editor_fallback_image: None };
    let Some(video) = frame.get_synced_video_frame(ctx, clip.file, &input) else {
        return fframes::svgr!(<rect x={x} y={y} width={w} height={h} fill={BG} />);
    };
    let image = video.into_image();
    fframes::svgr!(<image href={image.href()} x={x} y={y} width={w} height={h} preserveAspectRatio="none" />)
}

/// Phone bezel around a screen of `w` x `h` at (x, y).
fn phone_bezel(x: f32, y: f32, w: f32, h: f32, screen: Svgr<'static>) -> Svgr<'static> {
    let r = 50.0;
    fframes::svgr!(<g>
        <rect x={x - 16.0} y={y - 16.0} width={w + 32.0} height={h + 32.0} rx={r + 14.0} fill="#050506" stroke="#3a3a42" stroke-width="2" />
        <clipPath id="phone-screen"><rect x={x} y={y} width={w} height={h} rx={r} /></clipPath>
        <g clip-path="url(#phone-screen)">
            <rect x={x} y={y} width={w} height={h} fill={BG} />
            {screen}
        </g>
        <rect x={x + w / 2.0 - 58.0} y={y + 10.0} width="116" height="30" rx="15" fill="#050506" />
    </g>)
}

/// "Sped up" badge centred at (cx, y) while `t` is inside a fast range.
fn fast_badge(t: f32, clip: &Clip, cx: f32, y: f32, label: &'static str) -> Svgr<'static> {
    let o = clip.fast.iter().map(|&(a, b)| shown(t, a - 0.2, b - 0.1)).fold(0.0, f32::max);
    if o <= 0.0 {
        return Svgr::empty();
    }
    let w = 330.0;
    let x = cx - w / 2.0;
    fframes::svgr!(<g opacity={o}>
        <rect x={x} y={y} width={w} height="46" rx="23" fill="#1b1303" fill-opacity="0.92" stroke={ACCENT} stroke-opacity="0.6" />
        <path d={format!("M{} {} l12 9 l-12 9 z M{} {} l12 9 l-12 9 z", x + 22.0, y + 14.0, x + 36.0, y + 14.0)} fill={ACCENT} />
        <text x={x + 62.0} y={y + 30.0} font-family={SANS} font-size="19" font-weight="600" fill={ACCENT_TEXT}>{label}</text>
    </g>)
}

/// Desktop pointer gliding between the recorded clicks; `s` maps CSS px to video px.
fn desktop_pointer(t: f32, clip: &Clip, ox: f32, oy: f32, s: f32) -> Svgr<'static> {
    let (mut px, mut py) = (DESKTOP_CSS_W * 0.62, 760.0);
    for &(at, x, y) in clip.taps {
        let p = smooth(t, at - 0.7, 0.6);
        px = mix(px, x, p);
        py = mix(py, y, p);
    }
    let press = clip.taps.iter().map(|&(at, _, _)| smooth(t, at - 0.08, 0.08) * (1.0 - smooth(t, at + 0.05, 0.15))).fold(0.0, f32::max);
    let ripples: Vec<Svgr> = clip.taps.iter().map(|&(at, x, y)| ripple(t, at, ox + x * s, oy + y * s)).collect();
    fframes::svgr!(<g>
        {ripples}
        {pointer(ox + px * s, oy + py * s, press)}
    </g>)
}

const TERMINAL: Captions = Captions {
    step: "01  START A SESSION",
    head: ["A real Pi session.", "Then share it."],
    body: ["Pi fixes a bug in the terminal,", "then /remote-control shares it."],
};

#[derive(Debug, Clone, Copy)]
struct Captions {
    step: &'static str,
    head: [&'static str; 2],
    body: [&'static str; 2],
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Intro,
    Clip,
    Outro,
}

#[derive(Debug)]
pub struct Shot {
    kind: Kind,
    name: &'static str,
    clip: Option<&'static Clip>,
    stage: Stage,
    captions: Captions,
    fast_label: &'static str,
    secs: f32,
}

impl Shot {
    fn clip(name: &'static str, clip: &'static Clip, stage: Stage, captions: Captions, fast_label: &'static str) -> Self {
        // The scene ends with its clip; the next scene cross-fades over the clip's tail.
        Shot { kind: Kind::Clip, name, clip: Some(clip), stage, captions, fast_label, secs: clip.seconds - FADE }
    }

    fn card(kind: Kind, name: &'static str, secs: f32) -> Self {
        Shot { kind, name, clip: None, stage: Stage::Terminal, captions: TERMINAL, fast_label: "", secs }
    }
}

impl Scene for Shot {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.secs)
    }

    fn overlap(&self) -> Overlap {
        if self.kind == Kind::Intro { Overlap::None } else { Overlap::Previous(FADE) }
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::from(sounds(self))
    }

    fn name(&self) -> &'static str {
        self.name
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let content = match (self.kind, self.clip) {
            (Kind::Intro, _) => intro(t),
            (Kind::Outro, _) => outro(t),
            (Kind::Clip, Some(clip)) => clip_scene(&frame, ctx, t, self, clip),
            (Kind::Clip, None) => Svgr::empty(),
        };
        let fade_in = if self.kind == Kind::Intro { 1.0 } else { smooth(t, 0.0, FADE) };
        let chrome = if self.kind == Kind::Clip { brand() } else { Svgr::empty() };
        fframes::svgr!(<g opacity={fade_in}>
            {backdrop()}
            {chrome}
            {content}
        </g>)
    }
}

fn clip_scene(frame: &Frame, ctx: &FFramesContext, t: f32, shot: &Shot, clip: &'static Clip) -> Svgr<'static> {
    let c = shot.captions;
    let words = caption(t, 0.2, 999.0, c.step, c.head, c.body);
    // Footage eases in: a slight rise and scale.
    let rise = (1.0 - spring(t, 0.05)) * 40.0;
    let media = match shot.stage {
        Stage::Phone => {
            let h = PHONE_W * clip.height / clip.width;
            let s = PHONE_W / PHONE_CSS_W;
            let taps: Vec<Svgr> = clip.taps.iter().map(|&(at, x, y)| tap(t, at, PHONE_X + x * s, PHONE_Y + y * s)).collect();
            let screen = fframes::svgr!(<g>
                {footage(frame, ctx, clip, PHONE_X, PHONE_Y, PHONE_W)}
                {taps}
            </g>);
            fframes::svgr!(<g transform={format!("translate(0 {rise})")}>
                {phone_bezel(PHONE_X, PHONE_Y, PHONE_W, h, screen)}
                {fast_badge(t, clip, PHONE_X + PHONE_W / 2.0, PHONE_Y + h - 150.0, shot.fast_label)}
            </g>)
        }
        Stage::Terminal | Stage::Browser => {
            let h = WIN_W * clip.height / clip.width;
            let y = ((HEIGHT as f32 - h - WIN_BAR) / 2.0).max(60.0) - 10.0;
            let (title, url) = if shot.stage == Stage::Terminal { ("zsh — ~/pi-demo/mobile-app", false) } else { ("localhost:43721", true) };
            let pointer = if shot.stage == Stage::Browser {
                desktop_pointer(t, clip, WIN_X, y + WIN_BAR, WIN_W / DESKTOP_CSS_W)
            } else {
                Svgr::empty()
            };
            fframes::svgr!(<g transform={format!("translate(0 {rise})")}>
                {window(WIN_X, y, WIN_W, h + WIN_BAR, title, url)}
                <clipPath id="win-content"><rect x={WIN_X} y={y + WIN_BAR} width={WIN_W} height={h} rx="0" /></clipPath>
                <g clip-path="url(#win-content)">{footage(frame, ctx, clip, WIN_X, y + WIN_BAR, WIN_W)}</g>
                <rect x={WIN_X} y={y} width={WIN_W} height={h + WIN_BAR} rx="16" fill="none" stroke={BORDER2} />
                {pointer}
                {fast_badge(t, clip, WIN_X + WIN_W / 2.0, y + h - 30.0, shot.fast_label)}
            </g>)
        }
    };
    fframes::svgr!(<g>
        {words}
        {media}
    </g>)
}

// ---------------------------------------------------------------------------------------
// Sound. All files are synthesized by `audio/generate.py`; times come from the recorded cues.

/// Level of every effect relative to the gains below (one knob for the SFX bus).
const SFX_DB: f32 = 5.0;

fn sfx(file: &'static str, at: f32, gain_db: f32) -> AudioTrack<'static> {
    AudioTrack::new(file, Second(at.max(0.0))..Eof).gain_db(gain_db + SFX_DB)
}

/// Every sound of one scene, relative to the scene start (cross-fade included).
fn sounds(shot: &Shot) -> Vec<AudioTrack<'static>> {
    const KEYS: [&str; 3] = ["key0.wav", "key1.wav", "key2.wav"];
    let mut out = Vec::new();
    match (shot.kind, shot.clip) {
        (Kind::Intro, _) => out.push(sfx("shimmer.wav", 0.85, -10.0)),
        (Kind::Outro, _) => {
            out.push(sfx("whoosh.wav", 0.0, -16.0));
            out.push(sfx("shimmer.wav", 0.3, -10.0));
        }
        (Kind::Clip, Some(clip)) => {
            out.push(sfx("whoosh.wav", 0.0, -16.0));
            out.extend(clip.taps.iter().map(|&(at, _, _)| sfx("tap.wav", at, -9.0)));
            out.extend(clip.keys.iter().enumerate().map(|(i, &at)| sfx(KEYS[i % 3], at, -17.0 - (i % 2) as f32 * 2.0)));
            out.extend(clip.chimes.iter().map(|&at| sfx("chime.wav", at, -9.0)));
            if shot.name == "Ask" {
                out.push(sfx("ping.wav", 0.15, -9.0));
            }
        }
        (Kind::Clip, None) => {}
    }
    out.extend(voice(shot.name).iter().map(|&(file, at)| AudioTrack::new(file, Second(at)..Eof).gain_db(NARRATION_DB)));
    out
}

/// Narration level; the lines are normalized to -16 LUFS by `audio/voiceover.py`.
const NARRATION_DB: f32 = 0.0;

/// Narration lines of a scene (`audio/voiceover.py` has the text) and their start times.
/// Each line ends before its scene does and lands on the moment it describes.
fn voice(scene: &str) -> &'static [(&'static str, f32)] {
    match scene {
        "Intro" => &[("vo_intro.wav", 1.0)],
        "Terminal" => &[("vo_terminal_0.wav", 0.8), ("vo_terminal_1.wav", 13.2)],
        "Pair" => &[("vo_pair.wav", 0.5)],
        "Connect" => &[("vo_connect.wav", 0.4)],
        "Session" => &[("vo_session.wav", 0.6)],
        "Ask" => &[("vo_ask.wav", 0.5)],
        "Automation" => &[("vo_automation.wav", 0.6)],
        "Runs" => &[("vo_runs_0.wav", 4.4), ("vo_runs_1.wav", 12.2)],
        "Outro" => &[("vo_outro.wav", 0.5)],
        _ => &[],
    }
}

const DESKTOP_PAIR: Captions = Captions {
    step: "02  PAIR A DEVICE",
    head: ["On the dashboard,", "pair your phone."],
    body: ["Pair a device shows a", "one-time code and a QR."],
};
const PHONE_PAIR: Captions = Captions {
    step: "03  CONNECT",
    head: ["Enter the code", "on your phone."],
    body: ["Name the device, tap Connect.", "No account, no cloud relay."],
};
const PHONE_SESSION: Captions = Captions {
    step: "04  INSPECT",
    head: ["Your live session,", "in your pocket."],
    body: ["Open the shared session and", "send Pi a follow-up prompt."],
};
const PHONE_ASK: Captions = Captions {
    step: "05  ANSWER",
    head: ["Pi asks.", "You pick."],
    body: ["Questions arrive as options.", "Tap one; Pi carries on."],
};
const DESKTOP_AUTOMATION: Captions = Captions {
    step: "06  AUTOMATE",
    head: ["Schedule the", "routine work."],
    body: ["A weekday research digest:", "cron schedule plus a Pi step."],
};
const PHONE_AUTOMATION: Captions = Captions {
    step: "07  RUN IT",
    head: ["Trigger it anywhere.", "Read the result."],
    body: ["Run now from the phone, then", "check the run history and report."],
};

// ---------------------------------------------------------------------------------------

pub struct PromoVideoVideo<'a> {
    pub media: &'a PromoVideoMedia,
    shots: Vec<Shot>,
}

impl<'a> PromoVideoVideo<'a> {
    pub fn new(media: &'a PromoVideoMedia) -> Self {
        let shots = vec![
            Shot::card(Kind::Intro, "Intro", 3.6),
            Shot::clip("Terminal", &cues::TERMINAL, Stage::Terminal, TERMINAL, "Pi working · sped up"),
            Shot::clip("Pair", &cues::DESKTOP_PAIR, Stage::Browser, DESKTOP_PAIR, ""),
            Shot::clip("Connect", &cues::PHONE_PAIR, Stage::Phone, PHONE_PAIR, ""),
            Shot::clip("Session", &cues::PHONE_SESSION, Stage::Phone, PHONE_SESSION, ""),
            Shot::clip("Ask", &cues::PHONE_ASK, Stage::Phone, PHONE_ASK, "Pi working · sped up"),
            Shot::clip("Automation", &cues::DESKTOP_AUTOMATION, Stage::Browser, DESKTOP_AUTOMATION, ""),
            Shot::clip("Runs", &cues::PHONE_AUTOMATION, Stage::Phone, PHONE_AUTOMATION, "Running · sped up"),
            Shot::card(Kind::Outro, "Outro", 5.8),
        ];
        Self { media, shots }
    }

    fn total(&self) -> f32 {
        self.shots.iter().map(|s| s.secs).sum()
    }
}

impl std::fmt::Debug for PromoVideoVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PromoVideoVideo").finish()
    }
}

impl Video for PromoVideoVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn audio(&self) -> AudioMap<'_> {
        let end = self.total();
        AudioMap::from(vec![
            // Music sits under the narration.
            AudioTrack::new("music.mp3", Second(0.0)..Second(end)).gain_db(-9.0).fade_in(1.0).fade_out(3.0),
        ])
    }

    fn define_scenes(&self) -> Scenes<'_> {
        Scenes::from(self.shots.iter().map(|s| s as &dyn Scene).collect::<Vec<_>>())
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let progress = (frame.seconds() / self.total() * 1620.0).max(0.5);
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width={WIDTH} height={HEIGHT} viewBox="0 0 1920 1080">
                <rect width="1920" height="1080" fill={BG} />
                {ctx.render_scenes(&frame)}
                <rect x="150" y="1040" width="1620" height="3" rx="1.5" fill="#ffffff" fill-opacity="0.08" />
                <rect x="150" y="1040" width={progress} height="3" rx="1.5" fill={ACCENT} />
            </svg>
        )
    }
}
