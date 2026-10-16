import test from 'node:test';
import assert from 'node:assert/strict';
import {checkDownloadDir} from '../local/download-dir.js';
import {launcherFor} from '../local/generate.js';
import {defaultPlatform} from '../local/platform.js';
test('ダウンロード先は OS を問わず絶対パスで受け付け、~ は home に置き換える', () => {
  assert.equal(checkDownloadDir('~/資料', '/Users/u'), '/Users/u/資料');
  assert.throws(() => checkDownloadDir('relative/dir', '/Users/u'), /の形で入力/);
});
test('CLI の起動方法：macOS はそのまま、Windows の .cmd だけ特別扱い', () => {
  const l = launcherFor('/opt/homebrew/bin/claude');
  assert.deepEqual(l, {file: '/opt/homebrew/bin/claude', prefix: [], env: {}});
  if (process.platform === 'win32') {
    const w = launcherFor('C:\\x\\npm\\claude.cmd');
    assert.equal(w.prefix.length > 0, true);
  }
});
test('OS 既定の処理の組：秘密の保存・開く・ゴミ箱・再起動の口がある', () => {
  const p = defaultPlatform();
  assert.equal(typeof p.secrets.get, 'function');
  assert.equal(typeof p.secrets.set, 'function');
  assert.equal(typeof p.openPath, 'function');
  assert.equal(typeof p.trash, 'function');
  assert.equal(p.restart, null);
  assert.equal(p.version, process.env.COURSECUE_VERSION || '');
});
