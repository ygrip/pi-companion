import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createPairing } from '../src/pair-cli.ts';

test('CLI pairing uses the existing local single-use invitation endpoint', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/pairing/start');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ code: 'ABCD-1234', url: 'https://companion.example/pair?invite=secret', expiresAt: 1900000000, qrSvg: 'unused' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const pairing = await createPairing(`http://127.0.0.1:${address.port}`);
    assert.equal(pairing.code, 'ABCD-1234');
    assert.equal(pairing.expiresAt, 1900000000);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('pairing refuses non-local and non-HTTP admin targets', async () => {
  for (const target of ['https://example.com', 'file:///tmp/pair', 'http://localhost.example.com', 'http://user:password@localhost']) {
    await assert.rejects(createPairing(target), /local Companion admin address/);
  }
});

test('pairing reports daemon errors and does not follow redirects', async () => {
  const server = createServer((request, response) => {
    if (request.headers.host?.startsWith('localhost')) {
      response.writeHead(302, { Location: 'https://example.com/pair' });
    } else { response.writeHead(503); }
    response.end('Unavailable');
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  try {
    const address = server.address() as { port: number };
    await assert.rejects(createPairing(`http://127.0.0.1:${address.port}`), /503/);
    await assert.rejects(createPairing(`http://localhost:${address.port}`), /fetch failed/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
