import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Manabo} from '../local/manabo.js';
// 同期は画面に出さないブラウザ（headless）で動かし、「manabo ブラウザを開く」のときだけ画面に出す
const tab = url => ({
  url: () => url,
  closed: false,
  isClosed() {
    return this.closed;
  },
  close() {
    this.closed = true;
  },
  bringToFront: async () => {},
  goto: async () => {},
  on() {}
});
function setup() {
  const state = {
    tasks: [
      {id: 'q', status: 'answered', url: 'https://manabo.cnc.chukyo-u.ac.jp/content/1/quiz/x/'},
      {id: 'd', status: 'done'}
    ],
    settings: {}
  };
  const m = new Manabo({root: '/tmp', work: '/tmp', state, save: async () => {}, credentials: async () => null});
  const launched = [],
    processed = [];
  m.page = async function () {
    if (!this.ctx) {
      launched.push(this.visible ? 'visible' : 'hidden');
      const pages = [];
      this.ctx = {
        pages: () => pages,
        newPage: async () => {
          const p = tab('about:blank');
          pages.push(p);
          return p;
        },
        close: async () => {}
      };
    }
    return this.p || (this.p = await this.ctx.newPage());
  };
  m.process = async t => {
    processed.push(t.id);
    m.held.set(t.id, tab(t.url));
  };
  return {m, launched, processed};
}
test('ブラウザは最初は画面に出さず、「manabo ブラウザを開く」で画面に出し、操作待ちの課題と出席コードの画面を開き直す', async () => {
  const {m, launched, processed} = setup();
  await m.page();
  assert.deepEqual(launched, ['hidden']);
  m.held.set('q', tab('https://manabo.cnc.chukyo-u.ac.jp/content/1/quiz/x/'));
  m.held.set('d', tab('x'));
  m.promptTabs.set('管理会計Ⅱ', tab('https://manabo.cnc.chukyo-u.ac.jp/class/1/'));
  await m.showBrowser();
  assert.equal(m.visible, true);
  assert.deepEqual(launched, ['hidden', 'visible']);
  assert.deepEqual(processed, ['q'], '提出待ちの課題だけ入れ直す（提出済みは開かない）');
  assert(m.promptTabs.has('管理会計Ⅱ'), '出席コードの画面も開き直す');
});
test('同期の前：画面に出したブラウザに本人の操作待ちが残っていれば画面のまま、なくなっていれば裏で動くブラウザに戻す', async () => {
  const {m, launched} = setup();
  m.visible = true;
  await m.page();
  const q = tab('x');
  m.held.set('q', q);
  await m.hideBrowserIfIdle();
  assert.equal(m.visible, true, '提出待ちが残っていれば閉じない');
  q.closed = true;
  await m.hideBrowserIfIdle();
  assert.equal(m.visible, false);
  assert.deepEqual(launched, ['visible', 'hidden']);
});
test('アプリ：裏で動くブラウザは画面を出さない設定で起動し、処理中は切り替えない', () => {
  const src = readFileSync('local/manabo.js', 'utf8');
  assert.match(
    src,
    /this\.visible\?\{headless:false,viewport:\{width:1100,height:850\}\}:\{headless:true,channel:'chromium'/
  );
  assert.match(src, /async sync\(\{course\}=\{\}\)\{await this\.hideBrowserIfIdle\(\);/);
  const bridge = readFileSync('local/bridge.js', 'utf8');
  assert.match(bridge, /req\.url==='\/browser'\)\{[^]*?if\(running\)\{res\.writeHead\(409/);
});
test('全問に答えて「回答が完了」と出ても、回答欄が残っている（提出前の）クイズのページは提出済みにせず閉じない。提出後の画面なら提出済みにする', async t => {
  const {chromium} = await import('playwright');
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  let body =
    '<p>全ての設問の回答が完了しました。提出ボタンを押してください</p><form><label><input type="radio" name="q1" value="a" checked>A</label><button type="submit">提出</button></form>';
  await ctx.route('**/*', r => r.fulfill({contentType: 'text/html; charset=utf-8', body}));
  const p = await ctx.newPage();
  await p.goto('https://manabo.cnc.chukyo-u.ac.jp/content/1/quiz/x/');
  const task = {id: 'q', status: 'answered', url: 'https://manabo.cnc.chukyo-u.ac.jp/content/1/quiz/x/'};
  const m = new Manabo({
    root: '/tmp',
    work: '/tmp',
    state: {tasks: [task], settings: {}},
    save: async () => {},
    credentials: async () => null
  });
  m.held.set('q', p);
  await m.collectSubmitted();
  assert.equal(task.status, 'answered', '提出前は提出済みにしない');
  assert.equal(p.isClosed(), false, 'ページを閉じない');
  body = '<p>回答が完了しました</p>';
  await p.reload();
  await m.collectSubmitted();
  assert.equal(task.status, 'done');
  assert.equal(p.isClosed(), true);
});
test('残したクイズのページで本人が提出を押したときの確認は止まらずに進む（出席コードの入力は本人に任せる）', async t => {
  const {chromium} = await import('playwright');
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  await ctx.route('**/*', r =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: "<button id=\"b\" onclick=\"document.title=confirm('提出しますか？')?'yes':'no'\">提出</button>"
    })
  );
  const task = {id: 'q', status: 'answered', url: 'https://manabo.cnc.chukyo-u.ac.jp/content/1/quiz/x/'};
  const m = new Manabo({
    root: '/tmp',
    work: '/tmp',
    state: {tasks: [task], settings: {}},
    save: async () => {},
    credentials: async () => null
  });
  const p = await ctx.newPage();
  await p.goto(task.url);
  m.pending.set('q', p);
  await m.settlePage(task);
  assert.equal(m.held.get('q'), p);
  await p.click('#b');
  assert.equal(await p.title(), 'yes');
});
