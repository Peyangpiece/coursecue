import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {handle, memoryStore} from '../server/worker.js';
import {billingOf, PAID_KINDS} from '../server/billing.js';
// 支払いを必須にしたとき：定期支払いが有効でない利用者は、同期・回答の作成などの作業だけ止め、設定やログイン情報は止めない。「無料」プランの人は対象外
const base = 'https://coursecue.hrk-6888.workers.dev',
  SECRET = 'whsec_b',
  ADMIN = 'a'.repeat(40),
  env = {OWNER_TOKEN: 'o', DEVICE_TOKEN: 'd', ADMIN_TOKEN: ADMIN, STRIPE_WEBHOOK_SECRET: SECRET};
const req = (path, {method = 'GET', token, body, headers = {}} = {}) =>
  new Request(base + path, {
    method,
    headers: {...(token ? {Authorization: 'Bearer ' + token} : {}), 'Content-Type': 'application/json', ...headers},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
const call = (store, path, o) => handle(req(path, o), env, store),
  admin = (store, path, body) => call(store, '/api/admin' + path, {method: body ? 'POST' : 'GET', token: ADMIN, body});
const hook = (store, event) => {
  const body = JSON.stringify(event),
    t = Math.floor(Date.now() / 1000);
  return call(store, '/api/stripe/webhook', {
    method: 'POST',
    body,
    headers: {'Stripe-Signature': `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`}
  });
};
const tok = c => c.repeat(64),
  OWNER = tok('a'),
  DEVICE = tok('b');
const settings = {
  feeRate: 0.036,
  taxable: false,
  usdJpy: 150,
  paymentLink: 'https://buy.stripe.com/test_sub',
  portalLink: 'https://billing.stripe.com/p/login/test',
  monthlyPrice: 2500
};
async function setup(requirePayment = true) {
  const store = memoryStore();
  const r = await call(store, '/api/register', {method: 'POST', body: {owner: OWNER, device: DEVICE}});
  const {id} = await r.json();
  await admin(store, '/settings', {...settings, requirePayment});
  return {store, id};
}
const billing = async store => (await (await call(store, '/api/state', {token: OWNER})).json()).billing;
const job = (store, kind) => call(store, '/api/jobs', {method: 'POST', token: OWNER, body: {kind}});
const claim = async store => {
  const r = await call(store, '/api/agent/claim', {method: 'POST', token: DEVICE, body: {}});
  return {header: r.headers.get('X-Coursecue-Billing'), job: await r.json()};
};
const subEvent = (type, id, status, created, extra = {}) => ({
  id: 'evt_' + type + created,
  type,
  created,
  data: {
    object: {
      id,
      customer: 'cus_1',
      status,
      cancel_at_period_end: false,
      items: {data: [{current_period_end: created + 30 * 86400}]},
      ...extra
    }
  }
});
test('既定（必須にしていない）では、これまでどおり何でも使える', async () => {
  const {store} = await setup(false);
  const b = await billing(store);
  assert.equal(b.required, false);
  assert.equal(b.allowed, true);
  assert.equal((await job(store, 'sync')).status, 202);
  assert.equal((await claim(store)).header, 'ok');
});
test('必須にすると、未払いの人の同期・回答の作成は止め（402）、設定・ログイン情報の処理は通す。アプリには「支払いが必要」と知らせる', async () => {
  const {store, id} = await setup();
  const b = await billing(store);
  assert.deepEqual(
    {required: b.required, active: b.active, allowed: b.allowed, price: b.price},
    {required: true, active: false, allowed: false, price: 2500}
  );
  assert.equal(
    b.checkoutUrl,
    `https://buy.stripe.com/test_sub?client_reference_id=${id}`,
    '支払いリンクに利用者 ID を付ける'
  );
  for (const kind of PAID_KINDS) assert.equal((await job(store, kind)).status, 402, kind);
  assert.equal((await job(store, 'settings')).status, 202);
  assert.equal((await job(store, 'credentials')).status, 202);
  let c = await claim(store);
  assert.equal(c.header, 'required');
  assert.equal(c.job.kind, 'settings');
  c = await claim(store);
  assert.equal(c.job.kind, 'credentials');
});
test('必須にする前に入っていた同期の依頼も、未払いの間はアプリに渡さない', async () => {
  const {store} = await setup(false);
  await job(store, 'sync');
  await admin(store, '/settings', {...settings, requirePayment: true});
  const c = await claim(store);
  assert.equal(c.job, null);
  assert.equal(c.header, 'required');
});
test('プランが「無料」の人は必須の対象外', async () => {
  const {store, id} = await setup();
  await admin(store, '/user', {account: id, label: '自分', plan: 'free', price: 0, status: 'active'});
  const b = await billing(store);
  assert.equal(b.required, false);
  assert.equal(b.allowed, true);
  assert.equal((await job(store, 'sync')).status, 202);
});
test('支払いリンクで初回の支払いが済むとすぐ使え、解約予定の間も使える。解約が確定したら止まる。古い通知では戻らない', async () => {
  const {store, id} = await setup();
  const T = Math.floor(Date.now() / 1000);
  await hook(store, {
    id: 'evt_cs',
    type: 'checkout.session.completed',
    created: T,
    data: {
      object: {
        id: 'cs_1',
        mode: 'subscription',
        customer: 'cus_1',
        subscription: 'sub_1',
        client_reference_id: id,
        payment_status: 'paid',
        amount_total: 2500,
        currency: 'jpy'
      }
    }
  });
  let b = await billing(store);
  assert.equal(b.active, true);
  assert.equal(b.allowed, true);
  assert.equal((await job(store, 'sync')).status, 202);
  await hook(store, subEvent('customer.subscription.updated', 'sub_1', 'active', T + 10, {cancel_at_period_end: true}));
  b = await billing(store);
  assert.equal(b.allowed, true);
  assert.equal(b.cancelAtPeriodEnd, true);
  assert.ok(b.periodEnd, '次の更新日（期間の終わり）');
  await hook(store, subEvent('customer.subscription.deleted', 'sub_1', 'canceled', T + 20));
  b = await billing(store);
  assert.equal(b.allowed, false);
  assert.equal(b.status, 'canceled');
  await hook(store, subEvent('customer.subscription.updated', 'sub_1', 'active', T + 15));
  assert.equal((await billing(store)).allowed, false, '遅れて届いた古い通知では有効に戻らない');
  await hook(store, subEvent('customer.subscription.created', 'sub_2', 'active', T + 30));
  assert.equal((await billing(store)).allowed, true, '入り直した新しい定期支払いで使える');
});
test('支払いの再試行中（past_due）は使え、未払いが確定（unpaid）したら止まる', () => {
  const s = {requirePayment: true};
  assert.equal(billingOf({account: 'x', settings: s, subs: [{status: 'past_due', event_at: 1}]}).allowed, true);
  assert.equal(billingOf({account: 'x', settings: s, subs: [{status: 'unpaid', event_at: 1}]}).allowed, false);
  assert.equal(
    billingOf({account: 'x', settings: s, subs: [{status: 'incomplete', event_at: 1}]}).allowed,
    false,
    '初回の支払いが終わっていない'
  );
});
test('管理者画面：必須の設定・解約ページ・月額を保存し、利用者ごとの契約の状態を出す', async () => {
  const {store, id} = await setup();
  let r = await (await admin(store, '/overview')).json();
  assert.equal(r.settings.requirePayment, true);
  assert.equal(r.settings.portalLink, 'https://billing.stripe.com/p/login/test');
  assert.equal(r.users[0].billing.allowed, false);
  assert.equal((await admin(store, '/settings', {...settings, monthlyPrice: -1})).status, 400);
  assert.equal((await admin(store, '/settings', {...settings, requirePayment: 'yes'})).status, 400);
});
test('アプリは「支払いが必要」の知らせを覚え、その間は自動の同期をしない', async () => {
  const {src, rx} = await import('./source.js');
  const bridge = src('local/bridge.js');
  assert.match(bridge, rx("r.headers.get('x-coursecue-billing');if(b)state.billingBlocked=b==='required'"));
  assert.match(bridge, rx('state.lastScheduledDay!==day&&!state.billingBlocked)'));
});
