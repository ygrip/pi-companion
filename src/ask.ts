import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AskAnswers, AskOption, AskQuestion, AskRequest } from "./protocol.js";

export type AskInput = Omit<AskRequest, "requestId" | "createdAt">;

/** What the dialog relay needs from the bridge. */
export interface AskChannel {
  /** Resolves with the answers, or null when withdrawn (signal) or dismissed in the companion UI. */
  ask(request: AskInput, signal?: AbortSignal): Promise<AskAnswers | null>;
}

const RELAYED = Symbol.for("pi-companion.dialog-relay");

/**
 * Mirror other extensions' ctx.ui dialogs (select / confirm / input) to the companion UI.
 *
 * Pi hands every extension the same ui object, so patching it once per object covers all of
 * them. The terminal dialog stays open; whichever side answers first wins and the other is
 * dismissed. `editor` takes no AbortSignal, so it stays terminal-only. `custom` dialogs are
 * relayed only for known question tools (see ToolDialogRelay).
 */
export function relayDialogs(ui: ExtensionUIContext, channel: AskChannel, tools: ToolDialogRelay) {
  const target = ui as ExtensionUIContext & { [RELAYED]?: true };
  if (target[RELAYED]) return;
  target[RELAYED] = true;

  const select = ui.select.bind(ui);
  const confirm = ui.confirm.bind(ui);
  const input = ui.input.bind(ui);
  const custom = ui.custom.bind(ui);
  const originals = { select: ui.select, confirm: ui.confirm, input: ui.input, custom: ui.custom };

  ui.custom = (factory, options) => {
    const complete = tools.claim();
    if (!complete) return custom(factory, options);
    return custom((tui, theme, keybindings, done) => {
      complete((result) => done(result as never));
      return factory(tui, theme, keybindings, done);
    }, options);
  };
  ui.select = (title, options, opts) =>
    race(
      channel,
      { source: "select", questions: [{ id: "answer", question: title, options: options.map(label => ({ label })) }] },
      signal => select(title, options, { ...opts, signal }),
      answers => {
        const value = answers.answer?.[0];
        return value !== undefined && options.includes(value) ? value : undefined;
      },
      undefined,
      opts?.signal
    );

  ui.confirm = (title, message, opts) =>
    race(
      channel,
      {
        source: "confirm",
        title,
        questions: [{ id: "answer", question: message || title, options: [{ label: "Yes" }, { label: "No" }] }]
      },
      signal => confirm(title, message, { ...opts, signal }),
      answers => answers.answer?.[0] === "Yes",
      false,
      opts?.signal
    );

  ui.input = (title, placeholder, opts) =>
    race(
      channel,
      { source: "input", questions: [{ id: "answer", question: title, options: [], allowCustom: true, placeholder }] },
      signal => input(title, placeholder, { ...opts, signal }),
      answers => answers.answer?.[0],
      undefined,
      opts?.signal
    );

  return () => {
    Object.assign(ui, originals);
    delete target[RELAYED];
  };
}

async function race<T>(
  channel: AskChannel,
  request: AskInput,
  local: (signal: AbortSignal) => Promise<T>,
  fromAnswers: (answers: AskAnswers) => T,
  dismissed: T,
  outer?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  try {
    const outcome = await Promise.race([
      local(signal).then(value => ({ value })),
      channel.ask(request, signal).then(answers => ({ answers }))
    ]);
    if ("value" in outcome) return outcome.value;
    return outcome.answers ? fromAnswers(outcome.answers) : dismissed;
  } finally {
    controller.abort(); // closes whichever side is still open
  }
}

/** Normalize tool-supplied questions (strings or objects) into the wire shape. */
export function toQuestions(
  input: Array<{ question: string; header?: string; options?: Array<string | AskOption>; multiSelect?: boolean; allowCustom?: boolean }>
): AskQuestion[] {
  return input.map((item, index) => ({
    id: "q" + (index + 1),
    question: item.question,
    header: item.header,
    options: (item.options ?? []).map(option => (typeof option === "string" ? { label: option } : option)),
    multiSelect: item.multiSelect ?? false,
    allowCustom: item.allowCustom ?? true
  }));
}

