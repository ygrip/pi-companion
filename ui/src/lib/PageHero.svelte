<script lang="ts">
  import type { Snippet } from 'svelte';
  import './automation.css';
  let { icon, eyebrow, title, subtitle, children }: { icon: string; eyebrow: string; title: string; subtitle: string; children?: Snippet } = $props();
</script>
<header class="automation-hero">
  <div class="hero-copy"><img class="clay-icon" src={icon} alt="" /><div><span class="eyebrow">{eyebrow}</span><h1>{title}</h1><p class="subtle">{subtitle}</p></div></div>
  {#if children}{@render children()}{/if}
</header>
