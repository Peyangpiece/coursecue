import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {requestAllowed} from '../local/local-server.js';
// このパソコンの中だけのサービス（127.0.0.1:8766）：Host が違う要求・別のオリジンからの POST・別のサイトのページからの GET（<img> や fetch での CSRF）は断る
const req = (url, {method = 'GET', host = '127.0.0.1:8766', origin, site, dest} = {}) => ({
  method,
  url,
  headers: {
    host,
    ...(origin ? {origin} : {}),
    ...(site ? {'sec-fetch-site': site} : {}),
    ...(dest ? {'sec-fetch-dest': dest} : {})
  }
});
test('Host が 127.0.0.1:8766／localhost:8766 でなければ断る（DNS rebinding）', () => {
  assert.equal(requestAllowed(req('/setup', {host: 'evil.example:8766'})), 403);
  assert.equal(requestAllowed(req('/setup', {host: 'localhost:8766'})), null);
  assert.equal(requestAllowed(req('/setup')), null);
});
test('POST は自分のオリジンからだけ', () => {
  assert.equal(requestAllowed(req('/credentials', {method: 'POST'})), 403, 'Origin なし');
  assert.equal(requestAllowed(req('/credentials', {method: 'POST', origin: 'https://evil.example'})), 403);
  assert.equal(requestAllowed(req('/credentials', {method: 'POST', origin: 'http://127.0.0.1:8766'})), null);
});
test('別のサイトのページからの GET（Sec-Fetch-Site: cross-site）は断る：/browser・/pair・/ai-status・/status など。saboro の画面から使う /open・/owned・/ping は通す', () => {
  for (const p of ['/browser', '/pair', '/ai-status', '/status', '/setup', '/profile-form.js'])
    assert.equal(requestAllowed(req(p, {site: 'cross-site', dest: 'image'})), 403, p);
  for (const p of ['/open?id=' + 'a'.repeat(64), '/owned?h=x', '/ping'])
    assert.equal(requestAllowed(req(p, {site: 'cross-site'})), null, p);
  for (const site of ['none', 'same-origin', 'same-site', undefined])
    assert.equal(
      requestAllowed(req('/pair', {site})),
      null,
      `アプリ（Electron）や自分の画面からの移動（${site}）は通す`
    );
});
test('サービスはすべての要求を requestAllowed で確かめてから処理する', () => {
  const src = readFileSync('local/bridge.js', 'utf8');
  assert.match(
    src,
    /http\.createServer\(async\(req,res\)=>\{try\{const deny=requestAllowed\(req\);if\(deny\)\{res\.writeHead\(deny\)\.end\(\);return\}/
  );
});
