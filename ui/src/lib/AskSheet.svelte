<script lang="ts">
  import Icon from './Icon.svelte';
  import { companion } from './companion.svelte.ts';
  import { toasts } from './toast.svelte.ts';
  import type { AskAnswers, AskQuestion, AskRequest } from './types.ts';

  /**
   * Bottom sheet for Pi's questions: companion_ask_user (1-4 questions, single or multi select,
   * optional free text) and dialogs relayed from other extensions (select / confirm / input).
   * It opens by itself for each new question; "Later" hides it until the user reopens it.
   */
  let { sessionId, asks, open = $bindable(false) }: { sessionId: string; asks: AskRequest[]; open?: boolean } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let index = $state(0);
  let picked = $state<Record<string, string[]>>({});
  let other = $state<Record<string, string>>({});
  let otherOn = $state<Record<string, boolean>>({});

  const ask = $derived(asks[Math.min(index, asks.length - 1)]);
  const OTHER = '__other__';

  const sourceLabel: Record<AskRequest['source'], string> = {
    companion: 'Pi is asking',
    select: 'Choose an option',
    confirm: 'Confirm',
    input: 'Pi needs input'
  };

  // Open for every question we have not seen yet; keep "Later" for ones already shown.
  const seen = new Set<string>();
  $effect(() => {
    let fresh = false;
    for (const item of asks) {
      if (!seen.has(item.requestId)) {
        seen.add(item.requestId);
        fresh = true;
      }
    }
    if (fresh) open = true;
    if (!asks.length) open = false;
    if (index >= asks.length) index = 0;
  });

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });

  // New question → fresh form.
  let current = '';
  $effect(() => {
    const id = ask?.requestId ?? '';
    if (id === current) return;
    current = id;
    picked = {};
    other = {};
    otherOn = {};
  });

  function freeText(question: AskQuestion) {
    return question.options.length === 0;
  }

  function answerFor(question: AskQuestion) {
    if (freeText(question)) {
      const text = (other[question.id] ?? '').trim();
      return text ? [text] : [];
    }
    const values = [...(picked[question.id] ?? [])];
    const custom = (other[question.id] ?? '').trim();
    if (otherOn[question.id] && custom) values.push(custom);
    return values;
  }

  const complete = $derived(Boolean(ask) && ask.questions.every((question) => answerFor(question).length > 0));
  // One single-choice question without free text: a tap is the answer.
  const instant = $derived(
    Boolean(ask) && ask.questions.length === 1 && !ask.questions[0].multiSelect && !ask.questions[0].allowCustom && !freeText(ask.questions[0])
  );

  function choose(question: AskQuestion, label: string) {
    if (label === OTHER) {
      const on = !otherOn[question.id];
      otherOn = { ...otherOn, [question.id]: on };
      if (!question.multiSelect && on) picked = { ...picked, [question.id]: [] };
      return;
    }
    const current = picked[question.id] ?? [];
    if (question.multiSelect) {
      picked = { ...picked, [question.id]: current.includes(label) ? current.filter((v) => v !== label) : [...current, label] };
      return;
    }
    picked = { ...picked, [question.id]: [label] };
    otherOn = { ...otherOn, [question.id]: false };
    if (instant) submit();
  }

  function submit() {
    if (!ask || !complete) return;
    const answers: AskAnswers = {};
    for (const question of ask.questions) answers[question.id] = answerFor(question);
    if (!companion.answer(sessionId, ask.requestId, answers)) toasts.show('Not connected. Try again in a moment.', 'error');
  }

  function skip() {
    if (!ask) return;
    if (!companion.dismissAsk(sessionId, ask.requestId)) toasts.show('Not connected. Try again in a moment.', 'error');
  }

  function later() {
    open = false;
  }
</script>

