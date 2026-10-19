import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Manabo} from '../local/manabo.js';
import {handle, memoryStore} from '../server/worker.js';
import {stateEvents} from '../server/push.js';
import {src, rx} from './source.js';
// manabo の 2 段階認証：ログインのあとメールの認証コードを求められたら、SaBoRo の画面に入力を出し（state.mfa）、
// 入れたコードをクラウド経由で PC が受け取り、「30 日間は表示しない」にチェックを入れてから送ってログインを続ける
const LOGIN =
  '<form action="/session" method="POST"><input name="j_username" type="text"><input name="j_password" type="password"><button type="submit">ログイン</button></form>';
const MFA = err =>
  `<p>登録されたメールアドレスに認証コードを送信しました。</p>${err ? '<p class="error">認証コードが正しくありません</p>' : ''}<form action="/verify" method="POST"><label for="otp">認証コード</label><input id="otp" name="otp" type="text" inputmode="numeric"><label><input type="checkbox" name="trust" value="on">30日間はこの確認を表示しない</label><button type="submit">認証</button></form>`;
const DONE = '<a id="button-logout">ログアウト</a>';
async function site(page, {good = '123456'} = {}) {
  const posts = [];
  await page.route('**/*', async route => {
    const url = route.request().url(),
      body = route.request().postData() || '';
    if (url.includes('/session')) return route.fulfill({contentType: 'text/html; charset=utf-8', body: MFA(false)});
    if (url.includes('/verify')) {
      posts.push(Object.fromEntries(new URLSearchParams(body)));
      const ok = new URLSearchParams(body).get('otp') === good;
      return route.fulfill({contentType: 'text/html; charset=utf-8', body: ok ? DONE : MFA(true)});
    }
    return route.fulfill({contentType: 'text/html; charset=utf-8', body: LOGIN});
  });
  return posts;
}
test('認証コードの画面が出たら state.mfa に残して通知し、届いたコードを「30日間は表示しない」にチェックしてから送る。違えば入れ直せる', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const page = await browser.newPage();
  const posts = await site(page);
  const codes = ['000000', '123456'],
    seenMfa = [],
    notified = [];
  const m = new Manabo({
    credentials: async () => ({username: 'u', password: 'p'}),
    state: {},
    save: async () => {},
    notify: (title, body) => notified.push(body),
    mfaCode: async () => {
      seenMfa.push({...m.state.mfa});
      return codes.shift() || null;
    },
    mfaWait: 5000
  });
  m.page = async () => page;
  assert.equal(await m.login(), true);
  assert.equal(posts.length, 2, '間違ったコードのあと正しいコードで送り直す');
  assert.deepEqual(posts[0], {otp: '000000', trust: 'on'}, '30 日間のチェックを入れて送る');
  assert.deepEqual(posts[1], {otp: '123456', trust: 'on'});
  assert.equal(seenMfa[0].attempt, 1);
  assert.match(seenMfa[0].message, /認証コード/);
  assert.equal(seenMfa[1].attempt, 2);
  assert.match(seenMfa[1].message, /違うか期限切れ/);
  assert.equal(m.state.mfa, undefined, 'ログインできたら消す');
  assert.equal(notified.length, 2);
  assert.match(notified[0], /2 段階認証/);
});
test('コードが届かなければ待ち時間のあと state.mfa を消して失敗にする。認証コードの画面が出なければ従来どおり', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await site(page);
  const m = new Manabo({
    credentials: async () => ({username: 'u', password: 'p'}),
    state: {},
    save: async () => {},
    mfaCode: async () => null,
    mfaWait: 1500
  });
  m.page = async () => page;
  await assert.rejects(() => m.login(), /2 段階認証のコードが入力されなかった/);
  assert.equal(m.state.mfa, undefined);
  const page2 = await browser.newPage();
  await page2.route('**/*', route =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: route.request().url().includes('/session') ? DONE : LOGIN
    })
  );
  const m2 = new Manabo({credentials: async () => ({username: 'u', password: 'p'}), state: {}, save: async () => {}});
  m2.page = async () => page2;
  assert.equal(await m2.login(), true);
});
// クラウド：画面が置いたコードを PC が 1 回だけ取り出す
const base = 'https://coursecue.hrk-6888.workers.dev',
  env = {OWNER_TOKEN: 'owner-legacy', DEVICE_TOKEN: 'device-legacy', DEPLOYED_SHA: 'abc'};
