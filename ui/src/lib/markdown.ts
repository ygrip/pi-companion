import DOMPurify from 'dompurify';
import type { HLJSApi } from 'highlight.js';
import { marked } from 'marked';
import type { Mermaid } from 'mermaid';

/**
 * Pi's replies are Markdown. Render them to sanitized HTML; code highlighting and Mermaid
 * diagrams are applied afterwards by the `prettify` action, loading their libraries lazily.
 */
marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

/** An escaped <pre><code> block for the `prettify` action to highlight. */
export function codeBlock(text: string, lang: string) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<pre><code class="language-' + lang + '">' + escaped + '</code></pre>';
}

type Hljs = HLJSApi;

let hljs: Promise<Hljs> | null = null;
let mermaid: Promise<Mermaid> | null = null;
let diagramId = 0;

function loadHljs() {
  hljs ??= import('highlight.js/lib/common').then((module) => module.default);
  return hljs;
}

function loadMermaid() {
  mermaid ??= import('mermaid').then((module) => module.default);
  return mermaid;
}

function mermaidTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'neutral' : 'dark';
}

async function highlight(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>('pre code:not(.hljs):not(.language-mermaid)');
  if (!blocks.length) return;
  const lib = await loadHljs();
  for (const block of blocks) {
    const lang = /language-([\w-]+)/.exec(block.className)?.[1];
    if (lang && !lib.getLanguage(lang)) block.className = block.className.replace(/language-[\w-]+/, '');
    lib.highlightElement(block);
  }
}

async function diagrams(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
  if (!blocks.length) return;
  const lib = await loadMermaid();
  lib.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mermaidTheme() });
  for (const block of blocks) {
    const pre = block.parentElement;
    if (!pre?.isConnected) continue;
    try {
      const { svg } = await lib.render('pc-mermaid-' + ++diagramId, block.textContent ?? '');
      const figure = document.createElement('figure');
      figure.className = 'mermaid-diagram';
      figure.innerHTML = svg;
      pre.replaceWith(figure);
    } catch {
      // Incomplete or invalid diagram (often mid-stream): leave the source visible.
      block.classList.add('hljs');
    }
  }
}

/**
 * Svelte action: highlight code and draw diagrams inside rendered Markdown.
 * `final` is false while text is still streaming; diagrams wait for the final text.
 */
export function prettify(node: HTMLElement, params: { text: string; final: boolean }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = ({ final }: { text: string; final: boolean }) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void highlight(node);
      if (final) void diagrams(node);
    }, final ? 0 : 250);
  };
  run(params);
  return {
    update: run,
    destroy: () => clearTimeout(timer)
  };
}

/** Highlight a whole text blob as JSON when it parses, for tool arguments and results. */
export function looksLikeJson(text: string) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function prettyJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text.trim()), null, 2);
  } catch {
    return text;
  }
}