<dialog
  class="sheet ask-sheet"
  bind:this={dialog}
  aria-labelledby="ask-title"
  oncancel={(event) => { event.preventDefault(); later(); }}
  onclick={(event) => { if (event.target === dialog) later(); }}>
  {#if ask}
    <div class="sheet-grip" aria-hidden="true"></div>
    <div class="sheet-head">
      <span class="ask-icon"><Icon name="question" size={18} /></span>
      <div class="head-text">
        <span class="eyebrow">{sourceLabel[ask.source]}</span>
        {#if ask.title}<strong id="ask-title">{ask.title}</strong>{:else}<strong id="ask-title" class="sr-only">Question from Pi</strong>{/if}
      </div>
      {#if asks.length > 1}
        <div class="pager" role="group" aria-label="Questions waiting">
          <button class="btn btn-ghost btn-icon" aria-label="Previous question" disabled={index === 0} onclick={() => (index -= 1)}><Icon name="back" size={16} /></button>
          <span class="badge count" role="status">{index + 1}/{asks.length}</span>
          <button class="btn btn-ghost btn-icon" aria-label="Next question" disabled={index >= asks.length - 1} onclick={() => (index += 1)}><Icon name="chevron" size={16} /></button>
        </div>
      {/if}
    </div>

    <form class="sheet-body scroll" id="ask-form" onsubmit={(event) => { event.preventDefault(); submit(); }}>
      {#each ask.questions as question (question.id)}
        <fieldset class="question">
          <legend>
            {#if question.header}<span class="chip on">{question.header}</span>{/if}
            <span class="q">{question.question}</span>
            {#if question.multiSelect}<span class="subtle hint">Choose any</span>{/if}
          </legend>

          {#if freeText(question)}
            <label class="sr-only" for="free-{question.id}">Your answer</label>
            <textarea
              id="free-{question.id}"
              class="textarea"
              rows="3"
              placeholder={question.placeholder || 'Type your answer'}
              bind:value={other[question.id]}></textarea>
          {:else}
            <div class="options">
              {#each question.options as option (option.label)}
                {@const on = (picked[question.id] ?? []).includes(option.label)}
                <label class="option" class:on>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name="opt-{ask.requestId}-{question.id}"
                    checked={on}
                    onchange={() => choose(question, option.label)} />
                  <span class="mark" aria-hidden="true"><Icon name="check" size={14} /></span>
                  <span class="option-text">
                    <strong>{option.label}</strong>
                    {#if option.description}<span class="muted">{option.description}</span>{/if}
                  </span>
                </label>
              {/each}
              {#if question.allowCustom}
                <label class="option" class:on={otherOn[question.id]}>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name="opt-{ask.requestId}-{question.id}"
                    checked={Boolean(otherOn[question.id])}
                    onchange={() => choose(question, OTHER)} />
                  <span class="mark" aria-hidden="true"><Icon name="check" size={14} /></span>
                  <span class="option-text"><strong>Other</strong><span class="muted">Write your own answer</span></span>
                </label>
                {#if otherOn[question.id]}
                  <label class="sr-only" for="other-{question.id}">Your own answer</label>
                  <!-- svelte-ignore a11y_autofocus -->
                  <input id="other-{question.id}" class="input" autocomplete="off" autofocus placeholder="Your answer" bind:value={other[question.id]} />
                {/if}
              {/if}
            </div>
          {/if}
        </fieldset>
      {/each}
    </form>

    <div class="sheet-foot">
      <button type="button" class="btn" onclick={later}>Later</button>
      <button type="button" class="btn btn-ghost" onclick={skip}>Skip</button>
      {#if !instant}
        <button type="submit" form="ask-form" class="btn btn-primary" disabled={!complete}><Icon name="send" size={16} />Answer</button>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  .ask-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .head-text {
    display: grid;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }

  .head-text strong {
    overflow-wrap: anywhere;
  }

  .pager {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .question {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  legend {
    display: grid;
    justify-items: start;
    gap: 8px;
    padding: 0;
    margin-bottom: 12px;
  }

  .q {
    font-size: 1.05rem;
    font-weight: 600;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .hint {
    font-size: 0.8rem;
  }

  .options {
    display: grid;
    gap: 8px;
  }

  .option {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    min-height: 52px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface-2);
    cursor: pointer;
    transition: border-color 150ms var(--ease), background-color 150ms var(--ease);
  }

  .option:hover {
    border-color: var(--border-strong);
  }

  .option.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .option input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .option:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .mark {
    display: grid;
    place-items: center;
    flex: none;
    width: 22px;
    height: 22px;
    margin-top: 1px;
    border: 1.5px solid var(--border-strong);
    border-radius: 50%;
    color: transparent;
  }

  .option input[type='checkbox'] ~ .mark {
    border-radius: 7px;
  }

  .option.on .mark {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-ink);
  }

  .option-text {
    display: grid;
    gap: 2px;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .option-text .muted {
    font-size: 0.85rem;
  }
</style>
