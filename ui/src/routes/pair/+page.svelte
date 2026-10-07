<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import jsQR from 'jsqr';
  import logo from '../../assets/pi-companion.webp';
  import Icon from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { errorMessage } from '#lib/toast.svelte.ts';
  import { devicePermissions } from '#lib/device-permissions.svelte.ts';

  const invite = $derived(page.url.searchParams.get('invite'));
  let name = $state(guessName());
  let code = $state('');
  let pairing = $state(false);
  let error = $state('');
  let scannerAvailable = $state(false);
  let scanning = $state(false);
  let cameraPrompt = $state(false);
  let cameraDenied = $state(false);
  let cameraError = $state('');
  let video = $state<HTMLVideoElement>();
  let stream: MediaStream | undefined;
  let frame = 0;
  let lastScan = 0;
  let scanCanvas = $state<HTMLCanvasElement>();

  function guessName() {
    if (typeof navigator === 'undefined') return 'My device';
    const agent = navigator.userAgent;
    if (/iPhone/.test(agent)) return 'iPhone';
    if (/iPad/.test(agent)) return 'iPad';
    if (/Android/.test(agent)) return 'Android phone';
    if (/Mac/.test(agent)) return 'Mac browser';
    if (/Windows/.test(agent)) return 'Windows browser';
    return 'My device';
  }

  onMount(() => {
    scannerAvailable = window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
    devicePermissions.init();
  });


  onDestroy(stopCamera);

  // Already paired: nothing to do here.
  $effect(() => {
    if (companion.booted && companion.paired && !pairing) void goto('/', { replaceState: true });
  });

  function stopCamera() {
    if (frame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame);
    frame = 0;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    scanning = false;
    if (video) video.srcObject = null;
  }

  async function claim(source: { invite: string } | { code: string }) {
    error = '';
    pairing = true;
    stopCamera();
    try {
      await companion.claim(source, name.trim());
      await goto('/', { replaceState: true });
    } catch (e) {
      error = errorMessage(e);
    } finally {
      pairing = false;
    }
  }

  function handleCodeInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const compact = input.value.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
    code = compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    if (invite) void claim({ invite });
    else if (code.replace(/[^a-z0-9]/gi, '').length === 8) void claim({ code });
  }

  function inspectFrame() {
    if (!scanning || !video || !scanCanvas) return;
    frame = requestAnimationFrame(inspectFrame);
    if (performance.now() - lastScan < 120 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    lastScan = performance.now();
    const context = scanCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const scale = Math.min(1, 480 / video.videoWidth);
    scanCanvas.width = Math.round(video.videoWidth * scale);
    scanCanvas.height = Math.round(video.videoHeight * scale);
    context.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
    const pixels = context.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
    const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
    if (!result) return;
    try {
      const url = new URL(result.data, location.href);
      const token = url.searchParams.get('invite');
      if (!token) return;
      stopCamera();
      void claim({ invite: token });
    } catch {
      cameraError = 'That QR code is not a valid Pi Companion pairing link.';
    }
  }

  function startCamera() {
    cameraError = '';
    cameraDenied = false;
    // Skip the explainer once the browser has already granted the camera.
    if (devicePermissions.camera === 'granted') void allowCamera();
    else cameraPrompt = true;
  }

  async function allowCamera() {
    cameraError = '';
    cameraDenied = false;
    if (!scannerAvailable) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
      cameraPrompt = false;
      devicePermissions.markCamera('granted');
      scanning = true;
      await tick();
      if (!video) return stopCamera();
      video.srcObject = stream;
      await video.play();
      frame = requestAnimationFrame(inspectFrame);
    } catch (e) {
      stopCamera();
      const name = e instanceof DOMException ? e.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        cameraDenied = true;
        devicePermissions.markCamera('denied');
        cameraError = 'Camera access was denied. Allow Camera for this site in your browser settings, then try again.';
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        cameraError = 'No usable camera was found on this device.';
      } else {
        cameraError = errorMessage(e) || 'Could not start the camera. Check camera permission and try again.';
      }
    }
  }
</script>

<svelte:head><title>Pair this device · Pi Companion</title></svelte:head>