const call = (store, path, {method = 'GET', token, body} = {}) =>
  handle(
    new Request(base + path, {
      method,
      headers: {...(token ? {Authorization: 'Bearer ' + token} : {}), 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
    env,
    store
  );
const tok = c => c.repeat(64);
test('クラウド：接続キーで置いたコードを PC の鍵で 1 回だけ取り出す。形式を確かめ、15 分より古いものは渡さない', async () => {
  const store = memoryStore();
  await call(store, '/api/register', {method: 'POST', body: {owner: tok('a'), device: tok('b')}});
  const put = (token, code) => call(store, '/api/mfa', {method: 'POST', token, body: {code}});
  const take = token => call(store, '/api/agent/mfa', {method: 'POST', token});
  assert.deepEqual(await (await take(tok('b'))).json(), {code: null});
  assert.equal((await put(tok('a'), '123456')).status, 200);
  assert.equal((await put(tok('a'), '12')).status, 400, '短すぎる');
  assert.equal((await put(tok('a'), '1234567890123')).status, 400, '長すぎる');
  assert.notEqual((await put(tok('b'), '123456')).status, 200, 'PC の鍵では置けない');
  assert.notEqual((await take(tok('a'))).status, 200, '接続キーでは取り出せない');
  assert.deepEqual(await (await take(tok('b'))).json(), {code: '123456'});
  assert.deepEqual(await (await take(tok('b'))).json(), {code: null}, '1 回取り出すと消える');
  await store.putMfaCode({
    account: (await store.findAccount(await sha(tok('a')))).id,
    code: '999999',
    created: new Date(Date.now() - 16 * 60e3).toISOString()
  });
  assert.deepEqual(await (await take(tok('b'))).json(), {code: null}, '古いコードは渡さない');
  assert.match(
    src('server/schema.sql'),
    /CREATE TABLE IF NOT EXISTS mfa_codes \(account TEXT PRIMARY KEY, code TEXT NOT NULL, created TEXT NOT NULL\)/
  );
});
const sha = async s =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
test('通知と画面：state.mfa が新しくなったら Web Push を送る。画面はホームに案内を出し、同じ形の入力（認証コード）で /api/mfa に送る', () => {
  const ev = stateEvents({}, {mfa: {at: 'x', message: 'メールに届いた認証コードを入力してください'}});
  assert.equal(ev.length, 1);
  assert.equal(ev[0].title, 'manabo の 2 段階認証コードが必要です');
  assert.equal(ev[0].urgency, 'high');
  assert.deepEqual(stateEvents({mfa: {at: 'x'}}, {mfa: {at: 'x'}}), [], '同じものは送らない');
  const app = src('dist/app.js');
  assert.match(
    app,
    rx(
      "const code=await promptCode('manabo の 2 段階認証',m.message||'メールに届いた認証コードを入力してください',{others:false,cancel:'あとで'});"
    )
  );
  assert.match(app, rx("await api('/api/mfa','POST',{code});"));
  assert.match(app, rx('html+=mfaPanel();html+=promptPanel();'));
  assert.match(app, rx('showPrompts();showMfa();'));
  assert.match(app, /autocomplete="\$\{others \? 'off' : 'one-time-code'\}"/);
  assert.match(src('local/bridge.js'), rx("mfaCode:()=>api('/api/agent/mfa','POST',{}).then(r=>r?.code||null),"));
  assert.match(src('local/bridge.js'), /'attcheck', 'mfa'\]/);
});

// 自動ログインが進まないとき：ID・パスワードの誤り（大学のログイン画面に戻る）と、知らない画面で止まったときを分けて知らせる
test('ログインに失敗したら、ID・パスワードの誤りか、どの画面で止まったかを知らせる（学籍番号は除く）', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const failWith = async body => {
    const page = await browser.newPage();
    await page.route('**/*', route =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: route.request().url().includes('/session') ? body : LOGIN
      })
    );
    const m = new Manabo({
      credentials: async () => ({username: 'u', password: 'p'}),
      state: {},
      save: async () => {},
      loginWait: 1000
    });
    m.page = async () => page;
    return m.login().then(
      () => assert.fail('ログインできてしまった'),
      e => e.message
    );
  };
  const wrong = await failWith(`<p class="error">ユーザー名またはパスワードが正しくありません（T123456）</p>${LOGIN}`);
  assert.match(wrong, /ID・パスワードを確かめて/);
  assert.match(wrong, /大学の画面：ユーザー名またはパスワードが正しくありません/);
  assert.doesNotMatch(wrong, /T123456/);
  const stuck = await failWith(
    '<title>認証方法の選択</title><p>認証方法を選んでください</p><button>メールで受け取る</button>'
  );
  assert.match(stuck, /ログインのあとの画面「認証方法の選択」/);
  assert.match(stuck, /manabo ブラウザを開く/);
});
