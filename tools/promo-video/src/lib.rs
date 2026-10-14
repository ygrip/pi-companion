//! Pi Companion promo: a ~70 s product walkthrough rendered with fframes.
//!
//! Story: start a Pi session in the terminal, share it with `/remote-control`, pair a phone
//! from the dashboard, enter the code on the phone, inspect the session and send a prompt,
//! answer Pi's multiple-choice question, create a research automation, then trigger it and
//! review its run history.
//!
//! Every UI is drawn as vector mockups in the Companion dark theme (colors from
//! `ui/src/app.css`); content is demo data, not real sessions.
use fframes::{
    AudioMap, Color, Duration, FFramesContext, FontQuery, Frame, Overlap, Scene, Scenes, Svgr,
    Video, include_media_dir,
};

include_media_dir!(pub struct PromoVideoMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;
const FADE: f32 = 0.45;

// Companion dark theme (ui/src/app.css).
const BG: &str = "#0c0c0e";
const SURFACE: &str = "#141417";
const SURFACE2: &str = "#1b1b1f";
const SURFACE3: &str = "#232328";
const BORDER: &str = "#26262c";
const BORDER2: &str = "#35353d";
const TEXT: &str = "#f3f0e9";
const TEXT2: &str = "#b2ada3";
const TEXT3: &str = "#8d897f";
const ACCENT: &str = "#f5b027";
const ACCENT_TEXT: &str = "#f8bf4f";
const ACCENT_INK: &str = "#1b1303";
const OK: &str = "#4fc58c";
const DANGER: &str = "#f0756b";
const SANS: &str = "Inter";
const MONO: &str = "JetBrains Mono";

// Phone screen geometry (screen coordinates inside the bezel).
const PHONE_X: f32 = 1180.0;
const PHONE_Y: f32 = 92.0;

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

/// The first characters of `text`, typed at `cps` characters per second from `start`.
fn typed(text: &'static str, t: f32, start: f32, cps: f32) -> &'static str {
    let n = ((t - start) * cps).max(0.0) as usize;
    let end = text.char_indices().nth(n).map_or(text.len(), |(i, _)| i);
    &text[..end]
}

fn typing_done(text: &str, start: f32, cps: f32) -> f32 {
    start + text.chars().count() as f32 / cps
}

fn blink(t: f32) -> f32 {
    if (t * 2.2).fract() < 0.55 { 1.0 } else { 0.0 }
}

fn text_w<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, family: &'static str, size: usize, weight: u16, text: &'a str) -> f32 {
    if text.is_empty() {
        return 0.0;
    }
    let font = FontQuery { family, size, weight, ..Default::default() };
    frame.text_width(ctx, font, text).map(|w| w as f32).unwrap_or(text.len() as f32 * size as f32 * 0.55)
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

/// Phone frame at `(x, y)` (screen origin) with clipped `screen` content.
fn phone(id: &str, x: f32, y: f32, screen: Svgr<'static>) -> Svgr<'static> {
    let clip = format!("url(#{id})");
    fframes::svgr!(<g transform={format!("translate({x} {y})")}>
        <rect x="-14" y="-14" width="448" height="908" rx="64" fill="#050506" stroke="#3a3a42" stroke-width="2" />
        <rect x="-8" y="-8" width="436" height="896" rx="58" fill="none" stroke="#1d1d22" stroke-width="2" />
        <clipPath id={id.to_string()}>
            <rect width="420" height="880" rx="50" />
        </clipPath>
        <g clip-path={clip}>
            <rect width="420" height="880" fill="#0c0c0e" />
            {screen}
            <g font-family="Inter" font-size="17" font-weight="600" fill="#f3f0e9">
                <text x="44" y="34">"9:41"</text>
                <rect x="150" y="12" width="120" height="32" rx="16" fill="#050506" />
                <rect x="346" y="21" width="30" height="14" rx="4" fill="none" stroke="#f3f0e9" stroke-width="1.5" />
                <rect x="349" y="24" width="20" height="8" rx="2" fill="#f3f0e9" />
                <path d="M318 32 h4 v-4 h-4z M324 32 h4 v-8 h-4z M330 32 h4 v-12 h-4z" fill="#f3f0e9" />
            </g>
        </g>
    </g>)
}

/// Companion app bar inside the phone.
fn app_bar() -> Svgr<'static> {
    fframes::svgr!(<g font-family="Inter">
        <rect y="50" width="420" height="58" fill="#0c0c0e" />
        <g transform="translate(20 62) scale(0.1)" fill="none" stroke="#f5b027" stroke-linecap="round" stroke-linejoin="round">
            <path d="M74 104c10-14 26-20 48-20h132" stroke-width="28" />
            <path d="M136 88c0 72-12 128-48 160" stroke-width="28" />
            <path d="M210 88v116c0 30 12 44 36 44 10 0 20-3 30-9" stroke-width="28" />
            <circle cx="276" cy="86" r="20" fill="#f5b027" stroke="none" />
        </g>
        <text x="62" y="86" font-size="18" font-weight="600" fill="#f3f0e9">"Pi Companion"</text>
        <rect x="300" y="64" width="72" height="30" rx="15" fill="#1b1b1f" stroke="#26262c" />
        <circle cx="318" cy="79" r="5" fill="#4fc58c" />
        <text x="330" y="85" font-size="15" font-weight="500" fill="#b2ada3">"Live"</text>
        <path d="M0 108 H420" stroke="#26262c" />
    </g>)
}

/// Bottom navigation; `active` is 0 Overview, 1 Sessions, 2 Automations, 3 Devices.
fn bottom_nav(active: usize) -> Svgr<'static> {
    let items: Vec<Svgr> = ["Overview", "Sessions", "Automations", "Devices"]
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let cx = 52.0 + i as f32 * 105.0;
            let (fill, bg) = if i == active { (ACCENT_TEXT, 1.0) } else { (TEXT3, 0.0) };
            fframes::svgr!(<g>
                <rect x={cx - 48.0} y="822" width="96" height="40" rx="12" fill="#f5b027" fill-opacity={0.12 * bg} />
                <text x={cx} y="848" text-anchor="middle" font-family={SANS} font-size="14" font-weight="600" fill={fill}>{name.to_string()}</text>
            </g>)
        })
        .collect();
    fframes::svgr!(<g>
        <rect y="812" width="420" height="68" fill="#09090b" />
        <path d="M0 812 H420" stroke="#26262c" />
        {items}
    </g>)
}

/// Status chip; `tone` is the dot / text color.
fn chip(x: f32, y: f32, label: &str, tone: &str) -> Svgr<'static> {
    let w = label.len() as f32 * 8.6 + 34.0;
    fframes::svgr!(<g font-family={SANS}>
        <rect x={x} y={y} width={w} height="28" rx="14" fill={tone.to_string()} fill-opacity="0.14" />
        <circle cx={x + 14.0} cy={y + 14.0} r="4" fill={tone.to_string()} />
        <text x={x + 24.0} y={y + 19.5} font-size="14" font-weight="600" fill={tone.to_string()}>{label.to_string()}</text>
    </g>)
}

