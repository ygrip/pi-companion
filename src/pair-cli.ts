#!/usr/bin/env node
/** Print an expiring device invitation without opening a browser. */
import { pathToFileURL } from 'node:url';
import { adminHttpUrl } from './daemon.ts';

export async function createPairing(base = adminHttpUrl()) {
  const target = new URL(base);
  if (!['http:', 'https:'].includes(target.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.username || target.password) {
    throw new Error('Pairing requires the local Companion admin address.');
  }
  const response = await fetch(new URL('/api/pairing/start', target), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Pairing failed (${response.status}): ${await response.text()}`);
  const pairing = await response.json() as { code: string; url: string; expiresAt: number };
  if (typeof pairing.code !== 'string' || !pairing.code || typeof pairing.url !== 'string' || !Number.isFinite(pairing.expiresAt)) {
    throw new Error('Companion returned an invalid pairing invitation.');
  }
  return pairing;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const pairing = await createPairing();
    console.log(`Pairing code: ${pairing.code}\nPairing link: ${pairing.url}\nExpires: ${new Date(pairing.expiresAt * 1000).toISOString()}\nSingle use. Treat this invitation as a secret.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Ensure the Companion daemon is running locally (enable /remote-control on in Pi).');
    process.exitCode = 1;
  }
}
