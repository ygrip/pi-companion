import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Custom session entry holding a model-written title; survives resume and reload. */
export const TITLE_ENTRY = "companion:title";

/** Stable, compact key for a prompt so the session file never stores the prompt twice. */
export function promptKey(prompt: string) {
  return createHash("sha256").update(prompt.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

/** Collect saved titles from session entries; later entries win. */
export function savedTitles(entries: readonly unknown[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const entry of entries as Array<{ type?: string; customType?: string; data?: { key?: unknown; title?: unknown } }>) {
    if (entry?.type !== "custom" || entry.customType !== TITLE_ENTRY) continue;
    const { key, title } = entry.data ?? {};
    if (typeof key === "string" && typeof title === "string" && title.trim()) titles.set(key, title.trim().slice(0, 80));
  }
  return titles;
}

const MAX_TITLE = 60;

/** Normalise a prompt into plain prose: drop code, links, markdown and paths' noise. */
function plain(prompt: string) {
  return prompt
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*(?:[-*>#]+|\d+[.)])\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Instant, local title: the opening clause of the prompt, cut at a word boundary.
 * Short prompts are kept verbatim so a human still recognises them.
 */
export function heuristicTitle(prompt: string): string {
  const text = plain(prompt);
  if (!text) return "";
  if (text.length <= MAX_TITLE) return capitalise(text.replace(/[.!?,;:]+$/, ""));
  const clause = text.split(/(?<=[.!?])\s+|[;\n]|,\s+(?=(?:and|then|also|but)\b)/i)[0]?.trim() || text;
  const source = clause.length >= 12 ? clause : text;
  if (source.length <= MAX_TITLE) return capitalise(source.replace(/[.!?,;:]+$/, ""));
  const cut = source.slice(0, MAX_TITLE);
  const boundary = cut.lastIndexOf(" ");
  return capitalise((boundary > 24 ? cut.slice(0, boundary) : cut).replace(/[\s.,;:!?-]+$/, "")) + "…";
}

function capitalise(text: string) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Whether a model-written summary would read better than the local heuristic. */
export function needsInference(prompt: string) {
  return plain(prompt).length > 48;
}

/** Clean a model reply into a single short title line, or "" when unusable. */
export function cleanInferredTitle(reply: string): string {
  const line = reply.replace(/<[^>]+>/g, " ").split("\n").map(part => part.trim()).find(Boolean) ?? "";
  const title = line.replace(/^(?:title\s*:\s*)/i, "").replace(/^["'`*#\s]+|["'`*.\s]+$/g, "").replace(/\s+/g, " ");
  if (!title || title.length > 80) return "";
  return capitalise(title);
}

const PROMPT = [
  "Write a short title (3 to 7 words) for a coding-agent session that starts with the user request below.",
  "Capture the actual intent, not the first words. Use plain sentence case, no quotes, no trailing punctuation.",
  "Reply with the title only.",
].join(" ");

/**
 * Ask the session's own model for a concise title. Best effort: returns "" on any failure,
 * missing credentials, or timeout, so the caller keeps the heuristic title.
 */
export async function inferTitle(ctx: ExtensionContext, prompt: string, timeoutMs = 20_000): Promise<string> {
  const registry = ctx.modelRegistry;
  const model = ctx.model;
  if (!registry || !model || typeof registry.complete !== "function") return "";
  try {
    if (typeof registry.hasConfiguredAuth === "function" && !registry.hasConfiguredAuth(model)) return "";
    const request = plain(prompt).slice(0, 4000);
    const response = await registry.complete(model, {
      messages: [{ role: "user", content: [{ type: "text", text: `${PROMPT}\n\n<request>\n${request}\n</request>` }], timestamp: Date.now() }],
    }, { maxTokens: 1024, cacheRetention: "none", signal: AbortSignal.timeout(timeoutMs) });
    const text = (response?.content ?? [])
      .filter((part): part is { type: "text"; text: string } => part?.type === "text")
      .map(part => part.text).join("\n");
    return cleanInferredTitle(text);
  } catch {
    return "";
  }
}