/// A full-width primary button inside the phone.
fn primary_button(y: f32, label: &str, press: f32) -> Svgr<'static> {
    let s = 1.0 - 0.04 * press;
    fframes::svgr!(<g transform={format!("translate(210 {}) scale({s}) translate(-210 {})", y + 28.0, -(y + 28.0))}>
        <rect x="24" y={y} width="372" height="56" rx="14" fill={ACCENT} />
        <text x="210" y={y + 35.0} text-anchor="middle" font-family={SANS} font-size="19" font-weight="700" fill={ACCENT_INK}>{label.to_string()}</text>
    </g>)
}

/// Press amount for a button tapped at `at`.
fn press(t: f32, at: f32) -> f32 {
    smooth(t, at - 0.1, 0.1) * (1.0 - smooth(t, at + 0.05, 0.2))
}

/// Labelled text field inside the phone with an optional caret.
fn field(y: f32, label: &str, value: &str, mono: bool, caret: Option<f32>, focus: f32) -> Svgr<'static> {
    let family = if mono { MONO } else { SANS };
    let size = if mono { "24" } else { "19" };
    let caret_svg = match caret {
        Some(x) => fframes::svgr!(<rect x={42.0 + x} y={y + 40.0} width="2" height="26" fill={ACCENT} />),
        None => Svgr::empty(),
    };
    fframes::svgr!(<g font-family={SANS}>
        <text x="26" y={y + 14.0} font-size="15" font-weight="600" fill={TEXT2}>{label.to_string()}</text>
        <rect x="24" y={y + 26.0} width="372" height="54" rx="12" fill={SURFACE2} stroke={BORDER2} />
        <rect x="24" y={y + 26.0} width="372" height="54" rx="12" fill="none" stroke={ACCENT} stroke-width="2" opacity={focus} />
        <text x="42" y={y + 61.0} font-family={family} font-size={size} font-weight="500" fill={TEXT}>{value.to_string()}</text>
        {caret_svg}
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

/// Deterministic 25x25 QR-like code (decorative).
fn qr(x: f32, y: f32, size: f32) -> Svgr<'static> {
    let n = 25;
    let cell = size / n as f32;
    let finder = |cx: usize, cy: usize, i: usize, j: usize| {
        let (dx, dy) = (i as i32 - cx as i32, j as i32 - cy as i32);
        if dx.abs() > 3 || dy.abs() > 3 {
            return None;
        }
        let ring = dx.abs().max(dy.abs());
        Some(ring != 2)
    };
    let mut cells = Vec::new();
    for j in 0..n {
        for i in 0..n {
            let on = finder(3, 3, i, j)
                .or_else(|| finder(n - 4, 3, i, j))
                .or_else(|| finder(3, n - 4, i, j))
                .unwrap_or_else(|| {
                    let h = (i * 7919 + j * 104729 + i * j * 31) % 97;
                    h % 2 == 0 || h % 7 == 0
                });
            let near_finder = (i < 8 && j < 8) || (i >= n - 8 && j < 8) || (i < 8 && j >= n - 8);
            let border = near_finder && finder(3, 3, i, j).is_none() && finder(n - 4, 3, i, j).is_none() && finder(3, n - 4, i, j).is_none();
            if on && !border {
                let (cx, cy) = (x + i as f32 * cell, y + j as f32 * cell);
                cells.push(fframes::svgr!(<rect x={cx} y={cy} width={cell + 0.3} height={cell + 0.3} fill="#0c0c0e" />));
            }
        }
    }
    fframes::svgr!(<g>
        <rect x={x - 14.0} y={y - 14.0} width={size + 28.0} height={size + 28.0} rx="14" fill="#f3f0e9" />
        {cells}
    </g>)
}

// ---------------------------------------------------------------------------------------
// Scenes.

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Intro,
    Terminal,
    Pair,
    Connect,
    Session,
    Ask,
    Automation,
    Runs,
    Outro,
}

#[derive(Debug)]
pub struct Shot {
    kind: Kind,
    secs: f32,
}

impl Scene for Shot {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.secs)
    }

    fn overlap(&self) -> Overlap {
        if self.kind == Kind::Intro { Overlap::None } else { Overlap::Previous(FADE) }
    }

    fn name(&self) -> &'static str {
        match self.kind {
            Kind::Intro => "Intro",
            Kind::Terminal => "Terminal",
            Kind::Pair => "Pair",
            Kind::Connect => "Connect",
            Kind::Session => "Session",
            Kind::Ask => "Ask",
            Kind::Automation => "Automation",
            Kind::Runs => "Runs",
            Kind::Outro => "Outro",
        }
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let content = match self.kind {
            Kind::Intro => intro(t),
            Kind::Terminal => terminal(t),
            Kind::Pair => pair(t),
            Kind::Connect => connect(t, &mut frame, ctx),
            Kind::Session => session(t, &mut frame, ctx),
            Kind::Ask => ask(t),
            Kind::Automation => automation(t, &mut frame, ctx),
            Kind::Runs => runs(t),
            Kind::Outro => outro(t),
        };
        let fade_in = if self.kind == Kind::Intro { 1.0 } else { smooth(t, 0.0, FADE) };
        let chrome = if matches!(self.kind, Kind::Intro | Kind::Outro) { Svgr::empty() } else { brand() };
        fframes::svgr!(<g opacity={fade_in}>
            {backdrop()}
            {chrome}
            {content}
        </g>)
    }
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

