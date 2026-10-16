import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {Manabo} from '../local/manabo.js';
import {dropSpareTasks} from '../local/content-resolution.js';
import {deadline} from '../local/core.js';
// manabo の教材一覧の実際の作り：題名・受講期間・提出済みの印は上の行、「受講」ボタンは折りたたみ行（tr.toggle-area）。受講期間を過ぎるとボタンがなくなる
const row = (id, title, period, checked, open) =>
  `<tr><td class="border-right-none vertical-align-top"><div class="plugin-icon-wrapper ${checked ? 'img-checked' : ''}"><img src="/plugins/report/images/icon_transparent.png" class="plugin-icon"><i class="state"></i></div></td><td class="border-left-nonevertical-align-middle"><div><b><a href="#" class="a-content-open" content_id="${id}" plugin_key="report"> ${title} </a></b><div class="div-small"><b>受講期間:</b> ${period}</div></div></td></tr><tr class="toggle-area x-content-hide" style="display: none;"><td colspan="2"><div class="x-content-hide" style="display: none;"><div class="confirm"><div class="text-center">${open ? `<a href="/content/${id}/report/${'a'.repeat(64)}/" class="btn btn-black size-sm"> 受講 </a>` : '<p class="error">受講期限が過ぎました</p>'}</div></div></div></td></tr>`;
