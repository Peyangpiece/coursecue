import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Manabo} from '../local/manabo.js';
test('テスト用フォーム：クイズは回答入力して本人の提出待ち', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  let sent = 0;
  await ctx.route('**/*', async route => {
    if (route.request().url().includes('/submitted')) {
      sent++;
      return route.fulfill({contentType: 'text/html; charset=utf-8', body: '<main>回答が完了しました</main>'});
    }
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<a id="button-logout">ログアウト</a><form action="/submitted"><fieldset><legend>1+1は？</legend><label><input type="radio" name="q1" value="a">1</label><label><input type="radio" name="q1" value="b">2</label></fieldset><button type="submit">提出</button></form>`
    });
  });
  const root = await mkdtemp(join(tmpdir(), 'coursecue-test-'));
  const task = {
    id: 'fixture',
    course: 0,
    round: 1,
    title: '検証',
    url: 'https://manabo.cnc.chukyo-u.ac.jp/content/fixture/quiz/fixture/',
    type: 'クイズ',
    status: 'ready'
  };
  const state = {tasks: [task], settings: {}};
  const m = new Manabo({
    root,
    work: root,
    state,
    save: async () => {},
    credentials: async () => null,
    ai: async () => ({
      grounded: true,
      draft: '2',
      needsUser: [],
      answers: [{name: 'q1', value: 'b', values: [], evidence: 'fixture.txt 引用:1+1は2です'}]
    })
  });
  m.page = async () => p;
  m.materials = async () => [{file: 'fixture.txt', text: '1+1は2です'}];
  m.saveDraft = async () => {};
  await m.process(task, false);
  assert.equal(sent, 0);
  assert.equal(task.status, 'answered');
  assert(await m.held.get(task.id).locator('input[value=b]').isChecked());
  await browser.close();
  await rm(root, {recursive: true, force: true});
});
test('テスト用フォーム：出席コードは未選択・未提出で待機', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  let sent = 0;
  await ctx.route('**/*', async r => {
    if (r.request().url().includes('/submitted')) sent++;
    await r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<a id="button-logout">ログアウト</a><form action="/submitted"><fieldset><legend>設問</legend><label><input type="radio" name="q1" value="b">2</label></fieldset><fieldset><legend>出席コード</legend><select name="code"><option value="">選択</option><option value="123">123</option></select></fieldset><button>提出</button></form>`
    });
  });
  const task = {
    id: 'fixture',
    course: 0,
    round: 1,
    title: '検証',
    url: 'https://manabo.cnc.chukyo-u.ac.jp/content/fixture/quiz/fixture/',
    type: 'クイズ',
    status: 'ready'
  };
  const m = new Manabo({
    root: '/tmp',
    work: '/tmp',
    state: {tasks: [task], settings: {}},
    save: async () => {},
    credentials: async () => null,
    ai: async () => ({
      grounded: true,
      draft: '2',
      needsUser: ['出席コード'],
      answers: [{name: 'q1', value: 'b', values: [], evidence: 'fixture.txt 引用:答えは2'}]
    })
  });
  m.page = async () => p;
  m.materials = async () => [{file: 'fixture.txt', text: '答えは2'}];
  m.saveDraft = async () => {};
  await m.process(task, false);
  assert.equal(task.status, 'code');
  assert.equal(sent, 0);
  assert(await m.held.get(task.id).locator('input[name=q1]').isChecked());
  assert.equal(await m.held.get(task.id).locator('select').inputValue(), '');
  await browser.close();
});
test('テスト用ログイン：既存セッションがなければ指定フォームでログイン', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const page = await browser.newPage();
  let posted = false;
  await page.route('**/*', async route => {
    const isLogin = route.request().url().includes('/session');
    if (isLogin) {
      posted = true;
      return route.fulfill({contentType: 'text/html; charset=utf-8', body: '<a id="button-logout">ログアウト</a>'});
    }
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<form action="/session" method="POST"><input name="j_username" type="text"><input name="j_password" type="password"><button type="submit">ログイン</button></form>'
    });
  });
  const m = new Manabo({credentials: async () => ({username: 'fixture-user', password: 'fixture-password'})});
  m.page = async () => page;
  assert(await m.login());
  assert(posted);
});
test('掲示板：名前なしの入力欄でも生成し、回答本文を入力し他人の投稿を参照・自動送信しない', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await ctx.route('**/*', r =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<title>第2回事後課題</title><div class="alert">身近な事例は5つ</div><textarea placeholder="発言"></textarea><input name="nickname"><button>送信</button><div>他人の投稿SECRET_PEER</div>'
    })
  );
  const task = {
    course: 4,
    round: 2,
    title: '第2回課題',
    url: 'https://manabo.cnc.chukyo-u.ac.jp/content/1004704/board/token/',
    type: '掲示板',
    status: 'wait'
  };
  let stored = false;
  const m = new Manabo({
    state: {tasks: [task], settings: {}},
    save: async () => {},
    ai: async input => {
      assert.equal(input.questions[0].name, 'board-response');
      assert(!input.description.includes('SECRET_PEER'));
      return {
        grounded: true,
        draft: '検証用の下書き',
        needsUser: [],
        answers: [{name: 'board-response', value: '検証用の下書き', values: [], evidence: ''}]
      };
    }
  });
  m.page = async () => p;
  m.materials = async () => [];
  m.saveDraft = async () => {
    stored = true;
  };
  await m.process(task, false);
  assert(stored);
  assert.equal(task.status, 'draft');
  assert.equal(await m.held.get(task.id).locator('textarea').inputValue(), '検証用の下書き');
});