fn terminal(t: f32) -> Svgr<'static> {
    let (x, y, w, h) = (860.0, 230.0, 930.0, 620.0);
    let lx = x + 36.0;
    let line = |i: usize| y + 104.0 + i as f32 * 44.0;
    let prompt_cmd = typed("pi", t, 0.5, 8.0);
    let ask = "Fix the session expiring early on Android";
    let ask_t = typed(ask, t, 1.5, 32.0);
    let rc = "/remote-control";
    let rc_start = 5.1;
    let rc_t = typed(rc, t, rc_start, 13.0);
    let rc_done = typing_done(rc, rc_start, 13.0);
    let appear = |at: f32| ramp(t, at, 0.35);
    let highlight = smooth(t, rc_done + 0.1, 0.3);
    // Caret follows whichever line is being typed.
    let (cx, cy) = if t < 1.2 {
        (lx + 24.0 * 14.4 + prompt_cmd.len() as f32 * 14.4, line(0))
    } else if t < 4.9 {
        (lx + 2.0 * 14.4 + ask_t.len() as f32 * 14.4, line(2))
    } else if t < rc_done + 0.3 {
        (lx + 2.0 * 14.4 + rc_t.len() as f32 * 14.4, line(6))
    } else {
        (lx + 2.0 * 14.4, line(10))
    };
    let caret_o = blink(t) * if t < 4.2 && t > typing_done(ask, 1.5, 32.0) + 0.2 { 0.0 } else { 1.0 };
    let glow = 0.5 + 0.5 * (t * 3.0).sin();
    fframes::svgr!(<g>
        {caption(t, 0.2, 4.5, "01  START A SESSION", ["Work in Pi", "like you always do."], ["Pi runs in your terminal and", "stays the source of truth."])}
        {caption(t, 4.75, 99.0, "02  REMOTE CONTROL", ["One command.", "Now it's shared."], ["/remote-control opens this", "session to your devices."])}
        {window(x, y, w, h, "pi  ~/code/mobile-app", false)}
        <g font-family={MONO} font-size="24">
            <text x={lx} y={line(0)} fill={ACCENT_TEXT}>"~/code/mobile-app" <tspan fill={TEXT3}>" ❯ "</tspan><tspan fill={TEXT}>{prompt_cmd}</tspan></text>
            <text opacity={appear(1.0)} x={lx} y={line(1)} fill={TEXT3}>"π pi  ·  claude-sonnet-4.5  ·  high"</text>
            <text x={lx} y={line(2)} fill={TEXT}><tspan fill={ACCENT}>"› "</tspan>{ask_t}</text>
            <g opacity={appear(3.0)}><text x={lx} y={line(3)} fill={TEXT2}><tspan fill={OK}>"● "</tspan>"Read  src/auth/session.ts"</text></g>
            <g opacity={appear(3.4)}><text x={lx} y={line(4)} fill={TEXT2}><tspan fill={OK}>"● "</tspan>"Edit  src/auth/session.ts  "<tspan fill={OK}>"+12"</tspan><tspan fill={DANGER}>" -3"</tspan></text></g>
            <g opacity={appear(3.8)}><text x={lx} y={line(5)} fill={TEXT2}><tspan fill={OK}>"● "</tspan>"Run   npm test  "<tspan fill={OK}>"✓ 42 passed"</tspan></text></g>
            <rect x={lx + 26.0} y={line(6) - 30.0} width={15.0 * 14.4 + 16.0} height="42" rx="8" fill="#f5b027" fill-opacity={0.16 * highlight} stroke="#f5b027" stroke-opacity={0.6 * highlight * (0.6 + 0.4 * glow)} />
            <text x={lx} y={line(6)} fill={TEXT} opacity={appear(4.9)}><tspan fill={ACCENT}>"› "</tspan><tspan fill={ACCENT_TEXT} font-weight="700">{rc_t}</tspan></text>
            <g opacity={appear(rc_done + 0.35)}><text x={lx} y={line(7) + 8.0} fill={OK} font-weight="700">"✓ Remote control on"</text></g>
            <g opacity={appear(rc_done + 0.6)}><text x={lx} y={line(8) + 8.0} fill={TEXT2}>"  Shared with your paired devices"</text></g>
            <g opacity={appear(rc_done + 0.85)}><text x={lx} y={line(9) + 8.0} fill={TEXT2}>"  Dashboard "<tspan fill={ACCENT_TEXT}>"http://localhost:43721"</tspan></text></g>
            <rect x={cx + 2.0} y={cy - 22.0} width="12" height="28" fill={ACCENT} opacity={caret_o} />
        </g>
    </g>)
}

fn pair(t: f32) -> Svgr<'static> {
    let (x, y, w, h) = (840.0, 170.0, 960.0, 720.0);
    let mx = x + 210.0; // main column
    let click = 2.1;
    let travel = smooth(t, 0.7, 1.2);
    let (px, py) = (mix(1360.0, 1700.0, travel), mix(820.0, 300.0, travel));
    let modal = spring(t, click + 0.15);
    let modal_o = ramp(t, click + 0.1, 0.35);
    let remaining = (300.0 - (t - click).max(0.0)).floor() as i32;
    let countdown = format!("Single use  ·  expires in {}:{:02}", remaining / 60, remaining % 60);
    let nav: Vec<Svgr> = ["Overview", "Sessions", "Automations", "Devices", "Settings"]
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let ny = y + 132.0 + i as f32 * 46.0;
            let active = i == 3;
            fframes::svgr!(<g>
                <rect x={x + 14.0} y={ny - 26.0} width="176" height="38" rx="10" fill="#f5b027" fill-opacity={if active { 0.12 } else { 0.0 }} />
                <text x={x + 32.0} y={ny} font-size="18" font-weight={if active { "600" } else { "500" }} fill={if active { ACCENT_TEXT } else { TEXT2 }}>{name.to_string()}</text>
            </g>)
        })
        .collect();
    let btn_press = press(t, click);
    fframes::svgr!(<g font-family={SANS}>
        {caption(t, 0.2, 99.0, "03  PAIR A DEVICE", ["Open the dashboard.", "Pair a new device."], ["Get a QR code and a", "single-use pairing code."])}
        {window(x, y, w, h, "localhost:43721/devices", true)}
        <path d={format!("M{} {} V{}", x + 200.0, y + 48.0, y + h)} stroke={BORDER} />
        <text x={x + 26.0} y={y + 86.0} font-size="19" font-weight="700" fill={TEXT}>"Pi Companion"</text>
        {nav}
        <rect x={mx} y={y + 72.0} width="730" height="118" rx="16" fill={SURFACE2} stroke={BORDER} />
        <text x={mx + 28.0} y={y + 110.0} font-family={MONO} font-size="13" font-weight="700" letter-spacing="2" fill={ACCENT_TEXT}>"YOUR WORK, WHEREVER YOU ARE"</text>
        <text x={mx + 28.0} y={y + 150.0} font-size="34" font-weight="700" fill={TEXT}>"Devices"</text>
        <text x={mx + 28.0} y={y + 176.0} font-size="16" fill={TEXT3}>"One workspace. Your favorite screens."</text>
        <g transform={format!("translate({} {}) scale({}) translate({} {})", mx + 620.0, y + 131.0, 1.0 - 0.05 * btn_press, -(mx + 620.0), -(y + 131.0))}>
            <rect x={mx + 530.0} y={y + 107.0} width="180" height="48" rx="12" fill={ACCENT} />
            <text x={mx + 620.0} y={y + 138.0} text-anchor="middle" font-size="18" font-weight="700" fill={ACCENT_INK}>"+  Pair a device"</text>
        </g>
        <rect x={mx} y={y + 210.0} width="730" height="300" rx="16" fill={SURFACE2} stroke={BORDER} />
        <text x={mx + 28.0} y={y + 250.0} font-size="20" font-weight="600" fill={TEXT}>"Paired devices"</text>
        <rect x={mx + 344.0} y={y + 300.0} width="42" height="60" rx="9" fill="none" stroke={ACCENT} stroke-width="3" />
        <text x={mx + 365.0} y={y + 400.0} text-anchor="middle" font-size="20" font-weight="600" fill={TEXT}>"No devices yet"</text>
        <text x={mx + 365.0} y={y + 430.0} text-anchor="middle" font-size="16" fill={TEXT3}>"Pair a phone to follow sessions from anywhere."</text>
        <g opacity={modal_o}>
            <rect x={x + 1.0} y={y + 49.0} width={w - 2.0} height={h - 50.0} fill="#000000" opacity="0.6" />
            <g transform={format!("translate(1320 530) scale({}) translate(-1320 -530)", 0.92 + 0.08 * modal)}>
                <rect x="1000" y="300" width="640" height="460" rx="20" fill={SURFACE} stroke={BORDER2} />
                <text x="1036" y="352" font-size="30" font-weight="700" fill={TEXT}>"Pair a device"</text>
                <text x="1036" y="384" font-size="17" fill={TEXT2}>"Scan with your phone, or type the code."</text>
                {qr(1050.0, 430.0, 236.0)}
                <text x="1340" y="456" font-family={MONO} font-size="14" font-weight="700" letter-spacing="2" fill={TEXT3}>"PAIRING CODE"</text>
                <text x="1338" y="510" font-family={MONO} font-size="46" font-weight="700" fill={ACCENT}>"K7QF-29XM"</text>
                <text x="1340" y="548" font-size="16" fill={TEXT2}>{countdown}</text>
                <rect x="1340" y="590" width="256" height="46" rx="12" fill={SURFACE2} stroke={BORDER2} />
                <text x="1468" y="619" text-anchor="middle" font-size="17" font-weight="600" fill={TEXT}>"Copy pairing link"</text>
                <text x="1340" y="688" font-size="15" fill={TEXT3}>"Waiting for a device..."</text>
                <circle cx={1560.0 + 8.0 * (t * 3.0).sin()} cy="683" r="5" fill={ACCENT} />
            </g>
        </g>
        {ripple(t, click, 1700.0, 300.0)}
        <g opacity={1.0 - smooth(t, click + 0.6, 0.3)}>{pointer(px, py, btn_press)}</g>
    </g>)
}

