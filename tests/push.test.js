import test from 'node:test';
import assert from 'node:assert/strict';
import {handle, memoryStore} from '../server/worker.js';
import {
  b64u,
  generateVapid,
  vapidAuth,
  encryptPayload,
  stateEvents,
  deadlineEvents,
  pushDeadlines,
  pushAccount
} from '../server/push.js';
import {src, rx} from './source.js';
// Web Push：クラウドが PC の状態の変化と締切から通知を作り、RFC 8291（aes128gcm）と VAPID で端末に送る
const enc = new TextEncoder(),
  dec = new TextDecoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
// 受け取る側（ブラウザ）の鍵の組と auth を作り、送られた本文を RFC 8291 のとおりに復号する
async function subscriber() {
  const k = await crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)),
    auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: {p256dh: b64u.encode(pub), auth: b64u.encode(auth)},
    async decrypt(body) {
      const salt = body.slice(0, 16),
        rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0),
        idlen = body[20],
        asPub = body.slice(21, 21 + idlen),
        cipher = body.slice(21 + idlen);
      assert.equal(rs, 4096);
      assert.equal(idlen, 65);
      const asKey = await crypto.subtle.importKey('raw', asPub, {name: 'ECDH', namedCurve: 'P-256'}, false, []);
      const shared = await crypto.subtle.deriveBits({name: 'ECDH', public: asKey}, k.privateKey, 256);
      const hkdf = async (ikm, s, info, len) =>
        new Uint8Array(
          await crypto.subtle.deriveBits(
            {name: 'HKDF', hash: 'SHA-256', salt: s, info},
            await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
            len * 8
          )
        );
      const ikm = await hkdf(shared, auth, concat(enc.encode('WebPush: info\0'), pub, asPub), 32);
      const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16),
        nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: nonce}, key, cipher));
      assert.equal(plain.at(-1), 2, '最後のレコードの区切り');
      return dec.decode(plain.slice(0, -1));
    }
  };
}
test('本文の暗号化：購読者の鍵で復号すると元の JSON に戻る（aes128gcm、1 レコード、送り手の公開鍵は毎回違う）', async () => {
  const s = await subscriber();
  const payload = JSON.stringify({title: 'テスト', body: '日本語の本文 🙂'});
  const a = await encryptPayload(enc.encode(payload), s.keys),
    b = await encryptPayload(enc.encode(payload), s.keys);
  assert.equal(await s.decrypt(a), payload);
  assert.equal(await s.decrypt(b), payload);
  assert.notDeepEqual([...a.slice(0, 16)], [...b.slice(0, 16)], 'salt は毎回違う');
  assert.notDeepEqual([...a.slice(21, 86)], [...b.slice(21, 86)], '送り手の鍵は毎回作る');
});
test('VAPID：JWT は ES256 で署名され、aud はプッシュサービスのオリジン、exp は 12 時間後、k は公開鍵', async () => {
  const v = await generateVapid();
  assert.equal(b64u.decode(v.publicKey).length, 65);
  assert.equal(b64u.decode(v.publicKey)[0], 4, '非圧縮の公開鍵');
  const now = Date.parse('2026-10-16T00:00:00Z');
  const header = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc', v, 'https://saboro.example/', now);
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m);
  assert.equal(m[2], v.publicKey);
  const [h, c, sig] = m[1].split('.');
  assert.deepEqual(JSON.parse(dec.decode(b64u.decode(h))), {typ: 'JWT', alg: 'ES256'});
  assert.deepEqual(JSON.parse(dec.decode(b64u.decode(c))), {
    aud: 'https://fcm.googleapis.com',
    exp: now / 1000 + 12 * 3600,
    sub: 'https://saboro.example/'
  });
  const pub = await crypto.subtle.importKey(
    'raw',
    b64u.decode(v.publicKey),
    {name: 'ECDSA', namedCurve: 'P-256'},
    false,
    ['verify']
  );
  assert.equal(
    await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, pub, b64u.decode(sig), enc.encode(`${h}.${c}`)),
    true
  );
});
test('状態の変化から作る通知：出席コードの入力は授業ごとに新しいものだけ、新しいお知らせは 1 件なら題名、複数ならまとめ', () => {
  const at = '2026-10-16T01:00:00Z';
  assert.deepEqual(stateEvents(null, {}), []);
  const one = stateEvents({prompts: {}}, {prompts: {A: {at, message: '出席コードを入力してください'}}});
  assert.equal(one.length, 1);
  assert.equal(one[0].title, 'A：出席コードの入力が出ています');
  assert.equal(one[0].body, '出席コードを入力してください');
  assert.equal(one[0].urgency, 'high');
  assert.deepEqual(stateEvents({prompts: {A: {at}}}, {prompts: {A: {at}}}), [], '同じものは送らない');
  assert.equal(
    stateEvents({prompts: {A: {at}}}, {prompts: {A: {at: '2026-10-16T02:00:00Z'}}}).length,
    1,
    '出直せば送る'
  );
  const n = (key, course, title) => ({key, course, title, date: '2026-10-23', at});
  const notice = stateEvents(
    {newNotices: [n('k1', 'A', '古い')]},
    {newNotices: [n('k1', 'A', '古い'), n('k2', 'B', '【第05回，10/23】配布資料')]}
  );
  assert.deepEqual(notice, [
    {title: '新しいお知らせ：B', body: '【第05回，10/23】配布資料', url: '/#v=home', tag: 'notice'}
  ]);
  const many = stateEvents({}, {newNotices: [n('k1', 'A', 'x'), n('k2', 'B', 'y')]});
  assert.equal(many[0].title, '新しいお知らせ 2 件');
  assert.equal(many[0].body, 'A：x\nB：y');
});
test('締切の通知：24 時間以内に締切の未提出の課題だけ（提出済み・締切なし・過ぎたもの・遠いものは除く）', () => {
  const now = Date.parse('2026-10-16T00:00:00Z'),
    h = n => new Date(now + n * 3600e3).toISOString();
  const state = {
    courses: [{name: '管理会計Ⅱ'}, {name: '経営科学Ⅱ'}],
    tasks: [
      {course: 0, title: '第3回 課題', status: 'ready', dueAt: h(14)},
      {course: 1, title: '小テスト', status: 'done', dueAt: h(14)},
      {course: 1, title: '締切なし', status: 'ready'},
      {course: 1, title: '過ぎた', status: 'ready', dueAt: h(-1)},
      {course: 1, title: '遠い', status: 'ready', dueAt: h(30)}
    ]
  };
  const ev = deadlineEvents(state, now);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].title, '締切が近い課題があります');
  assert.equal(ev[0].body, '管理会計Ⅱ：第3回 課題（10/16 23:00）');
  assert.equal(ev[0].url, '/#v=tasks');
  assert.deepEqual(deadlineEvents({tasks: []}, now), []);
  state.tasks.push({course: 1, title: 'もう 1 つ', status: 'answered', dueAt: h(20)});
  assert.equal(deadlineEvents(state, now)[0].title, '締切が近い課題 2 件');
});
// クラウドの経路。プッシュサービスは fetch を差し替えて受ける
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
async function withPushService(fn, status = 201) {
  const sent = [],
    orig = globalThis.fetch,
    errors = console.error;
  globalThis.fetch = async (url, o) => {
    sent.push({url, headers: o.headers, body: new Uint8Array(o.body)});
    return {status: typeof status === 'function' ? status(url) : status};
  };
  console.error = () => {};
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = orig;
    console.error = errors;
  }
}
async function registered() {
  const store = memoryStore();
  await call(store, '/api/register', {method: 'POST', body: {owner: tok('a'), device: tok('b')}});
  return store;
}
test('購読：接続キーで公開鍵を取り、購読を登録する（形式を確かめる）。PC の鍵では登録できない。解除で消える', async () => {
  const store = await registered(),
    s = await subscriber();
  const k1 = await (await call(store, '/api/push/key', {token: tok('a')})).json();
  assert.equal(b64u.decode(k1.publicKey).length, 65);
  const k2 = await (await call(store, '/api/push/key', {token: tok('a')})).json();
  assert.equal(k2.publicKey, k1.publicKey, '鍵は 1 度だけ作る');
  const sub = {endpoint: 'https://push.example/send/abc', keys: s.keys};
  const post = (path, token, body) => call(store, path, {method: 'POST', token, body});
  assert.equal((await post('/api/push/subscribe', tok('a'), sub)).status, 200);
  assert.equal(
    (await post('/api/push/subscribe', tok('a'), {endpoint: 'http://x', keys: s.keys})).status,
    400,
    'https だけ'
  );
  assert.equal(
    (await post('/api/push/subscribe', tok('a'), {endpoint: sub.endpoint, keys: {p256dh: 'x', auth: s.keys.auth}}))
      .status,
    400
  );
  assert.notEqual((await post('/api/push/subscribe', tok('b'), sub)).status, 200, 'PC の鍵では登録しない');
  assert.deepEqual((await store.listPushSubscriptions((await store.findAccount(await sha('a')))?.id ?? '')).length, 1);
  assert.equal((await post('/api/push/unsubscribe', tok('a'), {endpoint: sub.endpoint})).status, 200);
  assert.deepEqual(await store.listPushAccounts(), []);
});
const sha = async c => {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(tok(c)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
};
test('PC が状態を保存すると、前の状態と比べて出席コードの入力・新しいお知らせを購読した端末に送る（暗号化・VAPID つき）。同じ状態なら送らない。消えた購読は消す', async () => {
  const store = await registered(),
    s = await subscriber();
  const sub = {endpoint: 'https://push.example/send/abc', keys: s.keys};
  await call(store, '/api/push/subscribe', {method: 'POST', token: tok('a'), body: sub});
  const save = state => call(store, '/api/state', {method: 'POST', token: tok('b'), body: state});
  await withPushService(async sent => {
    assert.equal((await save({tasks: [], prompts: {}})).status, 200);
    assert.equal(sent.length, 0, '変化なし');
    await save({tasks: [], prompts: {A: {at: '2026-10-16T01:00:00Z', message: '出席コードを入力してください'}}});
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, sub.endpoint);
    assert.equal(sent[0].headers['Content-Encoding'], 'aes128gcm');
    assert.equal(sent[0].headers.Urgency, 'high');
    assert.match(sent[0].headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const payload = JSON.parse(await s.decrypt(sent[0].body));
    assert.equal(payload.title, 'A：出席コードの入力が出ています');
    assert.equal(payload.url, '/#v=home');
    await save({tasks: [], prompts: {A: {at: '2026-10-16T01:00:00Z', message: '出席コードを入力してください'}}});
    assert.equal(sent.length, 1, '同じ入力はもう送らない');
    await save({tasks: [], newNotices: [{key: 'k1', course: 'B', title: '配布資料', date: '2026-10-23', at: 'x'}]});
    assert.equal(sent.length, 2);
    assert.equal(JSON.parse(await s.decrypt(sent[1].body)).title, '新しいお知らせ：B');
  });
  await withPushService(async sent => {
    const r = await call(store, '/api/push/test', {method: 'POST', token: tok('a')});
    assert.deepEqual(await r.json(), {sent: 0}, 'プッシュサービスが 410 なら送れた数は 0');
    assert.equal(sent.length, 1);
    assert.deepEqual(await store.listPushAccounts(), [], '消えた購読は消す');
  }, 410);
});
test('テスト通知は接続キーで送れ、送れた数を返す', async () => {
  const store = await registered(),
    s = await subscriber();
  await call(store, '/api/push/subscribe', {
    method: 'POST',
    token: tok('a'),
    body: {endpoint: 'https://push.example/1', keys: s.keys}
  });
  await withPushService(async sent => {
    assert.deepEqual(await (await call(store, '/api/push/test', {method: 'POST', token: tok('a')})).json(), {sent: 1});
    assert.equal(JSON.parse(await s.decrypt(sent[0].body)).title, 'saboro のテスト通知');
  });
});
test('定期処理：通知を受け取る端末がある利用者に、締切が近い課題を送る', async () => {
  const store = memoryStore(),
    s = await subscriber(),
    now = Date.parse('2026-10-16T00:00:00Z');
  await store.putPushSubscription({
    endpoint: 'https://push.example/1',
    account: 'u1',
    p256dh: s.keys.p256dh,
    auth: s.keys.auth,
    created: 'x'
  });
  await store.putState(
    'u1',
    JSON.stringify({
      courses: [{name: 'A'}],
      tasks: [{course: 0, title: '課題', status: 'ready', dueAt: new Date(now + 3600e3).toISOString()}]
    })
  );
  await store.putState(
    'u2',
    JSON.stringify({
      courses: [{name: 'A'}],
      tasks: [{course: 0, title: '課題', status: 'ready', dueAt: new Date(now + 3600e3).toISOString()}]
    })
  );
  await withPushService(async sent => {
    assert.equal(await pushDeadlines(store, now), 1, '端末のない u2 には送らない');
    assert.equal(JSON.parse(await s.decrypt(sent[0].body)).body, 'A：課題（10/16 10:00）');
    assert.equal(await pushAccount(store, 'u2', {title: 'x'}), 0);
  });
});
test('画面：設定の「この端末への通知」で Service Worker を登録して購読し、クラウドに登録する。接続を解除すると購読も解除する。Service Worker は通知を出して押すと画面を開く', () => {
  const app = src('dist/app.js');
  assert.match(app, /panel\(\s*'この端末への通知',/);
  assert.match(
    app,
    rx(
      "const reg=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;const{publicKey}=await api('/api/push/key');const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64uBytes(publicKey)});await api('/api/push/subscribe','POST',sub.toJSON());"
    )
  );
  assert.match(
    app,
    rx("await api('/api/push/unsubscribe','POST',{endpoint:sub.endpoint}).catch(()=>{});await sub.unsubscribe();")
  );
  assert.match(
    app,
    rx(
      "bind('pushon',enablePush);bind('pushoff',disablePush);bind('pushtest',testPush);refreshPushState();bind('logout',"
    )
  );
  assert.match(app, rx("return;await disablePush();key='';"), '解除のときに購読も解除');
  assert.match(app, /iPhone では、Safari の共有メニューから「ホーム画面に追加」した saboro を開くと設定できます。/);
  const sw = src('dist/sw.js');
  assert.match(sw, rx("self.addEventListener('push',e=>{"));
  assert.match(sw, rx("self.registration.showNotification(d.title||'saboro',{body:d.body||'',icon:'/icon-512.png'"));
  assert.match(sw, rx("self.addEventListener('notificationclick',e=>{e.notification.close();"));
  assert.doesNotMatch(sw, /caches\.|fetch/, '画面の内容は保存しない');
  assert.match(src('dist/_headers'), /\/sw\.js\n {2}Cache-Control: no-cache/);
  assert.match(src('dist/index.html'), /app\.js\?v=sp-29/);
  const schema = src('server/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS push_keys \(id TEXT PRIMARY KEY, value TEXT NOT NULL\)/);
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS push_subscriptions \(endpoint TEXT PRIMARY KEY, account TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created TEXT NOT NULL\)/
  );
  assert.match(
    src('server/worker.js'),
    rx('ctx.waitUntil(pushDeadlines(store,Date.now(),pushSubject(env)).catch('),
    '毎朝の定期処理で締切を送る'
  );
});
test('ホーム画面に追加：接続キーつきのマニフェスト（/api/manifest?connect=）は start_url に #connect= を入れて返し、画面は接続しているときだけそれに差し替える', async () => {
  const {manifestFor} = await import('../server/worker.js');
  const assets = {
    ASSETS: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            name: 'saboro — 課題管理',
            start_url: '/',
            scope: '/',
            display: 'standalone',
            icons: [{src: '/x.png'}]
          })
        )
    }
  };
  const r = await handle(new Request(base + '/api/manifest?connect=' + tok('a')), assets, memoryStore());
  assert.equal(r.headers.get('Content-Type'), 'application/manifest+json');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const m = await r.json();
  assert.equal(m.start_url, '/?connect=' + tok('a'), '# ではなく ?（起動 URL で # が落ちる環境があるため）');
  assert.equal(m.display, 'standalone');
  assert.equal(m.name, 'saboro — 課題管理', '同梱のマニフェストの中身を引き継ぐ');
  assert.equal(
    (await (await handle(new Request(base + '/api/manifest?connect=zzz'), assets, memoryStore())).json()).start_url,
    '/',
    '鍵の形でなければ入れない'
  );
  assert.equal((await manifestFor({}, base, '')).start_url, '/', '同梱のものを読めなくても返す');
  const app = src('dist/app.js');
  assert.match(
    app,
    rx(
      "if(link?.setAttribute)link.setAttribute('href',key?'/api/manifest?connect='+encodeURIComponent(key):'/manifest.webmanifest');"
    )
  );
  assert.match(
    app,
    rx("localStorage.setItem('coursecue-owner',key);applyManifest();render();"),
    '接続したら差し替える'
  );
  assert.match(app, rx("localStorage.removeItem('coursecue-owner');applyManifest();"), '解除したら戻す');
  assert.match(app, /ホーム画面に追加した saboro を初めて開いた場合だけ「接続する」を押してください/);
  assert.match(src('wrangler.jsonc'), /"invocation_logs": false/, '接続キーつきの URL を要求の記録に残さない');
});
