import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rx, find} from './source.js';
// 最初の設定の画面（local/bridge.js の setup）：過去のレポートと「自分について」・文体の欄があり、画面のスクリプトが壊れていない
// `const setup = \`…\`;` のテンプレート文字列を取り出して評価する
const setupHtml = () => {
  const src = readFileSync('local/bridge.js', 'utf8');
  const i = src.indexOf('`', find(src, 'const setup=`')),
    j = src.indexOf('`;', i + 1);
  assert.ok(i > 0 && j > i, 'const setup = `…`; がある');
  return eval(src.slice(i, j + 1));
};
test('最初の設定に「過去のレポート（任意）」と「自分について（任意）」を出し、画面のスクリプトが読み込める', () => {
  const html = setupHtml();
  assert.match(html, /4\. 過去のレポート（任意）/);
  assert.match(html, /id="reports" type="file" multiple accept="\.docx,\.pdf,\.txt,\.md"/);
  assert.match(html, /5\. 自分について（任意）/);
  assert.match(html, /id="style"/);
  assert.match(html, /運営者のサーバーには保存しません/);
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(js));
  assert.match(js, /fetch\('\/reports'/);
  assert.match(js, /fetch\('\/profile'/);
});
test('過去のレポートは 1〜3 本・Word/PDF/テキスト・1 本 8 MB までに限り、読み終えたファイルは消す', () => {
  const src = readFileSync('local/bridge.js', 'utf8');
  assert.match(src, rx("files.length>3)throw Error('レポートは 1〜3 本選んでください')"));
  assert.match(src, rx('REPORT_TYPES=/\\.(docx|pdf|txt|md)$/i'));
  assert.match(src, rx('data.length>8e6'));
  assert.match(src, rx('await rm(path,{force:true})'));
  assert.match(src, rx('finally{await rm(dir,{recursive:true,force:true})'));
});
test('最初の設定の「自分について」はアンケート（/profile-form.js）を読み込んで出し、保存するときに答えも送る', () => {
  const html = setupHtml();
  assert.match(html, /<script src="\/profile-form\.js"><\/script>/);
  assert.match(html, /id="pfwrap"/);
  assert.match(html, /profileForm:window\.ProfileForm\?ProfileForm\.readProfileForm\(\$\('pfwrap'\)\)/);
});