fn connect<'a>(t: f32, frame: &mut Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'static> {
    let code = "K7QF-29XM";
    let code_start = 1.2;
    let code_t = typed(code, t, code_start, 8.0);
    let code_done = typing_done(code, code_start, 8.0);
    let name = "Yunaz's iPhone";
    let name_start = code_done + 0.35;
    let name_t = typed(name, t, name_start, 22.0);
    let name_done = typing_done(name, name_start, 22.0);
    let connect_at = name_done + 0.6;
    let success = ramp(t, connect_at + 0.3, 0.4);
    let check = spring(t, connect_at + 0.4);
    let code_w = text_w(frame, ctx, MONO, 24, 500, code_t);
    let name_w = text_w(frame, ctx, SANS, 19, 500, name_t);
    let code_caret = (t < code_done + 0.2 && t > code_start - 0.6).then_some(code_w).filter(|_| blink(t) > 0.0);
    let name_caret = (t >= code_done + 0.2 && t < name_done + 0.4).then_some(name_w).filter(|_| blink(t) > 0.0);
    let code_focus = shown(t, code_start - 0.5, code_done + 0.2);
    let name_focus = shown(t, code_done + 0.2, name_done + 0.4);
    let card_o = ramp(t, 0.5, 0.5);
    let card_dy = (1.0 - spring(t, 0.5)) * 40.0;
    let matched = smooth(t, code_done, 0.3);
    let form = fframes::svgr!(<g font-family={SANS} opacity={1.0 - success}>
        <rect x="24" y="136" width="56" height="56" rx="14" fill="#f5b027" fill-opacity="0.12" />
        <rect x="42" y="148" width="20" height="32" rx="4" fill="none" stroke={ACCENT} stroke-width="2.5" />
        <text x="24" y="236" font-size="30" font-weight="700" fill={TEXT}>"Connect this device"</text>
        <text x="24" y="268" font-size="17" fill={TEXT2}>"Scan a pairing QR code or enter the"</text>
        <text x="24" y="292" font-size="17" fill={TEXT2}>"code shown on your computer."</text>
        <rect x="24" y="316" width="372" height="52" rx="12" fill={SURFACE2} stroke={BORDER2} />
        <text x="210" y="349" text-anchor="middle" font-size="18" font-weight="600" fill={TEXT}>"Scan QR code"</text>
        <path d="M24 404 H150 M270 404 H396" stroke={BORDER2} />
        <text x="210" y="409" text-anchor="middle" font-size="15" fill={TEXT3}>"or enter the code"</text>
        {field(430.0, "Pairing code", code_t, true, code_caret, code_focus)}
        {field(540.0, "Device name", name_t, false, name_caret, name_focus)}
        {primary_button(668.0, "Connect", press(t, connect_at))}
        {bottom_nav(3)}
    </g>);
    let done = fframes::svgr!(<g font-family={SANS} opacity={success}>
        <circle cx="210" cy="360" r={(64.0 * check).max(0.5)} fill="#4fc58c" fill-opacity="0.16" />
        <circle cx="210" cy="360" r={(44.0 * check).max(0.5)} fill={OK} />
        <path d="M188 360 L203 375 L233 345" fill="none" stroke="#0c0c0e" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="70" stroke-dashoffset={70.0 * (1.0 - smooth(t, connect_at + 0.6, 0.35))} />
        <text x="210" y="476" text-anchor="middle" font-size="32" font-weight="700" fill={TEXT}>"You're connected"</text>
        <text x="210" y="510" text-anchor="middle" font-size="18" fill={TEXT2}>"Yunaz's iPhone is paired with"</text>
        <text x="210" y="536" text-anchor="middle" font-size="18" fill={TEXT2}>"your computer."</text>
        {primary_button(600.0, "Open sessions", 0.0)}
        {bottom_nav(0)}
    </g>);
    let screen = fframes::svgr!(<g>
        {app_bar()}
        {form}
        {done}
        {tap(t, connect_at, 300.0, 696.0)}
    </g>);
    fframes::svgr!(<g font-family={SANS}>
        {caption(t, 0.2, 99.0, "04  ON YOUR PHONE", ["Type the code.", "You're paired."], ["Pair once. Every shared", "session follows you."])}
        {phone("clip-connect", 980.0, PHONE_Y, screen)}
        <g opacity={card_o * (1.0 - 0.6 * success)} transform={format!("translate(0 {card_dy})")}>
            <rect x="1470" y="380" width="330" height="190" rx="18" fill={SURFACE} stroke={BORDER2} />
            <rect x="1470" y="380" width="330" height="190" rx="18" fill="none" stroke={OK} stroke-width="3" opacity={matched} />
            <text x="1498" y="424" font-family={MONO} font-size="14" font-weight="700" letter-spacing="2" fill={TEXT3}>"ON YOUR COMPUTER"</text>
            <text x="1496" y="486" font-family={MONO} font-size="44" font-weight="700" fill={ACCENT}>"K7QF-29XM"</text>
            <text x="1498" y="534" font-size="17" fill={if matched > 0.5 { OK } else { TEXT2 }}>{if matched > 0.5 { "Code matched" } else { "Devices  ›  Pair a device" }}</text>
        </g>
    </g>)
}

