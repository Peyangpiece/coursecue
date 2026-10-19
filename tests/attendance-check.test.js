import test from 'node:test';
import assert from 'node:assert/strict';
import {handle, memoryStore} from '../server/worker.js';
import {PAID_KINDS} from '../server/billing.js';
import {Manabo} from '../local/manabo.js';
import {src, rx} from './source.js';
// 「出席確認」：授業ページで出席コードの入力が出ているかだけを PC が確かめ（クラウドの仕事 attcheck）、出ていれば画面に入力（同じ授業の他の利用者が入れたコードつき）、出ていなければ「現在、出席は受け付けておりません」
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
async function two() {
  const store = memoryStore();
  await call(store, '/api/register', {method: 'POST', body: {owner: tok('a'), device: tok('b')}});
  await call(store, '/api/register', {method: 'POST', body: {owner: tok('c'), device: tok('d')}});
  return store;
}
test('クラウド：attcheck の仕事を受け付け、料金の条件は同期と同じ', async () => {
  const store = await two();
  assert.equal(
    (
      await call(store, '/api/jobs', {
        method: 'POST',
        token: tok('a'),
        body: {kind: 'attcheck', payload: {course: 'A'}}
      })
    ).status,
    202
  );
  assert(PAID_KINDS.includes('attcheck'));
});
test('クラウド：PC が入れた出席コードを授業ごとに残し、同じ授業の他の利用者にだけ「他ユーザーの入力コード」として返す（自分の分は返さない。1 人 1 件で上書き）', async () => {
  const store = await two();
  const put = (token, body) => call(store, '/api/attendance-codes', {method: 'POST', token, body});
  assert.equal((await put(tok('b'), {course: '103901', code: '1234'})).status, 200, 'PC の鍵で残す');
  assert.equal((await put(tok('b'), {course: '103901', code: ''})).status, 400, 'コードなし');
  assert.equal((await put(tok('b'), {course: '', code: '1'})).status, 400, '授業なし');
  assert.equal((await put(tok('b'), {course: '103901', code: 'x'.repeat(33)})).status, 400, '長すぎる');
  assert.notEqual((await put(tok('a'), {course: '103901', code: '1234'})).status, 200, '接続キーでは残せない');
  const get = (token, course) => call(store, '/api/attendance-codes?course=' + course, {token});
  const other = await (await get(tok('c'), '103901')).json();
  assert.deepEqual(other.codes, [{code: '1234', users: 1}]);
  assert.match(other.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual((await (await get(tok('a'), '103901')).json()).codes, [], '自分の分は出さない');
  assert.deepEqual((await (await get(tok('c'), '103902')).json()).codes, [], '別の授業');
  assert.equal((await get(tok('c'), '')).status, 400);
  await put(tok('b'), {course: '103901', code: '5678'});
  assert.deepEqual(
    (await (await get(tok('c'), '103901')).json()).codes,
    [{code: '5678', users: 1}],
    '入れ直すと上書き'
  );
  assert.notEqual((await get(tok('d'), '103901')).status, 200, 'PC の鍵では読めない');
  assert.match(
    src('server/schema.sql'),
    /CREATE TABLE IF NOT EXISTS attendance_codes \(course TEXT NOT NULL, day TEXT NOT NULL, account TEXT NOT NULL, code TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY\(course, day, account\)\)/
  );
});
// PC：checkAttendance。manabo の代わりに、授業ページを開くと入力（prompt）が出る／出ないページを使う
function fakePage(prompt) {
  const handlers = {};
  return {
    closed: false,
    on(ev, fn) {
      (handlers[ev] ||= []).push(fn);
    },
    async goto() {
      if (!prompt) return;
      for (const fn of handlers.dialog || [])
        fn({type: () => 'prompt', message: () => prompt, accept: async () => {}, dismiss: async () => {}});
      await new Promise(() => {}); // 入力が開いている間、ページの読み込みは終わらない
    },
    waitForLoadState: async () => {},
    bringToFront: async () => {},
    // 入力が開いている間はページが応答しない（promptOpen はこれで「まだ開いている」と判断する）
    async evaluate() {
      if (this.promptDialog) await new Promise(() => {});
      return 1;
    },
    isClosed() {
      return this.closed;
    },
    async close() {
      this.closed = true;
    }
  };
}
function lms(page, courses = [{name: 'A', id: '103901'}]) {
  const m = Object.create(Manabo.prototype);
  Object.assign(m, {
    state: {courses, prompts: {}},
    promptTabs: new Map(),
    notify: null,
    logins: 0,
    login: async () => void m.logins++,
    ctx: {newPage: async () => page}
  });
  return m;
}
test('PC：出席コードの入力が出れば、そのタブを本人に渡して状態に残す（画面に入力が出る）', async () => {
  const page = fakePage('出席コードを入力してください'),
    m = lms(page);
  assert.equal(await m.checkAttendance(0), true);
  assert.equal(m.logins, 1);
  assert.equal(m.promptTabs.get('A'), page, 'タブは閉じずに渡す');
  assert.equal(page.closed, false);
  assert.equal(m.state.prompts.A.message, '出席コードを入力してください');
  assert.equal(m.state.attendanceCheck.A.open, true);
  assert.equal(await m.checkAttendance(0), true, '開いたままなら開き直さない');
  assert.equal(m.logins, 1);
});
test('PC：入力が出なければタブを閉じ、「受け付けていない」を残す。授業 ID が分からなければ確かめない', async () => {
  const page = fakePage(''),
    m = lms(page);
  assert.equal(await m.checkAttendance(0), false);
  assert.equal(page.closed, true);
  assert.deepEqual(m.state.prompts, {});
  assert.equal(m.state.attendanceCheck.A.open, false);
  assert.match(m.state.attendanceCheck.A.at, /^\d{4}-/);
  await assert.rejects(() => lms(fakePage(''), [{name: 'B', id: ''}]).checkAttendance(0), /授業 ID/);
});
test('PC：attcheck の仕事で確かめて結果を返し、prompt の仕事で入れたコードは同じ授業の利用者と共有する', () => {
  const bridge = src('local/bridge.js');
  assert.match(
    bridge,
    rx(
      "job.kind==='attcheck'){",
      /[\s\S]{0,300}?/,
      "const open=await lms.checkAttendance(i);await save();return{ok:true,open,message:open?`${name}：出席コードの入力が出ています`:'現在、出席は受け付けておりません'};"
    )
  );
  assert.match(
    bridge,
    rx(
      'await lms.answerPrompt(name,job.payload?.code);await save();',
      /[\s\S]{0,200}?/,
      "await api('/api/attendance-codes','POST',{course:courseIdOf(i,state)||name,code:String(job.payload?.code??'').trim()}).catch(()=>{});"
    )
  );
  assert.match(bridge, /'aipolicy', 'attcheck', 'mfa'[,\]]/, '画面に出す機能の印');
});
test('画面：授業ページの「出席確認」は attcheck の仕事を送って待ち、入力が出ていれば入力の画面、出ていなければ「現在、出席は受け付けておりません」。入力の画面に「他ユーザーの入力コード」を出す', () => {
  const app = src('dist/app.js');
  assert.match(app, rx('`<button class="btn btn-sm" id="attcheck-${i}" data-attcheck="${i}">出席確認</button>`'));
  assert.match(
    app,
    rx("document.querySelectorAll('[data-attcheck]').forEach(e=>(e.onclick=()=>checkAttendance(+e.dataset.attcheck)));")
  );
  assert.match(app, rx("await api('/api/jobs','POST',{kind:'attcheck',task:null,payload:{course:name}});"));
  assert.match(
    app,
    rx(
      "if(state.prompts?.[name]){toast(`${name}：出席コードの入力が出ています`);showPrompts(name);}else toast(current.status==='done'?'現在、出席は受け付けておりません':briefError("
    )
  );
  assert.match(
    app,
    rx('\'現在、出席は受け付けておりません\'} <span class="muted">（${when(c.at)} 確認）</span>'),
    '授業の情報にも前回の結果'
  );
  assert.match(app, /id="dialog-others"[^>]*>他ユーザーの入力コード：確認中…<\/div>/);
  assert.match(app, rx("const d=await api('/api/attendance-codes?course='+encodeURIComponent(courseIdOf(i)||name));"));
  assert.match(app, rx("'他ユーザーの入力コード：まだありません'"));
  assert.match(
    app,
    rx("const input=document.getElementById('dialog-input');if(others)otherCodes(name);"),
    '入力の画面を出したら読む'
  );
});