/** Plain-text answer summary returned to the model. */
export function formatAnswers(questions: AskQuestion[], answers: AskAnswers) {
  return questions
    .map(question => {
      const chosen = answers[question.id] ?? [];
      return (questions.length > 1 ? question.question + "\n→ " : "") + (chosen.length ? chosen.join(", ") : "(no answer)");
    })
    .join("\n\n");
}

/** A question tool that shows one ctx.ui.custom dialog per question. */
type ToolAdapter = {
  questions(args: unknown): AskQuestion[] | null;
  /** Value the tool's dialog resolves with for chosen values, or for a dismissal (undefined). */
  result(values: string[] | undefined): unknown;
};

const TOOL_ADAPTERS: Record<string, ToolAdapter> = {
  // pi-jar: jar_ask resolves each picker with { kind: "answer", selected } or { kind: "cancel" };
  // `selected` is passed through verbatim, so free-text answers fit as well.
  jar_ask: {
    questions(args) {
      if (!args || typeof args !== "object" || !("questions" in args) || !Array.isArray(args.questions)) return null;
      const items: unknown[] = args.questions;
      return items.flatMap((item, index) => {
        if (!item || typeof item !== "object" || !("question" in item) || typeof item.question !== "string") return [];
        const options = "options" in item && Array.isArray(item.options) ? item.options : [];
        return [{
          id: "q" + (index + 1),
          question: item.question,
          header: "header" in item && typeof item.header === "string" ? item.header : undefined,
          options: options.flatMap((option: unknown) =>
            option && typeof option === "object" && "label" in option && typeof option.label === "string"
              ? [{ label: option.label, description: "description" in option && typeof option.description === "string" ? option.description : undefined }]
              : []
          ),
          multiSelect: "multi" in item && item.multi === true,
          allowCustom: !("allowCustom" in item && item.allowCustom === false)
        }];
      });
    },
    result: values => (values ? { kind: "answer", selected: values } : { kind: "cancel" })
  }
};

type ActiveToolAsk = {
  toolCallId: string;
  adapter: ToolAdapter;
  questions: AskQuestion[];
  /** Index the next ctx.ui.custom call belongs to. */
  next: number;
  /** Question whose dialog is open now. */
  current: number;
  /** undefined: unanswered; null: dismissed in the companion UI. */
  answers?: AskAnswers | null;
  finish?: (result: unknown) => void;
  controller: AbortController;
};

/**
 * Relays question tools whose dialogs are ctx.ui.custom components (no AbortSignal).
 * The tool's questions are published when it starts; a companion answer completes the open
 * dialog through its own done() and pre-answers the remaining ones. Answering in the
 * terminal still works; the companion question is withdrawn when the tool ends.
 */
export class ToolDialogRelay {
  private active?: ActiveToolAsk;

  constructor(private readonly channel: AskChannel) {}

  start(toolName: string, toolCallId: string, args: unknown) {
    const adapter = TOOL_ADAPTERS[toolName];
    if (!adapter) return;
    const questions = adapter.questions(args);
    if (!questions?.length) return;
    // A previous relayed tool that never reported its end must not block this question.
    this.active?.controller.abort();
    // Published even while the daemon is unreachable: pending questions are part of the
    // session snapshot that is re-registered on reconnect, so they show up the moment it is back.
    const active: ActiveToolAsk = { toolCallId, adapter, questions, next: 0, current: -1, controller: new AbortController() };
    this.active = active;
    void this.channel.ask({ source: "tool", questions }, active.controller.signal).then(answers => {
      if (this.active !== active || active.controller.signal.aborted) return;
      active.answers = answers;
      active.finish?.(this.resultFor(active, active.current));
      active.finish = undefined;
    });
  }

  end(toolCallId: string) {
    if (this.active?.toolCallId !== toolCallId) return;
    this.active.controller.abort();
    this.active = undefined;
  }

  /** For a ctx.ui.custom call during a relayed tool: a hook that receives that dialog's done(). */
  claim(): ((finish: (result: unknown) => void) => void) | undefined {
    const active = this.active;
    if (!active || active.next >= active.questions.length) return undefined;
    const index = active.next++;
    return finish => {
      active.current = index;
      if (active.answers !== undefined) queueMicrotask(() => finish(this.resultFor(active, index)));
      else active.finish = finish;
    };
  }

  private resultFor(active: ActiveToolAsk, index: number) {
    const question = active.questions[index];
    return active.adapter.result(active.answers && question ? active.answers[question.id] ?? [] : undefined);
  }
}