const SESSIONS: [(&str, &str, &str, &str); 3] = [
    ("Fix login on Android", "Working", "Session expires too early", "~/code/mobile-app"),
    ("Docs refresh", "Waiting", "Rewrite the onboarding guide", "~/code/handbook"),
    ("Coupon discounts", "Idle", "10% off any line with a coupon", "~/code/billing"),
];

fn session_list(t: f32) -> Svgr<'static> {
    let cards: Vec<Svgr> = SESSIONS
        .iter()
        .enumerate()
        .map(|(i, (title, status, desc, ws))| {
            let y = 222.0 + i as f32 * 150.0;
            let tone = match *status {
                "Working" => OK,
                "Waiting" => ACCENT,
                _ => TEXT3,
            };
            let o = ramp(t, 0.15 + i as f32 * 0.1, 0.4);
            let pressed = if i == 0 { press(t, 1.5) } else { 0.0 };
            fframes::svgr!(<g opacity={o} font-family={SANS}>
                <rect x="20" y={y} width="380" height="134" rx="16" fill={if pressed > 0.0 { SURFACE3 } else { SURFACE2 }} stroke={BORDER} />
                <text x="40" y={y + 38.0} font-size="20" font-weight="700" fill={TEXT}>{title.to_string()}</text>
                {chip(390.0 - (status.len() as f32 * 8.6 + 34.0) - 6.0, y + 16.0, status, tone)}
                <text x="40" y={y + 70.0} font-size="16" fill={TEXT2}>{desc.to_string()}</text>
                <text x="40" y={y + 108.0} font-family={MONO} font-size="15" fill={TEXT3}>{ws.to_string()}</text>
            </g>)
        })
        .collect();
    fframes::svgr!(<g font-family={SANS}>
        <text x="24" y="160" font-size="30" font-weight="700" fill={TEXT}>"Sessions"</text>
        <text x="24" y="190" font-size="16" fill={TEXT3}>"3 shared with this device"</text>
        {cards}
    </g>)
}

/// The session feed lines; `extra` appends the answered question and follow-up work.
fn feed(t: f32, start: f32, prompt: Option<f32>, answered: Option<f32>) -> Svgr<'static> {
    let lines: [(&str, &str, &str); 6] = [
        ("› ", "Fix the session expiring early", ACCENT),
        ("$ ", "edit src/auth/session.ts", TEXT),
        ("  ", "Applied 1 edit  +12 -3", TEXT3),
        ("$ ", "npm test", TEXT),
        ("  ", "42 passed", OK),
        ("● ", "Pi is working", ACCENT_TEXT),
    ];
    let rows: Vec<Svgr> = lines
        .iter()
        .enumerate()
        .map(|(i, (prefix, text, tone))| {
            let y = 206.0 + i as f32 * 34.0;
            let o = ramp(t, start + i as f32 * 0.12, 0.35);
            let status = if text.starts_with("edit") || text.starts_with("npm") {
                fframes::svgr!(<text x="392" y={y} text-anchor="end" font-size="14" fill={OK}>"ok"</text>)
            } else {
                Svgr::empty()
            };
            fframes::svgr!(<g opacity={o}>
                <text x="26" y={y} font-size="16" fill={tone.to_string()}><tspan fill={TEXT3}>{prefix.to_string()}</tspan>{text.to_string()}</text>
                {status}
            </g>)
        })
        .collect();
    let bubble = match prompt {
        Some(at) => {
            let o = ramp(t, at, 0.4);
            let dy = (1.0 - spring(t, at)) * 24.0;
            fframes::svgr!(<g opacity={o} transform={format!("translate(0 {dy})")} font-family={SANS}>
                <rect x="76" y="420" width="320" height="76" rx="16" fill="#f5b027" fill-opacity="0.14" stroke="#f5b027" stroke-opacity="0.38" />
                <text x="94" y="450" font-size="16" fill={TEXT}>"Still expires after resume. Give"</text>
                <text x="94" y="476" font-size="16" fill={TEXT}>"me options before fixing."</text>
                <text x="392" y="516" text-anchor="end" font-size="13" fill={TEXT3}>"You  ·  from Yunaz's iPhone"</text>
            </g>)
        }
        None => Svgr::empty(),
    };
    let answer = match answered {
        Some(at) => fframes::svgr!(<g font-family={MONO} font-size="16">
            <g opacity={ramp(t, at, 0.4)}>
                <rect x="20" y="540" width="380" height="64" rx="12" fill="#4fc58c" fill-opacity="0.1" stroke="#4fc58c" stroke-opacity="0.35" />
                <text x="36" y="566" font-family={SANS} font-size="14" font-weight="600" fill={OK}>"✓ Answered"</text>
                <text x="36" y="590" font-family={SANS} font-size="16" fill={TEXT}>"Refresh the token on app resume"</text>
            </g>
            <text opacity={ramp(t, at + 0.5, 0.4)} x="26" y="640" fill={TEXT}><tspan fill={TEXT3}>"$ "</tspan>"edit src/auth/refresh.ts"</text>
            <text opacity={ramp(t, at + 0.5, 0.4)} x="392" y="640" text-anchor="end" font-size="14" fill={OK}>"ok"</text>
            <text opacity={ramp(t, at + 0.9, 0.4) * (0.6 + 0.4 * (t * 4.0).sin().abs())} x="26" y="674" fill={ACCENT_TEXT}>"● Pi is working"</text>
        </g>),
        None => Svgr::empty(),
    };
    fframes::svgr!(<g font-family={MONO}>
        <rect x="0" y="108" width="420" height="58" fill="#0c0c0e" />
        <text x="22" y="145" font-family={SANS} font-size="26" fill={TEXT2}>"‹"</text>
        <circle cx="54" cy="137" r="5" fill={OK} />
        <text x="68" y="143" font-family={SANS} font-size="19" font-weight="700" fill={TEXT}>"Fix login on Android"</text>
        <text x="392" y="143" text-anchor="end" font-family={SANS} font-size="22" font-weight="700" fill={TEXT3}>"···"</text>
        <path d="M0 166 H420" stroke={BORDER} />
        <text x="26" y="196" font-size="14" fill={TEXT3} opacity="0">"~/code/mobile-app"</text>
        {rows}
        {bubble}
        {answer}
    </g>)
}

