import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TerminalPopup } from "./protocol.js";

type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type FactoryArgs = Parameters<CustomFactory>;
type PopupFactory<T> = (tui: FactoryArgs[0], theme: FactoryArgs[1], keys: FactoryArgs[2], done: (result: T) => void) => ReturnType<CustomFactory>;

/** Mirrors rendered terminal lines, never serializes or evaluates extension code in the browser. */
export class PopupRelay {
  private frameTimer?: NodeJS.Timeout;
  private generation = 0;
  private active = new Map<string, { frame: TerminalPopup; input: (data: string) => void; close: () => void }>();
  constructor(private publish: (popups: TerminalPopup[]) => void) {}

  wrap<T>(factory: PopupFactory<T>) {
    return async (...args: Parameters<typeof factory>) => {
      const [tui, theme, keys, done] = args;
      const generation = this.generation;
      const id = randomUUID();
      let finished = false;
      const remove = () => {
        finished = true;
        if (this.active.delete(id)) this.flush();
      };
      const finish = (result: T) => { if (finished) return; remove(); done(result); };
      const component = await factory(tui, theme, keys, finish);
      if (finished || generation !== this.generation) return component;
      const entry = {
        frame: { id, lines: [], width: 0 } as TerminalPopup,
        input: (data: string) => { component.handleInput?.(data); tui.requestRender(); },
        // Let the component produce its own cancellation result; arbitrary factories
        // may require a tagged result rather than undefined.
        close: () => { component.handleInput?.("\x1b"); tui.requestRender(); }
      };
      this.active.set(id, entry);
      // Patch the instance rather than proxying it: preserve focus, cursor and mouse behavior.
      const render = component.render;
      const dispose = component.dispose;
      component.render = function(width) {
        const lines = render.call(this, width);
        if (!finished && relay.active.has(id)) {
          let budget = 128_000;
          const bounded: string[] = [];
          for (const line of lines.slice(0, 500)) {
            const text = line.slice(0, Math.min(16384, budget));
            bounded.push(text);
            budget -= text.length;
            if (budget <= 0) break;
          }
          const frame = { id, width, lines: bounded };
          if (JSON.stringify(frame) !== JSON.stringify(entry.frame)) {
            const firstFrame = entry.frame.width === 0;
            entry.frame = frame;
            if (firstFrame) relay.flush();
            else relay.scheduleFrame();
          }
        }
        return lines;
      };
      const relay = this;
      component.dispose = function() { remove(); dispose?.call(this); };
      return component;
    };
  }

  input(id: string, data: unknown) {
    if (typeof data === "string" && data.length > 0 && data.length <= 4096) this.active.get(id)?.input(data);
  }
  close(id: string) { this.active.get(id)?.close(); }
  /** Stop mirroring without terminating the user's local dialog. */
  clear() { this.generation++; if (!this.active.size) return; this.active.clear(); this.flush(); }
  private scheduleFrame() {
    if (this.frameTimer) return;
    this.frameTimer = setTimeout(() => this.flush(), 50);
    this.frameTimer.unref();
  }
  private flush() {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = undefined;
    this.publish([...this.active.values()].map(entry => entry.frame));
  }
}
