import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// 最初の設定の画面（local/bridge.js の setup）：過去のレポートと「自分について」・文体の欄があり、画面のスクリプトが壊れていない
test('最初の設定に「過去のレポート（任意）」と「自分について（任意）」を出し、画面のスクリプトが読み込める', () => {
  const src = readFileSync('local/bridge.js', 'utf8');
  const i = src.indexOf('const setup=`'),
    j = src.indexOf('`;', i);
  const html = eval(src.slice(i + 'const setup='.length, j + 1));
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
  assert.match(src, /files\.length>3\)throw Error\('レポートは 1〜3 本選んでください'\)/);
  assert.match(src, /REPORT_TYPES=\/\\\.\(docx\|pdf\|txt\|md\)\$\/i/);
  assert.match(src, /data\.length>8e6/);
  assert.match(src, /await rm\(path,\{force:true\}\)/);
  assert.match(src, /finally\{await rm\(dir,\{recursive:true,force:true\}\)/);
});
test('最初の設定の「自分について」はアンケート（/profile-form.js）を読み込んで出し、保存するときに答えも送る', () => {
  const src = readFileSync('local/bridge.js', 'utf8');
  const i = src.indexOf('const setup=`'),
    j = src.indexOf('`;', i);
  const html = eval(src.slice(i + 'const setup='.length, j + 1));
  assert.match(html, /<script src="\/profile-form\.js"><\/script>/);
  assert.match(html, /id="pfwrap"/);
  assert.match(html, /profileForm:window\.ProfileForm\?ProfileForm\.readProfileForm\(\$\('pfwrap'\)\)/);
});
