import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {rx, find, findLast} from './source.js';
// デスクトップアプリの配布物に、local/ が実行時に読む dist/ のファイルがすべて入っていること（抜けると起動時に ENOENT で止まる）
test('デスクトップアプリの配布物に、実行時に読む dist のファイルが入っている', () => {
  const files = JSON.parse(readFileSync('package.json', 'utf8')).build.files;
  const used = new Set();
  for (const name of readdirSync('local').filter(f => f.endsWith('.js'))) {
    const src = readFileSync('local/' + name, 'utf8');
    for (const m of src.matchAll(/new URL\('\.\.\/(dist\/[^']+)'|join\(repo,'(dist\/[^']+)'\)/g))
      used.add(m[1] || m[2]);
  }
  assert(used.has('dist/academic-calendar.json'));
  for (const f of used) assert(files.includes(f), `package.json の build.files に ${f} がありません`);
});
// Windows の新しい版は終了するときに入れ替わる（electron-updater は app の quit で終了コード 0 のときだけ入れ替える）。メニューの「終了」は app.quit() で終えること
test('メニューの「終了」は app.quit() で終え、ダウンロード済みの新しい版を入れ替えられる', () => {
  const src = readFileSync('desktop/main.js', 'utf8');
  assert.match(src, rx("label:'終了',click:()=>app.quit()"));
  assert.match(src, rx("u.on('update-downloaded'"));
  assert.match(src, rx('quitAndInstall(false,true)'));
  assert.match(src, rx('checkExpectedUpdate()'));
  assert.doesNotMatch(src, rx('u.logger=null'));
});
// 処理の途中で終了すると state.json に「処理中」が残る。起動時に消さないと、画面が「同期中…」のまま同期ボタンも押せなくなる
test('サービスの起動時に、前回から残った「処理中」を消してから状態を送る', () => {
  const src = readFileSync('local/bridge.js', 'utf8');
  const reset = find(src, 'if(state.running)state.running=null'),
    firstSave = findLast(src, 'await save().catch(()=>{});setInterval(tick');
  assert(reset > 0, '起動時に state.running を消す');
  assert(reset < firstSave, '最初に状態を送る前に消す');
});
test('Mac のアプリのメニューは saboro の名前で出す（内部の名前 coursecue を出さない）。app.name は変えない（設定の保存場所・キーチェーンの秘密を守る）', () => {
  const src = readFileSync('desktop/main.js', 'utf8'),
    fn = src.slice(src.indexOf('function macAppMenu('), src.indexOf('async function start('));
  for (const l of [
    "role:'about',label:'saboro について'",
    "role:'hide',label:'saboro を隠す'",
    "role:'quit',label:'saboro を終了'",
    "applicationName:'saboro'"
  ])
    assert.match(fn, rx(l), l);
  for (const r of ['cut', 'copy', 'paste', 'selectAll', 'undo'])
    assert.match(fn, rx(`role:'${r}'`), `編集の操作 ${r} を残す`);
  assert.match(src, rx('async function start(){macAppMenu();'));
  assert.doesNotMatch(
    src,
    /app\.setName\(|app\.name\s*=|"productName"\s*:\s*"saboro",\s*"version"/,
    'app.name（設定の保存場所・キーチェーンの名前）は変えない'
  );
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).name, 'coursecue');
});
test('Mac の署名：electron-builder の署名は止め、afterPack で自分の証明書（なければ ad-hoc）で署名する。証明書は Secrets にあるときだけ一時的なキーチェーンに取り込む', () => {
  const b = JSON.parse(readFileSync('package.json', 'utf8')).build,
    wf = readFileSync('.github/workflows/desktop.yml', 'utf8'),
    hook = readFileSync('desktop/after-pack.cjs', 'utf8');
  assert.equal(b.mac.identity, null, 'electron-builder が ad-hoc で上書きしないように');
  assert.equal(b.afterPack, 'desktop/after-pack.cjs');
  assert.ok(b.files.includes('!desktop/after-pack.cjs'), '署名の処理はアプリに入れない');
  assert.match(
    hook,
    rx("identity=process.env.MAC_SIGN_IDENTITY||'-'"),
    '証明書がなければ ad-hoc（Apple シリコンは署名がないと開けない）'
  );
  assert.match(hook, rx("'--verify','--deep','--strict'"), '署名を確かめる');
  assert.match(hook, /Signature=adhoc/, '証明書で署名したはずが ad-hoc なら止める');
  const step = wf.slice(
    wf.indexOf('- name: Prepare the Mac signing certificate'),
    wf.indexOf('- name: Build (macOS + Windows)')
  );
  assert.ok(
    step.length > 0 && wf.indexOf('Prepare the Mac signing certificate') < wf.indexOf('Build (macOS + Windows)'),
    '作る前に用意する'
  );
  for (const k of [
    'secrets.MAC_SIGN_P12',
    'secrets.MAC_SIGN_PASSWORD',
    'if [ -z "$MAC_SIGN_P12" ]; then',
    'security create-keychain',
    'security import',
    'rm -f "$RUNNER_TEMP/sign.p12"',
    'MAC_SIGN_IDENTITY=',
    'MAC_SIGN_KEYCHAIN='
  ])
    assert.ok(step.includes(k), k);
  assert.doesNotMatch(step, /echo "\$MAC_SIGN_(P12|PASSWORD)"/, '秘密をログに出さない');
});
test('manabo 用のブラウザの準備済みの印には Playwright の版を書き、版が変われば取り込み直す（アプリの更新後に同期が止まらないように）', () => {
  const src = readFileSync('desktop/main.js', 'utf8');
  assert.match(src, /node_modules\/playwright-core\/package\.json/);
  assert.match(src, rx("readFileSync(marker,'utf8').trim()===version"));
  assert.match(src, rx('writeFileSync(marker,version||'));
});
// 配布用リポジトリに書き込めるトークンは gh を使うステップだけに渡す（ジョブ全体の env にあると、npm ci の依存パッケージのスクリプトや electron-builder からも読める。流出すると偽の版を配れる）
// 取り込む @napi-rs のパッケージは package-lock.json の integrity と照らす（curl | tar でそのまま展開しない）
test('配布：SABORO_RELEASE_TOKEN は gh のステップだけに渡し、取り込むパッケージは integrity で確かめる', () => {
  const wf = readFileSync('.github/workflows/desktop.yml', 'utf8'),
    build = wf.slice(wf.indexOf('\n  build:'));
  const jobEnv = build.slice(0, build.indexOf('    steps:')).replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(jobEnv, /SABORO_RELEASE_TOKEN|GH_TOKEN/, 'ジョブ全体の env に置かない');
  const steps = build
    .split(/\n      - name: /)
    .slice(1)
    .map(s => ({name: s.slice(0, s.indexOf('\n')), body: s}));
  for (const s of steps) {
    const uses = /\bgh (api|release)\b/.test(s.body),
      has = /GH_TOKEN: \$\{\{ secrets\.SABORO_RELEASE_TOKEN \}\}/.test(s.body);
    assert.equal(has, uses, `${s.name}：gh を使うステップだけにトークンを渡す`);
  }
  const napi = steps.find(s => s.name.startsWith('Add native canvas binaries'));
  assert.ok(napi);
  assert.doesNotMatch(napi.body, /curl[^\n]*\|\s*tar/, '落としたものをそのまま展開しない');
  for (const k of ['].integrity")', 'openssl dgst -sha512 -binary', 'if [ "$got" != "$want" ]', 'exit 1'])
    assert.ok(napi.body.includes(k), k);
});