fn session<'a>(t: f32, frame: &mut Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'static> {
    let slide = smooth(t, 1.75, 0.45);
    let msg = ["Still expires after resume. Give", "me options before fixing."];
    let type_start = 3.4;
    let cps = 24.0;
    let first = typed(msg[0], t, type_start, cps);
    let second_start = typing_done(msg[0], type_start, cps) + 0.05;
    let second = typed(msg[1], t, second_start, cps);
    let typing_end = typing_done(msg[1], second_start, cps);
    let send_at = typing_end + 0.45;
    let sent = t > send_at + 0.1;
    let (l1, l2) = if sent { ("", "") } else { (first, second) };
    let caret_line = if second.is_empty() { 0 } else { 1 };
    let caret_x = text_w(frame, ctx, SANS, 17, 400, if caret_line == 0 { first } else { second });
    let typing = t > type_start - 0.5 && !sent;
    let focus = shown(t, type_start - 0.5, send_at);
    let placeholder_o = if first.is_empty() || sent { 1.0 } else { 0.0 };
    let detail = fframes::svgr!(<g font-family={SANS}>
        {feed(t, 2.1, Some(send_at + 0.15), None)}
        <rect x="0" y="690" width="420" height="122" fill="#0c0c0e" />
        <rect x="16" y="698" width="388" height="106" rx="16" fill={SURFACE2} stroke={BORDER2} />
        <rect x="16" y="698" width="388" height="106" rx="16" fill="none" stroke={ACCENT} stroke-width="2" opacity={focus} />
        <text x="34" y="728" font-size="17" fill={TEXT3} opacity={placeholder_o}>"Message Pi..."</text>
        <text x="34" y="728" font-size="17" fill={TEXT}>{l1}</text>
        <text x="34" y="752" font-size="17" fill={TEXT}>{l2}</text>
        <rect x={37.0 + caret_x} y={if caret_line == 0 { 712.0 } else { 736.0 }} width="2" height="22" fill={ACCENT} opacity={if typing { blink(t) } else { 0.0 }} />
        <rect x="28" y="766" width="60" height="28" rx="8" fill={SURFACE3} />
        <text x="58" y="785" text-anchor="middle" font-size="14" font-weight="600" fill={TEXT}>"Auto"</text>
        <g transform={format!("translate(338 780) scale({}) translate(-338 -780)", 1.0 - 0.1 * press(t, send_at))}>
            <rect x="290" y="764" width="100" height="32" rx="10" fill={ACCENT} />
            <text x="340" y="786" text-anchor="middle" font-size="15" font-weight="700" fill={ACCENT_INK}>"Send"</text>
        </g>
    </g>);
    let screen = fframes::svgr!(<g>
        <g transform={format!("translate({} 0)", -420.0 * slide)}>{session_list(t)}</g>
        <g transform={format!("translate({} 0)", 420.0 * (1.0 - slide))}>{detail}</g>
        {app_bar()}
        {bottom_nav(1)}
        {tap(t, 1.5, 200.0, 290.0)}
        {tap(t, send_at, 340.0, 780.0)}
    </g>);
    fframes::svgr!(<g>
        {caption(t, 0.2, 99.0, "05  INSPECT A SESSION", ["See what Pi is doing.", "Prompt from anywhere."], ["A live feed of tools and output,", "with a composer in your pocket."])}
        {phone("clip-session", PHONE_X, PHONE_Y, screen)}
    </g>)
}

fn ask(t: f32) -> Svgr<'static> {
    let notify = shown(t, 0.2, 1.3);
    let notify_dy = (1.0 - spring(t, 0.2)) * -90.0;
    let sheet_in = spring(t, 1.1);
    let pick_at = 2.9;
    let send_at = 4.0;
    let sheet_out = smooth(t, send_at + 0.25, 0.35);
    let sheet_y = 880.0 - 560.0 * sheet_in + 600.0 * sheet_out;
    let picked = smooth(t, pick_at, 0.2);
    let answered_at = send_at + 0.55;
    let options = [
        ("Refresh the token on app resume", "Recommended"),
        ("Extend the session TTL to 7 days", ""),
        ("Show a re-login prompt", ""),
        ("Other answer...", ""),
    ];
    let opts: Vec<Svgr> = options
        .iter()
        .enumerate()
        .map(|(i, (label, hint))| {
            let y = 150.0 + i as f32 * 76.0;
            let sel = if i == 0 { picked } else { 0.0 };
            let o = ramp(t, 1.35 + i as f32 * 0.08, 0.35);
            let hint_svg = if hint.is_empty() {
                Svgr::empty()
            } else {
                fframes::svgr!(<text x="76" y={y + 50.0} font-size="13" font-weight="600" fill={ACCENT_TEXT}>{hint.to_string()}</text>)
            };
            let ly = if hint.is_empty() { y + 38.0 } else { y + 30.0 };
            fframes::svgr!(<g opacity={o} font-family={SANS}>
                <rect x="20" y={y} width="380" height="64" rx="14" fill={SURFACE2} stroke={BORDER2} />
                <rect x="20" y={y} width="380" height="64" rx="14" fill="#f5b027" fill-opacity={0.12 * sel} stroke={ACCENT} stroke-width="2" stroke-opacity={sel} />
                <circle cx="48" cy={y + 32.0} r="10" fill="none" stroke={if sel > 0.5 { ACCENT } else { TEXT3 }} stroke-width="2" />
                <circle cx="48" cy={y + 32.0} r={(5.0 * sel).max(0.5)} fill={ACCENT} opacity={sel} />
                <text x="76" y={ly} font-size="17" font-weight="600" fill={TEXT}>{label.to_string()}</text>
                {hint_svg}
            </g>)
        })
        .collect();
    let sheet = fframes::svgr!(<g transform={format!("translate(0 {sheet_y})")} font-family={SANS}>
        <rect x="0" y="0" width="420" height="640" rx="28" fill={SURFACE} stroke={BORDER2} />
        <rect x="180" y="12" width="60" height="5" rx="2.5" fill={BORDER2} />
        <text x="24" y="58" font-family={MONO} font-size="13" font-weight="700" letter-spacing="2" fill={ACCENT_TEXT}>"PI HAS A QUESTION"</text>
        <text x="24" y="98" font-size="25" font-weight="700" fill={TEXT}>"Which fix should I apply?"</text>
        <text x="24" y="126" font-size="15" fill={TEXT3}>"Fix login on Android"</text>
        {opts}
        {primary_button(462.0, "Send answer", press(t, send_at))}
    </g>);
    let dim = 0.55 * smooth(t, 1.0, 0.3) * (1.0 - sheet_out);
    let screen = fframes::svgr!(<g>
        {feed(t, -10.0, Some(-10.0), Some(answered_at))}
        {app_bar()}
        {bottom_nav(1)}
        <rect width="420" height="880" fill="#000000" opacity={dim} />
        {sheet}
        <g opacity={notify} transform={format!("translate(0 {notify_dy})")} font-family={SANS}>
            <rect x="12" y="56" width="396" height="84" rx="20" fill="#26262c" fill-opacity="0.97" stroke={BORDER2} />
            <rect x="28" y="74" width="40" height="40" rx="10" fill={ACCENT} />
            <text x="48" y="101" text-anchor="middle" font-size="22" font-weight="700" fill={ACCENT_INK}>"π"</text>
            <text x="82" y="90" font-size="15" font-weight="700" fill={TEXT}>"Pi needs your answer"</text>
            <text x="82" y="114" font-size="15" fill={TEXT2}>"Fix login on Android"</text>
            <text x="392" y="90" text-anchor="end" font-size="13" fill={TEXT3}>"now"</text>
        </g>
        {tap(t, pick_at, 220.0, 502.0)}
        {tap(t, send_at, 300.0, 810.0)}
    </g>);
    fframes::svgr!(<g>
        {caption(t, 0.2, 99.0, "06  ANSWER QUESTIONS", ["Pi asks.", "You just tap."], ["Pick an option, and Pi", "keeps going on your computer."])}
        {phone("clip-ask", PHONE_X, PHONE_Y, screen)}
    </g>)
}

