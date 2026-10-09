export type ResultSection = { title: string; content: string };

/** Daemon phase markers are only recognised on their own line, outside fenced blocks. */
export function resultSections(text: string): ResultSection[] {
  const sections: ResultSection[] = [];
  let title = 'Summary';
  let lines: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (lines.join('\n').trim()) sections.push({ title, content: lines.join('\n').trim() });
    lines = [];
  };
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    const phase = !fence && /^\[(precondition|action|post-action)\]\s*$/.exec(line);
    if (phase) {
      flush();
      title = { precondition: 'Precondition · Eligibility', action: 'Action · Execution', 'post-action': 'Post-action · Summary' }[phase[1]] ?? 'Output';
    } else lines.push(line);
  }
  flush();
  return sections;
}

type AdfNode = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: AdfNode[]; marks?: AdfNode[] };
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function safeResultLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** No raw HTML, arbitrary attributes, executable links or remote media from ADF. */
export function adfHtml(value: unknown, depth = 0): string {
  if (depth > 40 || !value || typeof value !== 'object' || Array.isArray(value)) return '';
  const node = value as AdfNode;
  const children = Array.isArray(node.content) ? node.content.map(n => adfHtml(n, depth + 1)).join('') : '';
  const attrs = node.attrs ?? {};
  if (node.type === 'text') {
    let text = escape(node.text);
    for (const mark of Array.isArray(node.marks) ? node.marks : []) {
      const tag = { strong: 'strong', em: 'em', strike: 's', code: 'code', underline: 'u' }[mark.type ?? ''];
      if (tag) text = `<${tag}>${text}</${tag}>`;
      else if (mark.type === 'link') {
        const href = safeResultLink(mark.attrs?.href);
        if (href) text = `<a href="${escape(href)}" rel="noopener noreferrer">${text}</a>`;
      }
    }
    return text;
  }
  switch (node.type) {
    case 'doc': return children;
    case 'paragraph': return `<p>${children}</p>`;
    case 'heading': {
      const level = Math.max(1, Math.min(6, Number(attrs.level) || 2));
      return `<h${level}>${children}</h${level}>`;
    }
    case 'bulletList': return `<ul>${children}</ul>`;
    case 'orderedList': return `<ol>${children}</ol>`;
    case 'listItem': case 'taskItem': return `<li>${children}</li>`;
    case 'taskList': return `<ul>${children}</ul>`;
    case 'blockquote': case 'panel': return `<blockquote>${children}</blockquote>`;
    case 'codeBlock': return `<pre><code>${escape(Array.isArray(node.content) ? node.content.map(n => n.text ?? '').join('') : '')}</code></pre>`;
    case 'hardBreak': return '<br>';
    case 'rule': return '<hr>';
    case 'table': return `<table><tbody>${children}</tbody></table>`;
    case 'tableRow': return `<tr>${children}</tr>`;
    case 'tableCell': return `<td>${children}</td>`;
    case 'tableHeader': return `<th>${children}</th>`;
    case 'mention': return escape(attrs.text ?? attrs.id);
    case 'emoji': return escape(attrs.text ?? attrs.shortName);
    case 'status': return `<strong>${escape(attrs.text)}</strong>`;
    case 'inlineCard': case 'blockCard': {
      const href = safeResultLink(attrs.url);
      return href ? `<a href="${escape(href)}" rel="noopener noreferrer">${escape(attrs.url)}</a>` : escape(attrs.url);
    }
    case 'media': return '<p>[Attachment: view original source]</p>';
    default: return children || escape(node.text);
  }
}

/** Whole JSON / fenced JSON documents are recognised; prose is never executed. */
export function structuredResult(text: string): { kind: 'adf' | 'json'; value: unknown } | null {
  const source = text.trim().replace(/^```(?:json|adf)?\s*\n([\s\S]*?)\n```\s*$/, '$1');
  try {
    const value: unknown = JSON.parse(source);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const doc = value as Record<string, unknown>;
      if (doc.type === 'doc' && Array.isArray(doc.content)) return { kind: 'adf', value };
      if (doc.adf && typeof doc.adf === 'object' && (doc.adf as Record<string, unknown>).type === 'doc') return { kind: 'adf', value: doc.adf };
    }
    return { kind: 'json', value };
  } catch { return null; }
}
