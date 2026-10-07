import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AskAnswers, AskOption, AskQuestion, AskRequest } from "./protocol.js";

export type AskInput = Omit<AskRequest, "requestId" | "createdAt">;

/** What the dialog relay needs from the bridge. */
export interface AskChannel {
  isConnected(): boolean;
  /** Resolves with the answers, or null when withdrawn (signal) or dismissed in the companion UI. */
  ask(request: AskInput, signal?: AbortSignal): Promise<AskAnswers | null>;
}

const RELAYED = Symbol.for("pi-companion.dialog-relay");

/**
 * Mirror other extensions' ctx.ui dialogs (select / confirm / input) to the companion UI.
 *
 * Pi hands every extension the same ui object, so patching it once per object covers all of
 * them. The terminal dialog stays open; whichever side answers first wins and the other is
 * dismissed. `editor` and `custom` take no AbortSignal, so they stay terminal-only.
 */
export function relayDialogs(ui: ExtensionUIContext, channel: AskChannel) {
  const target = ui as ExtensionUIContext & { [RELAYED]?: true };
  if (target[RELAYED]) return;
  target[RELAYED] = true;

  const select = ui.select.bind(ui);
  const confirm = ui.confirm.bind(ui);
  const input = ui.input.bind(ui);

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
  if (!channel.isConnected()) return await local(signal);
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