fn automation<'a>(t: f32, frame: &mut Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'static> {
    let name = "Daily research digest";
    let name_start = 0.9;
    let name_t = typed(name, t, name_start, 20.0);
    let name_done = typing_done(name, name_start, 20.0);
    let prompt = ["Research the latest WebGPU news", "and summarise the 5 biggest", "updates, with links."];
    let mut start = name_done + 0.35;
    let mut prompt_t = Vec::new();
    for line in prompt {
        prompt_t.push(typed(line, t, start, 34.0));
        start = typing_done(line, start, 34.0) + 0.04;
    }
    let prompt_done = start;
    let toggle_at = prompt_done + 0.45;
    let toggle = smooth(t, toggle_at, 0.25);
    let create_at = toggle_at + 1.4;
    let toast = shown(t, create_at + 0.25, 99.0);
    let toast_dy = (1.0 - spring(t, create_at + 0.25)) * -40.0;
    let name_w = text_w(frame, ctx, SANS, 19, 500, name_t);
    let name_caret = (t > name_start - 0.4 && t < name_done + 0.3 && blink(t) > 0.0).then_some(name_w);
    let line_i = prompt_t.iter().rposition(|l| !l.is_empty()).unwrap_or(0);
    let prompt_w = text_w(frame, ctx, SANS, 17, 400, prompt_t[line_i]);
    let prompt_typing = t > name_done + 0.3 && t < prompt_done + 0.3;
    let schedule_o = ramp(t, toggle_at + 0.15, 0.4);
    let prompt_lines: Vec<Svgr> = prompt_t
        .iter()
        .enumerate()
        .map(|(i, l)| fframes::svgr!(<text x="42" y={366.0 + i as f32 * 26.0} font-size="17" fill={TEXT}>{*l}</text>))
        .collect();
    let screen = fframes::svgr!(<g font-family={SANS}>
        {app_bar()}
        <text x="24" y="146" font-size="16" font-weight="600" fill={TEXT2}>"‹  All automations"</text>
        <text x="24" y="192" font-size="28" font-weight="700" fill={TEXT}>"New automation"</text>
        {field(212.0, "Automation name", name_t, false, name_caret, shown(t, name_start - 0.4, name_done + 0.3))}
        <text x="26" y="326" font-size="15" font-weight="600" fill={TEXT2}>"Pi prompt"</text>
        <rect x="24" y="338" width="372" height="104" rx="12" fill={SURFACE2} stroke={BORDER2} />
        <rect x="24" y="338" width="372" height="104" rx="12" fill="none" stroke={ACCENT} stroke-width="2" opacity={shown(t, name_done + 0.3, prompt_done + 0.3)} />
        {prompt_lines}
        <rect x={43.0 + prompt_w} y={348.0 + line_i as f32 * 26.0} width="2" height="22" fill={ACCENT} opacity={if prompt_typing { blink(t) } else { 0.0 }} />
        <rect x="24" y="462" width="372" height="152" rx="12" fill={SURFACE2} stroke={BORDER} />
        <text x="42" y="498" font-size="18" font-weight="600" fill={TEXT}>"Run on a schedule"</text>
        <rect x="320" y="478" width="56" height="30" rx="15" fill={if toggle > 0.5 { ACCENT } else { SURFACE3 }} />
        <circle cx={335.0 + 26.0 * toggle} cy="493" r="11" fill={if toggle > 0.5 { ACCENT_INK } else { TEXT2 }} />
        <g opacity={schedule_o}>
            <path d="M42 518 H378" stroke={BORDER} />
            <text x="42" y="550" font-size="15" fill={TEXT3}>"When it runs"</text>
            <text x="42" y="578" font-size="18" font-weight="600" fill={TEXT}>"Weekdays at 09:00"</text>
            <text x="42" y="600" font-size="14" fill={TEXT3}>"Asia/Jakarta  ·  next run tomorrow 09:00"</text>
        </g>
        <rect x="24" y="630" width="372" height="56" rx="12" fill={SURFACE2} stroke={BORDER} />
        <text x="42" y="664" font-size="16" fill={TEXT2}>"Keep the latest"</text>
        <text x="378" y="664" text-anchor="end" font-size="16" font-weight="600" fill={TEXT}>"30 runs"</text>
        {primary_button(712.0, "Create automation", press(t, create_at))}
        {bottom_nav(2)}
        <g opacity={toast} transform={format!("translate(0 {toast_dy})")}>
            <rect x="70" y="118" width="280" height="46" rx="23" fill="#123326" stroke={OK} stroke-opacity="0.5" />
            <text x="210" y="147" text-anchor="middle" font-size="16" font-weight="700" fill={OK}>"✓  Automation created"</text>
        </g>
        {tap(t, toggle_at, 348.0, 493.0)}
        {tap(t, create_at, 280.0, 740.0)}
    </g>);
    fframes::svgr!(<g>
        {caption(t, 0.2, 99.0, "07  AUTOMATIONS", ["Give Pi a routine.", "It runs on schedule."], ["Like a daily research digest", "on any topic you care about."])}
        {phone("clip-automation", PHONE_X, PHONE_Y, screen)}
    </g>)
}

