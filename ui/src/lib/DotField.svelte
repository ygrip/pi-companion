<script lang="ts">
  import { onMount } from 'svelte';

  let canvas: HTMLCanvasElement;
  let frame = 0;
  let running = false;

  function draw(time = 0) {
    if (!canvas || !running) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const mobile = rect.width < 720;
    const gap = (mobile ? 22 : 18) * dpr;
    const focalX = width * 0.72;
    const focalY = height * 0.42;
    const maxDistance = Math.hypot(width, height) * 0.62;
    const pulse = 0.88 + Math.sin(time / 2200) * 0.12;

    ctx.fillStyle = 'rgba(215,168,79,.9)';
    for (let y = gap / 2; y < height; y += gap) {
      for (let x = gap / 2; x < width; x += gap) {
        const distance = Math.hypot(x - focalX, y - focalY);
        const focus = Math.max(0, 1 - distance / maxDistance);
        const edge = Math.min(
          1,
          x / (width * 0.18),
          (width - x) / (width * 0.18),
          y / (height * 0.2),
          (height - y) / (height * 0.2)
        );
        const wave = 0.72 + Math.sin((x + y) / (120 * dpr) + time / 1800) * 0.28;
        const alpha = Math.pow(focus, 1.9) * Math.max(0, edge) * wave * pulse * 0.58;
        if (alpha < 0.035) continue;
        ctx.globalAlpha = alpha;
        const radius = (0.7 + focus * 1.35) * dpr;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    frame = requestAnimationFrame(draw);
  }

  onMount(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = () => {
      if (running) return;
      running = true;
      if (reduced) draw(0);
      else frame = requestAnimationFrame(draw);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };
    const onVisibility = () => document.hidden ? stop() : start();

    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(start, { timeout: 900 })
      : window.setTimeout(start, 250);

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if ('cancelIdleCallback' in window) window.cancelIdleCallback(idle as number);
      else clearTimeout(idle as number);
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  });
</script>

<canvas bind:this={canvas} class="dot-field" aria-hidden="true"></canvas>

<style>
  .dot-field {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    opacity: .95;
  }
</style>
