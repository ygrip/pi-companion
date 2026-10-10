export type TerminalSpan = { text: string; color?: string; background?: string; bold: boolean; inverse: boolean };
const palette = ['#151515', '#ef7777', '#8ed28e', '#ead17c', '#82aaff', '#c792ea', '#89ddff', '#dddddd', '#777777', '#ff9999', '#b9f6b9', '#fff0a0', '#adc6ff', '#e5b3ff', '#b2efff', '#ffffff'];
function indexed(n: number): string {
  if (n < 16) return palette[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const c = n - 16; const level = (v: number) => v === 0 ? 0 : 55 + v * 40;
  return `rgb(${level(Math.floor(c / 36))},${level(Math.floor(c / 6) % 6)},${level(c % 6)})`;
}
/** SGR only; all other terminal controls are discarded. Text is rendered by Svelte, not innerHTML. */
export function terminalSpans(line: string): TerminalSpan[] {
  const spans: TerminalSpan[] = [];
  let state: Omit<TerminalSpan, 'text'> = { bold: false, inverse: false };
  const tokens = line.split(/(\x1b\[[0-9;]*m)/g);
  for (const token of tokens) {
    if (/^\x1b\[[0-9;]*m$/.test(token)) {
      const codes = token.slice(2, -1).split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const n = codes[i];
        if (n === 0) state = { bold: false, inverse: false };
        else if (n === 1 || n === 22) state.bold = n === 1;
        else if (n === 7 || n === 27) state.inverse = n === 7;
        else if (n === 39) state.color = undefined;
        else if (n === 49) state.background = undefined;
        else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) state.color = palette[n >= 90 ? n - 90 + 8 : n - 30];
        else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) state.background = palette[n >= 100 ? n - 100 + 8 : n - 40];
        else if (n === 38 || n === 48) {
          let color: string | undefined;
          if (codes[i + 1] === 2 && codes.slice(i + 2, i + 5).length === 3) {
            const rgb = codes.slice(i + 2, i + 5).map(v => Math.max(0, Math.min(255, v)));
            color = `rgb(${rgb.join(',')})`; i += 4;
          } else if (codes[i + 1] === 5 && codes[i + 2] >= 0 && codes[i + 2] <= 255) { color = indexed(codes[i + 2]); i += 2; }
          if (color) state[n === 38 ? 'color' : 'background'] = color;
        }
      }
    } else {
      const text = token.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (text) spans.push({ text, ...state });
    }
  }
  return spans;
}
export function popupKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'> & { shiftKey?: boolean }): string | undefined {
  if (event.metaKey) return;
  if (event.key === 'Tab' && event.shiftKey) return '\x1b[Z';
  const keys: Record<string, string> = { Enter: '\r', Escape: '\x1b', Tab: '\t', Backspace: '\x7f', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~' };
  if (event.ctrlKey && /^[a-z]$/i.test(event.key)) return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
  const data = keys[event.key] ?? (event.key.length === 1 ? event.key : undefined);
  return data && event.altKey ? '\x1b' + data : data;
}
