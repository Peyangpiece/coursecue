import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import {requestAllowed} from '../local/local-server.js';
import {src, rx} from './source.js';
// スマホと連携：PC のサービスが接続キー入りの URL を QR コードにして設定画面に出し、スマホで読むと同じ接続キーで saboro（PWA）が開く
const bridge = src('local/bridge.js');
test('/qr.svg は接続キー入りの URL（#connect=）を SVG の QR コードにして返し、キャッシュも参照元も残さない', () => {
  assert.match(
    bridge,
    rx(
      "if(req.url==='/qr.svg'){const svg=await QRCode.toString(apiBase+'/#connect='+encodeURIComponent(owner),{type:'svg',margin:1,width:220});"
    )
  );
  assert.match(
    bridge,
    rx("'Content-Type':'image/svg+xml','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).end(svg);return;}")
  );
  assert.match(bridge, rx("import QRCode from 'qrcode';"));
});
test('/qr.svg は別のサイトのページからは読めない（接続キーが漏れない）', () => {
  const req = (site, dest) => ({
    method: 'GET',
    url: '/qr.svg',
    headers: {
      host: '127.0.0.1:8766',
      ...(site ? {'sec-fetch-site': site} : {}),
      ...(dest ? {'sec-fetch-dest': dest} : {})
    }
  });
  assert.equal(requestAllowed(req('cross-site', 'image')), 403);
  assert.equal(requestAllowed(req('cross-site')), 403);
  assert.equal(requestAllowed(req('same-origin', 'image')), null);
  assert.equal(requestAllowed(req()), null);
});
test('qrcode は接続用の URL を SVG にできる', async () => {
  const url = 'https://coursecue.hrk-6888.workers.dev/#connect=' + 'a'.repeat(64);
  const svg = await QRCode.toString(url, {type: 'svg', margin: 1, width: 220});
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /width="220"/);
  assert.match(svg, /<path /);
  assert.equal(svg.includes(url), false, 'URL は模様にだけ入り、文字では入らない');
});
test('設定画面の「4. スマホと連携」に QR コードとホーム画面に追加する案内を出し、後ろの節の番号もずれていない', () => {
  const i = bridge.search(/<section class="panel" id="phone">/);
  assert.ok(i > 0);
  const sec = bridge.slice(i, bridge.indexOf('</section>', i));
  assert.match(sec, /4\. スマホと連携/);
  assert.match(sec, /<img src="\/qr\.svg" alt="[^"]+" width="220" height="220"/);
  assert.match(sec, /パソコンが起動している必要があります/);
  assert.match(sec, /ホーム画面に追加/);
  assert.match(sec, /他の人に見せないでください/);
  assert.match(bridge, /5\. 過去のレポート（任意）/);
  assert.match(bridge, /6\. 自分について（任意）/);
  assert.match(bridge, /placeholder="5\. で過去のレポートを読み取ると入ります/);
  assert.match(bridge, /6\. の「自分について」に足す/);
  assert.match(bridge, /足しました。6\. の「保存」を押すと使われます/);
  assert.doesNotMatch(
    bridge,
    /4\. 過去のレポート|5\. 自分について|4\. で過去のレポート|5\. の「自分について」|5\. の「保存」|5\. の内容を確かめて/
  );
});
test('アプリのメニューに「スマホと連携（QR コード）」があり、設定画面の QR コードの節を開く', () => {
  assert.match(
    src('desktop/main.js'),
    rx("{label:'スマホと連携（QR コード）',click:()=>openWindow('http://127.0.0.1:8766/setup#phone')}")
  );
});
test('saboro の画面は iPhone の「ホーム画面に追加」でアプリのように開ける（manifest と apple-mobile-web-app の meta）', () => {
  const html = src('dist/index.html');
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="saboro">/);
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png">/);
  const manifest = JSON.parse(src('dist/manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.length >= 1);
});
test('QR コードから開いたときの接続の確認は、自分のパソコンに出した QR コードを読んだ場合も「接続する」でよいと説明する', () => {
  assert.match(
    src('dist/app.js'),
    /自分のパソコンに出した「スマホと連携」の QR コードを読んだ場合だけ「接続する」を押してください/
  );
});
test('資料のボタンはスマホの幅でも名前を折り返し、画面の外にはみ出さない', () => {
  const css = src('dist/saboro.css');
  assert.match(css, /\.material\{display:inline-flex;max-width:100%\}/);
  assert.match(
    css,
    /\.material \.btn:first-child\{min-width:0;white-space:normal;word-break:break-all;text-align:left\}/
  );
});
test('qrcode は依存に入っている', () => {
  assert.match(JSON.parse(src('package.json')).dependencies.qrcode, /^\^1\./);
});