test('掲示板の完了判定：本人の公開投稿だけを認識し、入力途中や他人の投稿・完了リンクを除外', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const p = await browser.newPage();
  let html = '';
  await p.route('**/*', r => r.fulfill({contentType: 'text/html; charset=utf-8', body: html}));
  const m = new Manabo({});
  const task = {url: 'https://manabo.cnc.chukyo-u.ac.jp/content/1004704/board/token/'};
  for (const [body, expected] of [
    [
      '<a>✓ 受講完了</a><a>自分の発言</a><textarea>あなたの発言 10月10日(土) 19:20</textarea><div>別の人 10月10日(土) 19:20</div>',
      false
    ],
    [
      '<textarea></textarea><div><div>あなたの発言 X <span>10月10日(土) 19:20</span></div><div>本人の回答</div></div>',
      true
    ]
  ]) {
    html = body;
    assert.equal(await m.boardCompleted(task, p), expected);
  }
});
test('引用と資料本文の空白・全角半角の違いは不一致にしない（レポートは下書きまで）', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await ctx.route('**/*', r =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<a id="button-logout">ログアウト</a><form action="/submitted"><fieldset><legend>東芝JSWへの支援を述べよ</legend><textarea name="r1"></textarea></fieldset><button type="submit">提出</button></form>`
    })
  );
  const root = await mkdtemp(join(tmpdir(), 'coursecue-test-'));
  const task = {
    id: 'rep',
    course: 0,
    round: 3,
    title: '東芝JSWへの本国支援',
    url: 'https://manabo.cnc.chukyo-u.ac.jp/content/rep/report/x/',
    type: 'レポート',
    status: 'ready'
  };
  const state = {tasks: [task], settings: {}};
  const m = new Manabo({
    root,
    work: root,
    state,
    save: async () => {},
    credentials: async () => null,
    ai: async () => ({
      grounded: true,
      draft: '技術者派遣と研修で支援した。',
      needsUser: [],
      answers: [
        {
          name: 'r1',
          value: '技術者派遣と研修で支援した。',
          values: [],
          evidence: '第3回.pptx 引用:京浜工場から技術者を送る'
        }
      ]
    })
  });
  m.page = async () => p;
  m.materials = async () => [{file: '第3回.pptx', text: '京浜工場から 技術者を送る \n ＪＳＷ'}];
  m.saveDraft = async () => {};
  await m.process(task, false);
  assert.equal(task.status, 'draft', '空白の違いだけなら引用は一致とみなす');
  assert.equal(task.action, '下書きを確認して提出');
  await rm(root, {recursive: true, force: true});
});
test('出席コード待ち：課題のタブは同期などで閉じずに残り、SaBoRo で入れた出席コードを選んで提出する', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const main = await ctx.newPage();
  const sent = [];
  await ctx.route('**/*', async r => {
    const u = r.request().url();
    if (u.includes('/submitted')) {
      sent.push(u);
      return r.fulfill({contentType: 'text/html; charset=utf-8', body: '<main>回答が完了しました</main>'});
    }
    if (u.includes('/other'))
      return r.fulfill({contentType: 'text/html; charset=utf-8', body: '<main>別のページ</main>'});
    await r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<a id="button-logout">ログアウト</a><form action="/submitted"><fieldset><legend>1+1は？</legend><label><input type="radio" name="q1" value="a">1</label><label><input type="radio" name="q1" value="b">2</label></fieldset><fieldset><legend>感想</legend><textarea name="q2"></textarea></fieldset><fieldset><legend>出席コード</legend><select name="code"><option value="">選択</option><option value="11">482</option><option value="12">517</option></select></fieldset><button type="submit">提出</button></form>`
    });
  });
  const task = {
    id: 'att',
    course: 0,
    round: 1,
    title: '第1回小テスト',
    url: 'https://manabo.cnc.chukyo-u.ac.jp/content/att/quiz/x/',
    type: 'クイズ',
    status: 'ready'
  };
  const calls = [];
  const m = new Manabo({
    root: '/tmp',
    work: '/tmp',
    state: {tasks: [task], settings: {}},
    save: async () => {},
    credentials: async () => null,
    ai: async () => {
      calls.push(1);
      return {
        grounded: true,
        draft: '2',
        needsUser: ['出席コード'],
        notes: [],
        answers: [
          {name: 'q1', value: 'b', values: [], evidence: 'fixture.txt 引用:1+1は2です'},
          {name: 'q2', value: 'よく分かった', values: [], evidence: 'fixture.txt 引用:1+1は2です'}
        ]
      };
    }
  });
  m.page = async () => main;
  m.materials = async () => [{file: 'fixture.txt', text: '1+1は2です'}];
  m.saveDraft = async () => {};
  await m.process(task, false);
  assert.equal(task.status, 'code');
  const held = m.held.get(task.id);
  assert(held && !held.isClosed(), '出席コード待ちのタブは閉じない');
  assert(await held.locator('input[value=b]').isChecked());
  assert.equal(await held.locator('textarea').inputValue(), 'よく分かった');
  assert.equal(await held.locator('select').inputValue(), '', '出席コードは選ばない');
  await main.goto('https://manabo.cnc.chukyo-u.ac.jp/other');
  assert(await held.locator('input[value=b]').isChecked(), 'ほかのページを開いても入力は残る');
  await m.process(task, false);
  assert.equal(m.held.get(task.id), held, 'もう一度押しても入力済みのタブを前に出すだけ');
  assert.equal(calls.length, 1);
  await assert.rejects(m.enterAttendance(task, '999'), /選択肢にありません/);
  assert.equal(sent.length, 0);
  await m.enterAttendance(task, '５１７');
  assert.equal(sent.length, 1, '出席コードを入れて提出');
  assert(sent[0].includes('code=12') && sent[0].includes('q1=b'));
  assert.equal(task.status, 'done');
  assert(held.isClosed(), '提出したらタブを閉じる');
});
test('出席コード待ちのタブが閉じられていたら、生成済みの回答で入力し直してから出席コードを入れる', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const main = await ctx.newPage();
  const sent = [];
  await ctx.route('**/*', async r => {
    const u = r.request().url();
    if (u.includes('/submitted')) {
      sent.push(u);
      return r.fulfill({contentType: 'text/html; charset=utf-8', body: '<main>回答が完了しました</main>'});
    }
    await r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<a id="button-logout">ログアウト</a><form action="/submitted"><fieldset><legend>1+1は？</legend><label><input type="radio" name="q1" value="a">1</label><label><input type="radio" name="q1" value="b">2</label></fieldset><fieldset><legend>出席コード</legend><input type="text" name="code"></fieldset><button type="submit">提出</button></form>`
    });
  });
  const task = {
    id: 'att2',
    course: 0,
    round: 1,
    title: '第2回小テスト',
    url: 'https://manabo.cnc.chukyo-u.ac.jp/content/att2/quiz/x/',
    type: 'クイズ',
    status: 'ready'
  };
  let calls = 0;
  const m = new Manabo({
    root: '/tmp',
    work: '/tmp',
    state: {tasks: [task], settings: {}},
    save: async () => {},
    credentials: async () => null,
    ai: async () => {
      calls++;
      return {
        grounded: true,
        draft: '2',
        needsUser: [],
        notes: [],
        answers: [{name: 'q1', value: 'b', values: [], evidence: 'fixture.txt 引用:1+1は2です'}]
      };
    }
  });
  m.page = async () => main;
  m.materials = async () => [{file: 'fixture.txt', text: '1+1は2です'}];
  m.saveDraft = async () => {};
  await m.process(task, false);
  await m.held.get(task.id).close();
  await m.enterAttendance(task, '7731');
  assert.equal(calls, 1, '生成済みの回答を使う');
  assert.equal(sent.length, 1);
  assert(sent[0].includes('code=7731') && sent[0].includes('q1=b'));
  assert.equal(task.status, 'done');
});
test('待機中のタブで本人が提出を終えていたら、同期の前に提出済みにしてタブを閉じる', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const main = await ctx.newPage();
  await ctx.route('**/*', async r => {
    if (r.request().url().includes('/submitted'))
      return r.fulfill({contentType: 'text/html; charset=utf-8', body: '<main>回答が完了しました</main>'});
    await r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<a id="button-logout">ログアウト</a><form action="/submitted"><fieldset><legend>1+1は？</legend><label><input type="radio" name="q1" value="b">2</label></fieldset><fieldset><legend>出席コード</legend><input type="text" name="code"></fieldset><button type="submit">提出</button></form>`
    });
  });
  const task = {
    id: 'att3',
    course: 0,
    round: 1,
    title: '第3回小テスト',
    url: 'https://manabo.cnc.chukyo-u.ac.jp/content/att3/quiz/x/',
    type: 'クイズ',
    status: 'ready'
  };
  const m = new Manabo({
    root: '/tmp',
    work: '/tmp',
    state: {tasks: [task], settings: {}},
    save: async () => {},
    credentials: async () => null,
    ai: async () => ({
      grounded: true,
      draft: '2',
      needsUser: [],
      notes: [],
      answers: [{name: 'q1', value: 'b', values: [], evidence: 'fixture.txt 引用:1+1は2です'}]
    })
  });
  m.page = async () => main;
  m.materials = async () => [{file: 'fixture.txt', text: '1+1は2です'}];
  m.saveDraft = async () => {};
  await m.process(task, false);
  assert.equal(task.status, 'code');
  const held = m.held.get(task.id);
  await m.collectSubmitted();
  assert.equal(task.status, 'code', '提出前は待機のまま');
  await held.locator('input[name=code]').fill('1234');
  await held.locator('button').click();
  await held.waitForURL('**/submitted**');
  await m.collectSubmitted();
  assert.equal(task.status, 'done');
  assert(held.isClosed());
});