<div class="wrap">
  <section class="card pair">
    <img src={logo} alt="Pi Companion" width="64" height="64" />

    {#if companion.connection === 'revoked' && !invite}
      <span class="eyebrow">Access removed</span>
      <h1>This device was unpaired</h1>
      <p class="muted">Your computer revoked this device. To use it again, scan a new pairing code from <strong>Devices</strong> on your computer.</p>
    {:else}
      <span class="eyebrow">{invite ? 'Pair this device' : 'Not paired yet'}</span>
      <h1>{invite ? 'Connect to your computer' : 'Connect this device'}</h1>
      <p class="muted">Scan a pairing QR code or enter the unique code shown in Pi Companion on your computer.</p>

      {#if !invite}
        <section class="scanner" aria-label="QR code scanner">
          {#if scannerAvailable}
            {#if scanning}
              <video bind:this={video} playsinline muted aria-label="Camera view for scanning the pairing QR code"></video>
              <button class="btn btn-ghost" type="button" onclick={stopCamera}>Stop camera</button>
            {:else if cameraPrompt}
              <div class="camera-permission" role="group" aria-label="Camera permission">
                <Icon name="devices" size={24} />
                <div>
                  <strong>Allow camera access?</strong>
                  <p class="subtle">Pi Companion uses the camera only to scan the pairing QR code. Your browser will ask for permission next.</p>
                </div>
                <div class="camera-actions">
                  <button class="btn btn-primary" type="button" onclick={allowCamera}>Allow camera</button>
                  <button class="btn btn-ghost" type="button" onclick={() => (cameraPrompt = false)}>Not now</button>
                </div>
              </div>
            {:else}
              <button class="btn" type="button" onclick={startCamera}><Icon name="devices" />Scan QR code with camera</button>
            {/if}
          {:else}
            <p class="subtle">Live scanning requires a secure camera connection. Scan the QR code with your phone’s camera app to open its pairing link (<code>/pair?invite=…</code>), or enter the code below.</p>
          {/if}
          {#if cameraError}
            <p class="error" role="alert">{cameraError}</p>
            {#if cameraDenied}
              <p class="subtle small">On iPhone/iPad Safari: open Website Settings for this site, set Camera to Allow, reload, then scan again.</p>
            {/if}
          {/if}
          <canvas bind:this={scanCanvas} class="scan-canvas" aria-hidden="true"></canvas>
        </section>
        <div class="divider"><span>or enter the code</span></div>
      {/if}

      <form onsubmit={submit}>
        {#if !invite}
          <div class="field">
            <label for="pair-code">Pairing code</label>
            <input id="pair-code" class="input pair-code" value={code} oninput={handleCodeInput} placeholder="XXXX-XXXX" maxlength="9" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required aria-describedby="pair-code-hint" />
            <span id="pair-code-hint" class="subtle small">Enter the one-time code shown on your computer.</span>
          </div>
        {/if}
        <div class="field">
          <label for="device-name">Device name</label>
          <input id="device-name" class="input" bind:value={name} maxlength="80" required autocomplete="off" />
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <button class="btn btn-primary" disabled={pairing || !name.trim() || (!invite && code.replace(/[^a-z0-9]/gi, '').length !== 8)}>{pairing ? 'Connecting…' : 'Connect device'}</button>
      </form>
      <p class="subtle small"><Icon name="check" size={14} />The code works once. Your computer can disconnect or revoke this device at any time.</p>
    {/if}
  </section>
</div>

<style>
  .wrap {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
    background: radial-gradient(circle at 50% 0%, var(--accent-soft), transparent 60%);
  }

  .pair {
    width: min(460px, 100%);
    display: grid;
    gap: 12px;
    padding: 28px;
  }

  .pair img { border-radius: 15px; margin-bottom: 6px; }
  form { display: grid; gap: 14px; margin-top: 6px; }
  .field { display: grid; gap: 6px; }
  .field label { font-weight: 600; }
  .pair-code { font: 700 1.2rem/1 var(--mono); letter-spacing: 0.16em; }
  .scanner { display: grid; justify-items: center; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: var(--clay-radius); background: var(--surface-2); }
  .camera-permission { width: 100%; display: grid; gap: 10px; justify-items: start; }
  .camera-permission p { margin: 2px 0 0; }
  .camera-actions { display: flex; gap: 8px; flex-wrap: wrap; width: 100%; }
  .camera-actions .btn { min-height: 44px; }
  video { width: min(100%, 320px); max-height: 280px; border-radius: 14px; object-fit: cover; }
  .scan-canvas { display: none; }
  .divider { display: flex; align-items: center; gap: 12px; color: var(--text-3); font-size: 0.82rem; }
  .divider::before, .divider::after { content: ''; height: 1px; flex: 1; background: var(--border); }
  .error { color: var(--danger); font-size: 0.85rem; }
  .small { display: flex; gap: 6px; font-size: 0.8rem; }

  @media (max-width: 480px) { .pair { padding: 22px; } }
</style>
