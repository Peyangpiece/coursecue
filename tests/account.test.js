import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureAccount} from '../local/account.js';
test('鍵がなければ作ってクラウドに登録し、登録できたときだけキーチェーンに保存する', async () => {
  const store = {};
  const vault = (op, name, value) => (op === 'get' ? store[name] || null : ((store[name] = value), ''));
  const calls = [];
  const fetchFn = async (url, o) => {
    calls.push([url, JSON.parse(o.body)]);
    return {ok: true, status: 201, json: async () => ({id: 'acc1'})};
  };
  let n = 0;
  const r = await ensureAccount({vault, apiBase: 'https://x', fetchFn, random: () => (n++ ? 'b' : 'a').repeat(64)});
  assert.deepEqual(r, {status: 'registered', id: 'acc1'});
  assert.equal(calls[0][0], 'https://x/api/register');
  assert.deepEqual(calls[0][1], {owner: 'a'.repeat(64), device: 'b'.repeat(64)});
  assert.equal(store.owner, 'a'.repeat(64));
  assert.equal(store.device, 'b'.repeat(64));
  assert.deepEqual(
    await ensureAccount({vault, apiBase: 'https://x', fetchFn}),
    {status: 'existing'},
    '2 回目は何もしない'
  );
  assert.equal(calls.length, 1);
});
test('登録に失敗したら鍵を保存しない', async () => {
  const store = {};
  const vault = (op, name, value) => (op === 'get' ? store[name] || null : ((store[name] = value), ''));
  await assert.rejects(
    ensureAccount({vault, apiBase: 'https://x', fetchFn: async () => ({ok: false, status: 500})}),
    /500/
  );
  assert.equal(store.owner, undefined);
});
test('使える AI の手段を見つける（環境変数の場所）。本人の API キーは使わない', async () => {
  const {detectProviders} = await import('../local/generate.js');
  const saved = {...process.env};
  try {
    process.env.COURSECUE_CODEX = '/nonexistent/codex';
    process.env.COURSECUE_CLAUDE = '/nonexistent/claude';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    const d = await detectProviders();
    assert.equal(d.codex, null);
    assert.equal('apiKey' in d, false, 'API キーの有無は見ない');
    assert.equal(typeof d.claude === 'string' || d.claude === null, true);
    process.env.COURSECUE_CODEX = process.execPath;
    const e = await detectProviders();
    assert.equal(e.codex, process.execPath);
  } finally {
    process.env = saved;
  }
});
