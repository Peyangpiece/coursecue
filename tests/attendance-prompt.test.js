import test from 'node:test';
import assert from 'node:assert/strict';
import {src, rx} from './source.js';
import {PAID_KINDS} from '../server/billing.js';
// manabo で出た出席コードの入力画面を SaBoRo の画面にも出し、入れたコードを PC が manabo に渡す（画面 → クラウドの仕事 prompt → PC）
test('クラウド：prompt の仕事を受け付け、料金の条件は同期と同じ', () => {
  assert.match(src('server/worker.js'), rx('const KINDS=[', /[^\]]*/, "'prompt'"));
  assert(PAID_KINDS.includes('prompt'));
});
test('PC：prompt の仕事で開いたままの入力画面にコードを渡し、入れたらその授業だけ読み直す', () => {
  const bridge = src('local/bridge.js');
  assert.match(
    bridge,
    rx(
      "job.kind==='prompt'){",
      /[\s\S]{0,300}?/,
      'await lms.answerPrompt(name,job.payload?.code);await save();',
      /[\s\S]{0,300}?/, // 入れたコードの共有（/api/attendance-codes）を挟む
      'await lms.sync({course:i});'
    )
  );
  const m = src('local/manabo.js');
  assert.match(m, rx('this.promptTabs.set(name,p);this.notePrompt(name,i,message);'), '入力が出たら状態に残す');
  assert.match(m, rx('this.promptTabs.delete(name);this.clearPrompt(name);'), '閉じたら消す');
  assert.match(m, rx("p.on('dialog',d=>{if(d.type()!=='prompt')return;p.handedOver=true;p.promptDialog=d;"));
});
test('画面：入力待ちがあれば manabo と同じ入力画面（文言そのまま・入力欄・OK）を出し、入れたら prompt の仕事を送る。ホームにも「入力する」を出す', () => {
  const app = src('dist/app.js');
  assert.match(app, rx('function promptCode(name,message){'));
  assert.match(app, /id="dialog-input" inputmode="numeric"/);
  assert.match(app, rx("esc(message||'出席コードを入力してください')"));
  assert.match(
    app,
    rx("const code=await promptCode(p.name,p.message);if(code)await job('prompt',null,{course:p.name,code});")
  );
  assert.match(app, rx('if(first)restoreDrawer();showPrompts();'), '状態を読むたびに新しい入力を出す');
  assert.match(
    app,
    rx("document.querySelectorAll('[data-prompt]').forEach(e=>(e.onclick=()=>showPrompts(e.dataset.prompt)));")
  );
  assert.match(app, rx('html+=promptPanel();html+=noticePanel();html+=attentionPanel();'), 'ホームの上に出す');
});
