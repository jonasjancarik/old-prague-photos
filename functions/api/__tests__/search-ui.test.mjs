import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../../viewer/static/search-ui.js', import.meta.url), 'utf8');

test('Suggest uses the documented host, constrained locality, and max five safe positions', async () => {
  const window = {};
  let request;
  vm.runInNewContext(source, { window, URL, URLSearchParams, fetch: async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ items: [
      { name: '<img>', location: 'Praha', position: { lat: 50, lon: 14 } },
      { name: 'invalid', position: { lat: 'NaN', lon: 14 } },
    ] }) };
  } });
  const signal = new AbortController().signal;
  const items = await window.OldPragueSearchUI.suggest('Letenská', 'test', signal);
  assert.equal(request.url.origin, 'https://api.mapy.com');
  assert.equal(request.url.pathname, '/v1/suggest');
  assert.equal(request.url.searchParams.get('locality'), 'BOX(14.22,49.94,14.71,50.18)');
  assert.equal(request.url.searchParams.get('limit'), '5');
  assert.equal(request.options.signal, signal);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, '<img>, Praha');
});

test('Missing key and non-200 provider responses are reported without fallback', async () => {
  const window = {};
  let calls = 0;
  vm.runInNewContext(source, { window, URL, URLSearchParams, fetch: async () => { calls++; return { ok: false, status: 429 }; } });
  await assert.rejects(window.OldPragueSearchUI.suggest('Praha', '', null), /not configured/);
  assert.equal(calls, 0);
  await assert.rejects(window.OldPragueSearchUI.suggest('Praha', 'test', null), /429/);
  assert.equal(calls, 1);
});
