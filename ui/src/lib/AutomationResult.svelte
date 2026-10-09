<script lang="ts">
  import DOMPurify from 'dompurify';
  import Icon from './Icon.svelte';
  import { renderMarkdown, prettify } from './markdown.ts';
  import { resultSections, structuredResult, adfHtml } from './automation-result.ts';
  let { text, running = false }: { text: string; running?: boolean } = $props();
  let raw = $state(false);
  let copied = $state(false);
  let copyError = $state('');
  const sections = $derived(resultSections(text));
  function html(content: string) {
    const structured = structuredResult(content);
    if (structured?.kind === 'adf') return DOMPurify.sanitize(adfHtml(structured.value));
    return renderMarkdown(content);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); copied = true; copyError = ''; }
    catch { copyError = 'Clipboard unavailable. Select text in the raw view to copy.'; }
  }
</script>
<section class="automation-result" aria-label="Run output">
  <div class="result-toolbar"><div><h2>Output &amp; summary</h2><p class="subtle">{raw ? 'Original captured output' : 'Markdown, tables, ADF & structured JSON'}</p></div><div class="result-controls"><button class="btn btn-sm" aria-pressed={raw} onclick={() => raw = !raw}><Icon name="file" size={15} />{raw ? 'Formatted view' : 'Raw output'}</button><button class="btn btn-sm" onclick={copy}><Icon name="copy" size={15} />{copied ? 'Copied' : 'Copy'}</button></div></div>
  {#if copyError}<p role="status" class="subtle">{copyError}</p>{/if}
  {#if !text}<div class="automation-empty"><Icon name="chat" size={28} /><p>{running ? 'The run is working. Output is captured when each step finishes.' : 'No output was recorded for this run.'}</p></div>
  {:else if raw}<pre class="raw-output">{text}</pre>
  {:else}
    {#each sections as section, index (`${index}-${section.title}`)}
      {@const structured = structuredResult(section.content)}
      <section class="output-section"><header><span class="step-number">{String(index + 1).padStart(2, '0')}</span><h3>{section.title}</h3><span class="format-label">{structured?.kind === 'adf' ? 'ADF' : structured?.kind === 'json' ? 'JSON' : 'Markdown'}</span></header>
        {#if structured?.kind === 'json'}<pre class="raw-output">{JSON.stringify(structured.value, null, 2)}</pre>
        {:else}<div class="rich-output" use:prettify={{ text: section.content, final: !running }}>{@html html(section.content)}</div>{/if}
      </section>
    {/each}
  {/if}
</section>
<style>
  .result-toolbar, .result-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; } .result-toolbar { padding-bottom: 20px; } .result-toolbar p { font-size: .76rem; margin-top: 5px; } .output-section { margin-top: 16px; border: 1px solid var(--border); border-radius: 18px; background: var(--surface-2); box-shadow: var(--clay-soft); min-width: 0; overflow: hidden; } .output-section > header { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); } h3 { font-size: .8rem; } .step-number { font: .7rem var(--mono); color: var(--accent-text); } .format-label { margin-left: auto; font-size: .64rem; font-weight: 600; color: var(--text-2); } .raw-output { padding: 18px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .78rem; line-height: 1.75; background: var(--code-bg); border-radius: 14px; max-height: 65vh; overflow: auto; } .rich-output { padding: 20px; min-width: 0; overflow-x: auto; line-height: 1.75; font-size: .88rem; }
  .rich-output :global(h1), .rich-output :global(h2), .rich-output :global(h3) { margin: 20px 0 10px; line-height: 1.4; font-size: 1.05rem; } .rich-output :global(> :first-child) { margin-top: 0; } .rich-output :global(p) { margin: 10px 0; } .rich-output :global(a) { color: var(--accent-text); text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; } .rich-output :global(table) { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: .8rem; } .rich-output :global(th), .rich-output :global(td) { text-align: left; padding: 12px 14px; border: 1px solid var(--border-strong); min-width: 130px; vertical-align: top; } .rich-output :global(th) { background: var(--accent-soft); font-weight: 650; } .rich-output :global(tr:nth-child(even)) { background: var(--surface); } .rich-output :global(pre) { padding: 16px; background: var(--code-bg); border-radius: 12px; overflow: auto; } .rich-output :global(code) { background: var(--code-bg); border-radius: 5px; padding: 2px 5px; } .rich-output :global(pre code) { padding: 0; } .rich-output :global(blockquote) { border-left: 3px solid var(--accent); margin: 16px 0; padding: 8px 16px; background: var(--accent-soft); border-radius: 0 12px 12px 0; } .rich-output :global(img), .rich-output :global(svg) { max-width: 100%; height: auto; } .rich-output :global(li) { margin: 4px 0; } .rich-output :global(hr) { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
  @media(max-width: 550px) { .rich-output { padding: 14px; } .output-section > header { padding: 12px; } .result-controls .btn { min-height: 44px; } }
</style>