// アプリの画面（dist）：スクリプトは自分のものだけ（CSP で縛る。第三者のスクリプトは読まない）。デスクトップの画面は saboro 本体と PC 内のサービス以外へ移動しない
test('画面の CSP：スクリプトは自分のものだけ、画像と接続は自分と PC 内のサービスだけ。index.html は外のスクリプトを読まない', () => {
  const h = readFileSync('dist/_headers', 'utf8'),
    csp = h.match(/Content-Security-Policy: (.*)/)?.[1] || '';
  for (const k of [
    "default-src 'self'",
    "script-src 'self'",
    "img-src 'self' data: http://127.0.0.1:8766 http://localhost:8766",
    "connect-src 'self' http://127.0.0.1:8766 http://localhost:8766",
    "frame-ancestors 'none'",
    "base-uri 'self'"
  ])
    assert.ok(csp.includes(k), k);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'インラインのスクリプトは許さない');
  const html = readFileSync('dist/index.html', 'utf8');
  for (const m of html.matchAll(/<script[^>]*src="([^"]+)"/g)) assert.match(m[1], /^\.\//, `外のスクリプト：${m[1]}`);
  assert.doesNotMatch(html, /firebase|gstatic/);
  assert.equal(
    readdirSync('dist').some(f => f.startsWith('firebase')),
    false,
    'Firebase のスクリプトは消す（公開先の転送は firebase.json だけ）'
  );
  for (const f of ['dist/app.js', 'dist/timetable.js', 'dist/admin.js', 'dist/index.html', 'dist/admin.html'])
    assert.doesNotMatch(readFileSync(f, 'utf8'), /\son[a-z]+="/, `${f}：インラインの処理（on〜=）は CSP で動かない`);
});
test('デスクトップの画面：saboro 本体と PC 内のサービス以外への移動・転送は止めて既定のブラウザで開く', () => {
  const src = readFileSync('desktop/main.js', 'utf8');
  assert.match(
    src,
    rx("win.webContents.on('will-navigate',guardNavigation);win.webContents.on('will-redirect',guardNavigation);")
  );
  assert.match(
    src,
    rx(
      'function guardNavigation(e,url){if(ownPage(url))return;e.preventDefault();if(/^https?:\\/\\//.test(url))shell.openExternal(url);}'
    )
  );
  assert.match(
    src,
    rx(
      "const ownPage=url=>url.startsWith(apiBase+'/')||url===apiBase||url.startsWith('http://127.0.0.1:8766/')||url.startsWith('data:')"
    )
  );
});
