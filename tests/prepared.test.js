import test from 'node:test';
import assert from 'node:assert/strict';
import {Manabo} from '../local/manabo.js';
// 同期で作った回答は、本人が「課題を生成」を押すまで見せない（t.prepared に控えるだけ）。押したときに資料が変わっていれば作り直す
function setup() {
  const state = {tasks: [], materials: [], settings: {}, courses: [{name: '経営科学Ⅱ', id: '1'}]};
  const calls = [],
    filled = [];
  let files = [{file: '第3回_資料.pdf', text: '第3回の内容'}];
  const m = new Manabo({
    root: '/nonexistent',
    work: '/nonexistent',
    state,
    save: async () => {},
    credentials: async () => null,
    ai: async (t, source, supplement, opts) => {
      calls.push({source: source.map(f => f.file), ...opts});
      const draft = `回答${calls.length}`;
      return {
        grounded: true,
        draft,
        answers: [{name: 'q1', value: draft, evidence: '一般知識'}],
        needsUser: [],
        notes: []
      };
    }
  });
  const page = {
    locator: sel => {
      filled.push(sel);
      return {fill: async () => {}, count: async () => 1, filter: () => page.locator(sel), all: async () => []};
    }
  };
  Object.assign(m, {
    resolveQuiz: async () => {},
    form: async () => ({
      p: page,
      questions: [{name: 'q1', type: 'textarea', text: '考えを述べよ', options: []}],
      text: '課題の説明'
    }),
    materials: async () => files,
    saveDraft: async () => {}
  });
  const t = {
    id: 'a',
    course: 0,
    round: 3,
    title: '第3回レポート',
    type: 'レポート',
    status: 'ready',
    url: 'https://manabo.cnc.chukyo-u.ac.jp/content/1/report/tok/'
  };
  state.tasks.push(t);
  return {m, t, state, calls, filled, addFile: f => (files = [...files, f])};
}
test('同期で作った回答は見せず・manabo にも入力しない。「課題を生成」を押すと控えをそのまま出す', async () => {
  const {m, t, calls, filled} = setup();
  await m.process(t, false);
  assert.equal(calls.length, 1);
  assert.equal(t.status, 'ready');
  assert.equal(t.answer, undefined);
  assert.equal(t.generation, undefined);
  assert.equal(t.prepared.generation.draft, '回答1');
  assert.deepEqual(filled, [], 'manabo には入力しない');
  await m.process(t, false);
  assert.equal(calls.length, 1, '次の同期でも内容が同じなら作り直さない');
  await m.process(t, false, {reveal: true});
  assert.equal(calls.length, 1, '押したときは控えを使う');
  assert.equal(t.answer, '回答1');
  assert.notEqual(t.status, 'ready', '押したら見せる（状態は提出の条件どおり）');
  assert.equal(t.prepared, undefined);
  assert(filled.length > 0, '押したあとはこれまでどおり入力する');
});
test('同期から「課題を生成」までの間にその回の資料が増えていれば、控えを使わず作り直す', async () => {
  const {m, t, calls, addFile} = setup();
  await m.process(t, false);
  addFile({file: '第3回_追加資料.pdf', text: '追加の内容'});
  await m.process(t, false, {reveal: true, urgent: true});
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].source, ['第3回_資料.pdf', '第3回_追加資料.pdf']);
  assert.equal(calls[1].urgent, true);
  assert.equal(t.answer, '回答2');
  assert.equal(t.prepared, undefined);
});
test('SaBoRo の AI の Batch を待つ間も「作成中」は出さない（見せるのは押してから）', async () => {
  const {m, t} = setup();
  const {AiPending} = await import('../local/generate.js');
  m.ai = async () => {
    throw new AiPending('k');
  };
  t.action = '';
  await m.process(t, false);
  assert.equal(t.status, 'ready');
  assert.equal(t.action, '');
  assert.match(t.aiPending, /^[0-9a-f]{64}$/);
});
test('アプリ：本人が押したときは、その授業を読み直して（回答は作らずに）新しい資料を確かめてから作り、控えはクラウドへ送らない', async () => {
  const {src, rx} = await import('./source.js');
  const bridge = src('local/bridge.js'),
    manabo = src('local/manabo.js');
  assert.match(bridge, rx('await lms.sync({course:t.course,generate:false});'));
  assert.match(bridge, rx('tasks:state.tasks.map(({draftPath,submissionIntent,generation,prepared,...t})=>'));
  assert.match(manabo, rx('this.aiAvailable!==false&&generate?queue.filter('));
  assert.match(manabo, rx('if(full||waiting.length)for(const e of this.wantedFiles(entries))'));
});