fn runs(t: f32) -> Svgr<'static> {
    let run_at = 1.6;
    let insert = smooth(t, run_at + 0.2, 0.45);
    let done_at = run_at + 2.4;
    let done = smooth(t, done_at, 0.25);
    let open_at = done_at + 1.0;
    let report = spring(t, open_at + 0.2);
    let report_o = ramp(t, open_at + 0.15, 0.3);
    let past = [
        ("Fri, 09:00", "Succeeded", "1m 08s", OK),
        ("Thu, 09:00", "Succeeded", "57s", OK),
        ("Wed, 09:00", "Failed", "12s", DANGER),
        ("Tue, 09:00", "Succeeded", "1m 02s", OK),
    ];
    let row = |y: f32, when: &str, status: &str, dur: &str, tone: &str, o: f32| -> Svgr<'static> {
        let chip_x = 392.0 - (status.len() as f32 * 8.6 + 34.0) - 10.0;
        fframes::svgr!(<g opacity={o} font-family={SANS}>
            <rect x="20" y={y} width="380" height="60" rx="12" fill={SURFACE2} stroke={BORDER} />
            <text x="38" y={y + 26.0} font-size="16" font-weight="600" fill={TEXT}>{when.to_string()}</text>
            <text x="38" y={y + 47.0} font-size="14" fill={TEXT3}>{dur.to_string()}</text>
            {chip(chip_x, y + 16.0, status, tone)}
        </g>)
    };
    let rows: Vec<Svgr> = past
        .iter()
        .enumerate()
        .map(|(i, (w, s, d, tone))| row(560.0 + (i as f32 + insert) * 70.0, w, s, d, tone, ramp(t, 0.3 + i as f32 * 0.08, 0.35)))
        .collect();
    let spin = t * 360.0;
    let new_row = if done > 0.5 {
        row(560.0, "Today, 14:32", "Succeeded", "1m 04s", OK, insert)
    } else {
        let elapsed = ((t - run_at - 0.2).max(0.0) * 26.0) as i32;
        fframes::svgr!(<g opacity={insert} font-family={SANS}>
            <rect x="20" y="560" width="380" height="60" rx="12" fill="#f5b027" fill-opacity="0.08" stroke={ACCENT} stroke-opacity="0.5" />
            <text x="38" y="586" font-size="16" font-weight="600" fill={TEXT}>"Today, 14:32"</text>
            <text x="38" y="607" font-size="14" fill={TEXT3}>{format!("Running  ·  {elapsed}s")}</text>
            <g transform={format!("translate(372 590) rotate({spin})")}>
                <circle r="10" fill="none" stroke={BORDER2} stroke-width="3" />
                <path d="M0 -10 A10 10 0 0 1 10 0" fill="none" stroke={ACCENT} stroke-width="3" stroke-linecap="round" />
            </g>
        </g>)
    };
    let pop = 1.0 + 0.06 * (1.0 - spring(t, done_at)).abs() * done;
    let count = if t > run_at + 0.2 { "Run history · 5" } else { "Run history · 4" };
    let digest = [
        "1.  Browser support keeps expanding",
        "2.  New subgroup ops in the spec",
        "3.  three.js WebGPU renderer matures",
        "4.  Fresh compute-shader samples",
        "5.  Better shader debugging tools",
    ];
    let digest_rows: Vec<Svgr> = digest
        .iter()
        .enumerate()
        .map(|(i, d)| fframes::svgr!(<text opacity={ramp(t, open_at + 0.5 + i as f32 * 0.12, 0.35)} x="40" y={428.0 + i as f32 * 34.0} font-size="16" fill={TEXT}>{d.to_string()}</text>))
        .collect();
    let report_y = 880.0 * (1.0 - report);
    let screen = fframes::svgr!(<g font-family={SANS}>
        {app_bar()}
        <text x="24" y="146" font-size="16" font-weight="600" fill={TEXT2}>"‹  All automations"</text>
        <rect x="20" y="168" width="380" height="196" rx="18" fill={SURFACE2} stroke={BORDER} />
        <rect x="40" y="190" width="48" height="48" rx="12" fill={ACCENT} />
        <path d="M68 196 L54 218 H64 L60 232 L76 208 H66 Z" fill={ACCENT_INK} />
        <text x="104" y="208" font-family={MONO} font-size="12" font-weight="700" letter-spacing="2" fill={ACCENT_TEXT}>"AUTOMATION WORKSPACE"</text>
        <text x="104" y="234" font-size="22" font-weight="700" fill={TEXT}>"Daily research digest"</text>
        {chip(40.0, 256.0, "Enabled", OK)}
        {chip(150.0, 256.0, "Scheduled", ACCENT)}
        <g transform={format!("translate(210 330) scale({}) translate(-210 -330)", 1.0 - 0.04 * press(t, run_at))}>
            <rect x="40" y="302" width="340" height="50" rx="12" fill={ACCENT} />
            <text x="210" y="334" text-anchor="middle" font-size="18" font-weight="700" fill={ACCENT_INK}>"Run now"</text>
        </g>
        <rect x="20" y="384" width="380" height="50" rx="12" fill={SURFACE2} stroke={BORDER} />
        <rect x="212" y="390" width="182" height="38" rx="9" fill={SURFACE3} />
        <text x="114" y="415" text-anchor="middle" font-size="15" font-weight="600" fill={TEXT3}>"Summary"</text>
        <text x="303" y="415" text-anchor="middle" font-size="15" font-weight="700" fill={ACCENT_TEXT}>{count}</text>
        <text x="24" y="478" font-size="20" font-weight="700" fill={TEXT}>"Run history"</text>
        <text x="24" y="502" font-size="14" fill={TEXT3}>"Newest first  ·  keeps the latest 30 runs"</text>
        <text x="24" y="540" font-size="13" font-weight="600" fill={TEXT3} opacity="0">"."</text>
        <g clip-path="url(#runs-clip)">
            <clipPath id="runs-clip"><rect x="0" y="550" width="420" height="262" /></clipPath>
            {rows}
            <g transform={format!("translate(210 590) scale({pop}) translate(-210 -590)")}>{new_row}</g>
        </g>
        {bottom_nav(2)}
        <g opacity={report_o} transform={format!("translate(0 {report_y})")}>
            <rect x="0" y="120" width="420" height="760" rx="28" fill={SURFACE} stroke={BORDER2} />
            <rect x="180" y="132" width="60" height="5" rx="2.5" fill={BORDER2} />
            <text x="24" y="182" font-family={MONO} font-size="13" font-weight="700" letter-spacing="2" fill={ACCENT_TEXT}>"EXECUTION REPORT"</text>
            <text x="24" y="218" font-size="26" font-weight="700" fill={TEXT}>"Automation run"</text>
            {chip(24.0, 236.0, "Succeeded", OK)}
            <text x="24" y="298" font-size="15" fill={TEXT3}>"Started today, 14:32  ·  took 1m 04s"</text>
            <path d="M24 320 H396" stroke={BORDER} />
            <text x="24" y="356" font-size="15" font-weight="600" fill={TEXT2}>"Output & summary"</text>
            <text x="24" y="392" font-size="19" font-weight="700" fill={TEXT}>"WebGPU research digest"</text>
            {digest_rows}
            <rect x="24" y="630" width="372" height="50" rx="12" fill={SURFACE2} stroke={BORDER2} />
            <text x="210" y="661" text-anchor="middle" font-size="16" font-weight="600" fill={TEXT}>"View read-only Pi session"</text>
        </g>
        {tap(t, run_at, 210.0, 327.0)}
        {tap(t, open_at, 210.0, 590.0)}
    </g>);
    fframes::svgr!(<g>
        {caption(t, 0.2, 99.0, "08  RUN HISTORY", ["Trigger it any time.", "Every run is kept."], ["Tap Run now, watch it land", "in history, open the result."])}
        {phone("clip-runs", PHONE_X, PHONE_Y, screen)}
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

pub struct PromoVideoVideo<'a> {
    pub media: &'a PromoVideoMedia,
    shots: Vec<Shot>,
}

impl<'a> PromoVideoVideo<'a> {
    pub fn new(media: &'a PromoVideoMedia) -> Self {
        let shots = [
            (Kind::Intro, 3.6),
            (Kind::Terminal, 8.6),
            (Kind::Pair, 6.4),
            (Kind::Connect, 6.6),
            (Kind::Session, 8.4),
            (Kind::Ask, 7.0),
            (Kind::Automation, 8.4),
            (Kind::Runs, 8.6),
            (Kind::Outro, 5.0),
        ]
        .into_iter()
        .map(|(kind, secs)| Shot { kind, secs })
        .collect();
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
        AudioMap::none()
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
