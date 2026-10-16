import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stateFile} from '../local/state-file.js';
// 状態ファイルは一時ファイルに書いてから置き換え、続けて保存しても最後の内容が完全な形で残る。読めないファイルは残して空から始める
test('続けて保存しても最後の内容が壊れずに残り、一時ファイルは残らない', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coursecue-state-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'state.json'),
    store = stateFile(file);
  const state = {courses: [{name: '資格センター募集講座紹介', removed: true}], n: 0};
  const saves = [];
  for (let i = 1; i <= 20; i++) {
    state.n = i;
    saves.push(store.save(state));
  }
  await Promise.all(saves);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    courses: [{name: '資格センター募集講座紹介', removed: true}],
    n: 20
  });
  assert.deepEqual(await readdir(dir), ['state.json']);
  assert.deepEqual(await store.load(), {courses: [{name: '資格センター募集講座紹介', removed: true}], n: 20});
});
test('途中で切れた状態ファイルは読めないので残しておき、null を返す。ファイルがなければ null', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coursecue-state-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'state.json');
  assert.equal(await stateFile(file).load(), null);
  await writeFile(file, '{"courses":[{"name":"経営');
  assert.equal(await stateFile(file).load(), null);
  assert(
    (await readdir(dir)).some(f => /^state-broken-\d+\.json$/.test(f)),
    '壊れたファイルを残す'
  );
});
