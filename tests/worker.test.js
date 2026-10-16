import test from 'node:test';
import assert from 'node:assert/strict';
import {handle, memoryStore} from '../server/worker.js';
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
test('登録した利用者ごとに状態と処理が分かれ、他の利用者のものは見えない', async () => {
  const store = memoryStore();
  const a = await call(store, '/api/register', {method: 'POST', body: {owner: tok('a'), device: tok('b')}});
  assert.equal(a.status, 201);
  const b = await call(store, '/api/register', {method: 'POST', body: {owner: tok('c'), device: tok('d')}});
  assert.equal(b.status, 201);
  assert.equal(
    (await call(store, '/api/state', {method: 'POST', token: tok('b'), body: {tasks: [{id: 'x'}], materials: []}}))
      .status,
    200,
    'Mac の鍵で状態を保存'
  );
  const mine = await (await call(store, '/api/state', {token: tok('a')})).json();
  assert.equal(mine.tasks.length, 1);
  assert.equal(mine.deployed, 'abc');
  const other = await (await call(store, '/api/state', {token: tok('c')})).json();
  assert.deepEqual(other.tasks, [], '別の利用者には見えない');
  assert.equal(
    (await call(store, '/api/state', {method: 'POST', token: tok('a'), body: {}})).status,
    404,
    '接続キーでは状態を書けない'
  );
  const job = await call(store, '/api/jobs', {method: 'POST', token: tok('a'), body: {kind: 'sync'}});
  assert.equal(job.status, 202);
  assert.equal(
    await (await call(store, '/api/agent/claim', {method: 'POST', token: tok('d'), body: {}})).json(),
    null,
    '別の利用者の Mac は取れない'
  );
  const claimed = await (await call(store, '/api/agent/claim', {method: 'POST', token: tok('b'), body: {}})).json();
  assert.equal(claimed.kind, 'sync');
  assert.deepEqual(claimed.payload, {});
  assert.equal(
    (
      await call(store, '/api/agent/finish', {
        method: 'POST',
        token: tok('b'),
        body: {id: claimed.id, status: 'done', result: {ok: true}}
      })
    ).status,
    200
  );
  const list = await (await call(store, '/api/jobs', {token: tok('a')})).json();
  assert.equal(list[0].status, 'done');
  assert.deepEqual(await (await call(store, '/api/jobs', {token: tok('c')})).json(), []);
});
test('登録は 64 桁の16進の鍵だけ受け付け、同じ鍵の二重登録は拒む', async () => {
  const store = memoryStore();
  assert.equal(
    (await call(store, '/api/register', {method: 'POST', body: {owner: 'short', device: tok('b')}})).status,
    400
  );
  assert.equal(
    (await call(store, '/api/register', {method: 'POST', body: {owner: tok('a'), device: tok('a')}})).status,
    400
  );
  assert.equal(
    (await call(store, '/api/register', {method: 'POST', body: {owner: tok('a'), device: tok('b')}})).status,
    201
  );
  assert.equal(
    (await call(store, '/api/register', {method: 'POST', body: {owner: tok('a'), device: tok('e')}})).status,
    409
  );
  assert.equal((await call(store, '/api/state', {token: tok('f')})).status, 401, '未登録の鍵は拒む');
});
test('環境変数の旧トークンは最初の利用者（legacy）として従来どおり使える', async () => {
  const store = memoryStore();
  assert.equal(
    (
      await call(store, '/api/state', {
        method: 'POST',
        token: 'device-legacy',
        body: {tasks: [], materials: [], connection: 'ready'}
      })
    ).status,
    200
  );
  const s = await (await call(store, '/api/state', {token: 'owner-legacy'})).json();
  assert.equal(s.connection, 'ready');
  assert.equal(
    (await call(store, '/api/jobs', {method: 'POST', token: 'owner-legacy', body: {kind: 'generate', task: 't1'}}))
      .status,
    202
  );
  const j = await (await call(store, '/api/agent/claim', {method: 'POST', token: 'device-legacy', body: {}})).json();
  assert.equal(j.task, 't1');
});
test('D1 の表の変更：schema.sql は IF NOT EXISTS で作るだけ。既にある表の変更は migrations/ の番号つきの SQL に置き、公開で適用する', async () => {
  const {readFileSync, readdirSync} = await import('node:fs');
  const schema = readFileSync('server/schema.sql', 'utf8');
  assert.doesNotMatch(schema, /ALTER\s+TABLE/i, '列の追加は migrations/ に');
  for (const m of schema.matchAll(/CREATE\s+(TABLE|INDEX)\s+(?!IF NOT EXISTS)/gi))
    assert.fail('IF NOT EXISTS のない CREATE: ' + m[0]);
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql'))) assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/);
  const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(deploy, /d1 migrations apply coursecue-private --remote/);
  assert.match(readFileSync('wrangler.jsonc', 'utf8'), /"migrations_dir": "migrations"/);
});
// 登録は認証なしで誰でもできるので、1 時間あたりの数に上限を設ける（登録だけで状態の保存先を占められないように）。状態の保存は JSON でなければ 400
test('登録は 1 時間に 20 件まで（それ以上は 429）。状態の保存は JSON でなければ 400', async () => {
  const store = memoryStore();
  const hx = n => n.toString(16).padStart(2, '0').repeat(32);
  for (let i = 0; i < 20; i++)
    assert.equal(
      (await call(store, '/api/register', {method: 'POST', body: {owner: hx(i), device: hx(i + 40)}})).status,
      201,
      `${i + 1} 件目`
    );
  const r = await call(store, '/api/register', {method: 'POST', body: {owner: hx(80), device: hx(81)}});
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), {error: 'too_many'});
  const s = memoryStore();
  await call(s, '/api/register', {method: 'POST', body: {owner: tok('a'), device: tok('b')}});
  const bad = await handle(
    new Request(base + '/api/state', {
      method: 'POST',
      headers: {Authorization: 'Bearer ' + tok('b'), 'Content-Type': 'application/json'},
      body: '{not json'
    }),
    env,
    s
  );
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), {error: 'invalid'});
});