const page = `<div id="div-class-contents"><table class="table-class-content"><tbody>${row(1012207, '第二回課題提出', '〜 10月13日(火) 00:00', true, false)}${row(1012208, '第二回課題（期限後提出用、やむを得ない事情のみ）', '10月13日(火) 00:00 〜', false, true)}${row(1012911, '第三回課題提出', '〜 10月20日(火) 00:00', false, true)}${row(1012100, '第一回課題提出', '〜 10月6日(火) 00:00', false, false)}</tbody></table></div>`;
test('「受講」ボタンの課題は上の行から題名・受講期間・提出済みを読み、期限を過ぎた提出済みの課題も記録として拾い、予備の提出先は教材 ID で外せる', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coursecue-entries-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  await ctx.route('**/*', r => r.fulfill({contentType: 'text/html; charset=utf-8', body: page}));
  const p = await ctx.newPage();
  await p.goto('https://manabo.cnc.chukyo-u.ac.jp/class/103576/');
  const m = new Manabo({
    root,
    work: root,
    state: {tasks: [], materials: [], settings: {}},
    save: async () => {},
    credentials: async () => null,
    ai: async () => {}
  });
  const entries = await m.entries(p);
  const by = id => entries.find(e => e.url.includes(`/content/${id}/`));
  assert.equal(entries.length, 3, '期限を過ぎて未提出の課題（ボタンなし）は拾わない');
  assert.equal(by(1012911).title, '第三回課題提出');
  assert.equal(by(1012911).done, false);
  assert.equal(deadline(by(1012911).text), '2026-10-19T15:00:00.000Z');
  assert.equal(by(1012208).title, '第二回課題（期限後提出用、やむを得ない事情のみ）');
  assert.equal(by(1012207).url, 'https://manabo.cnc.chukyo-u.ac.jp/content/1012207/report/');
  assert.equal(by(1012207).done, true);
  assert.equal(by(1012207).title, '第二回課題提出');
  assert.deepEqual([...m.spareIds], ['1012208']);
  const r = dropSpareTasks(
    [
      {title: '受講', url: `https://manabo.cnc.chukyo-u.ac.jp/content/1012208/report/${'a'.repeat(64)}/`},
      {title: '受講', url: `https://manabo.cnc.chukyo-u.ac.jp/content/1012911/report/${'a'.repeat(64)}/`}
    ],
    m.spareIds
  );
  assert.equal(r.archived.length, 1);
  assert(r.tasks[0].url.includes('1012911'));
});
test('開いた状態の行（題名が太字だけ・説明つき）でも、題名と受講期間は上の行から読む', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coursecue-entries-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const body = `<div id="div-class-contents"><table class="table-class-content"><tbody><tr><td><div class="plugin-icon-wrapper img-checked"><img src="/plugins/report/images/icon_transparent.png" class="plugin-icon"></div></td><td class="border-left-nonevertical-align-middle"><div><b> 第1回　コメント提出 </b><div class="div-small"><b>受講期間:</b> 9月25日(金) 00:00 〜 2027年1月31日(日) 23:59</div></div></td></tr><tr class="toggle-area "><td colspan="2"><div><div class="description"><p>動画を視聴して回答してください。</p></div><div class="confirm"><div class="text-center"><a href="/content/1008815/report/${'c'.repeat(64)}/" class="btn btn-black size-sm"> 受講 </a></div></div></div></td></tr></tbody></table></div>`;
  await ctx.route('**/*', r => r.fulfill({contentType: 'text/html; charset=utf-8', body}));
  const p = await ctx.newPage();
  await p.goto('https://manabo.cnc.chukyo-u.ac.jp/class/103736/');
  const m = new Manabo({
    root,
    work: root,
    state: {tasks: [], materials: [], settings: {}},
    save: async () => {},
    credentials: async () => null,
    ai: async () => {}
  });
  const [e] = await m.entries(p);
  assert.equal(e.title, '第1回　コメント提出');
  assert.equal(e.done, true);
  assert.equal(deadline(e.text), '2027-01-31T14:59:00.000Z');
  assert(e.text.includes('動画を視聴して回答してください'), '説明も課題の本文として残す');
});
test('受講期間が過ぎた提出済みの行（教材 ID なし）に当たる既知の課題は、説明文と締切で照らして提出済みにし、題名を直す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coursecue-closed-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const desc =
    '第3回講義受講お疲れ様でした。<br>①講義の質問等お書き下さい（加点）。<br>②講義の感想・要望などお書き下さい。';
  const body = `<div id="div-class-contents"><table class="table-class-content"><tbody><tr><td><div class="plugin-icon-wrapper img-checked"><img src="/plugins/report/images/icon_transparent.png" class="plugin-icon"></div></td><td class="border-left-nonevertical-align-middle"><div><b> 第3回　講義感想・質問など </b><div class="div-small"><b>受講期間:</b> 〜 10月13日(火) 10:30</div></div></td></tr><tr class="toggle-area "><td colspan="2"><div><div class="description">${desc}</div><div class="confirm"><div class="text-center"><p class="error">受講期限が過ぎました</p></div></div></div></td></tr></tbody></table></div>`;
  await ctx.route('**/*', r => r.fulfill({contentType: 'text/html; charset=utf-8', body}));
  const p = await ctx.newPage();
  await p.goto('https://manabo.cnc.chukyo-u.ac.jp/class/103578/');
  const text =
    '第3回講義受講お疲れ様でした。\n①講義の質問等お書き下さい（加点）。\n②講義の感想・要望などお書き下さい。\n受講';
  const mine = {
    id: 'a',
    course: 2,
    round: 4,
    title: '第3回講義受講お疲れ様でした。',
    url: 'https://manabo.cnc.chukyo-u.ac.jp/content/9001/report/x/',
    status: 'wait',
    description: text,
    dueAt: '2026-10-13T01:30:00.000Z'
  };
  const otherWeek = {
    id: 'b',
    course: 2,
    round: 5,
    title: '第4回講義感想',
    url: 'https://manabo.cnc.chukyo-u.ac.jp/content/9002/report/y/',
    status: 'ready',
    description: text,
    dueAt: '2026-10-20T01:30:00.000Z'
  };
  const m = new Manabo({
    root,
    work: root,
    state: {tasks: [mine, otherWeek], materials: [], settings: {}},
    save: async () => {},
    credentials: async () => null,
    ai: async () => {}
  });
  await m.markClosedDone(p, [mine, otherWeek], 3);
  assert.equal(mine.status, 'done');
  assert.equal(mine.title, '第3回　講義感想・質問など', '説明文の 1 行目だった題名を直す');
  assert.equal(otherWeek.status, 'ready', '締切が違う課題は同じ説明文でも提出済みにしない');
});
