import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNotice, noticeDate, noticeEvents, noticeKey} from '../local/notices.js';
import {notifyMac} from '../local/platform.js';
import {adoptMaterialsRoot} from '../local/download-dir.js';
import {sessionsOn} from '../local/schedule.js';
import {handle, memoryStore} from '../server/worker.js';
import {PAID_KINDS} from '../server/billing.js';
import {src, rx} from './source.js';
// お知らせの読み取り：見出しの回と日付、本文の Zoom・パスコード・教室・休講
test('お知らせの見出しから回と日付（学年暦の年、秋学期の 1〜3 月は翌年）を、本文から Zoom・パスコード・教室・休講を読む', () => {
  assert.equal(noticeDate('【第03回，10/09】配布資料', '2026 秋学期'), '2026-10-09');
  assert.equal(noticeDate('【第14回，01/08】第2回確認テスト', '2026 秋学期'), '2027-01-08');
  assert.equal(noticeDate('【第1回 4/10】', '2026 春学期'), '2026-04-10');
  assert.equal(noticeDate('出席免除の申請方法', '2026 秋学期'), '');
  const n = parseNotice(
    {
      title: '【第02回，10/02】配布資料 & 復習用動画',
      text: '配布資料\n・講義で使用します\n復習用動画\nhttps://chukyo-u-ac-jp.zoom.us/rec/share/io2wao5J8pafn_ayE3\nパスコード:fJJDl9F@\n',
      files: [{url: 'u', name: '第2回 配布用（分割なしバージョン）.pdf'}]
    },
    '2026 秋学期'
  );
  assert.deepEqual(
    [n.round, n.date, n.zoom, n.pass, n.room, n.cancelled],
    [2, '2026-10-02', 'https://chukyo-u-ac-jp.zoom.us/rec/share/io2wao5J8pafn_ayE3', 'fJJDl9F@', '', false]
  );
  const link = parseNotice({title: 'Zoom', text: 'リンクは下', links: ['https://chukyo-u-ac-jp.zoom.us/j/123']}, '');
  assert.equal(link.zoom, 'https://chukyo-u-ac-jp.zoom.us/j/123', 'リンク先にだけ Zoom があるときも拾う');
  const c = parseNotice(
    {title: '10/23 は休講です', text: '第5回は休講とします。教室は 0803 です', files: []},
    '2026 秋学期'
  );
  assert.deepEqual([c.round, c.date, c.room, c.cancelled], [0, '2026-10-23', '0803', true]);
  assert.equal(parseNotice({title: '第6回', text: '今回は休講ではなく対面です'}, '').cancelled, false);
  assert.equal(
    parseNotice({title: '', files: [{url: 'u', name: '第7回 資料.pdf'}]}, '').round,
    7,
    '回は付いているファイルの名前からも'
  );
  assert.deepEqual(noticeEvents('A', [c, n]), [
    {course: 'A', date: '2026-10-23', status: '休講', source: 'お知らせ', title: '10/23 は休講です'}
  ]);
  assert.notEqual(noticeKey(n), noticeKey(c));
});
test('授業開始の同期は、お知らせで休講の回を飛ばす', () => {
  const cal = {term: '2026 秋学期', rounds: {金: ['2026-10-09', '2026-10-16']}};
  const state = {
    settings: {},
    courses: [{name: 'A', id: '1'}],
    timetable: {A: {weekday: '金', period: 3}},
    noticeEvents: [{course: 'A', date: '2026-10-09', status: '休講', source: 'お知らせ'}]
  };
  assert.deepEqual(sessionsOn(state, '2026-10-09', cal), []);
  assert.equal(sessionsOn(state, '2026-10-16', cal).length, 1);
});
test('Mac の通知は osascript に題名と本文を引数で渡す（スクリプトに埋め込まない）', async () => {
  let got;
  await notifyMac('saboro', '管理会計Ⅱ：資料 2 件を保存しました "quoted"', (f, a, o, cb) => {
    got = [f, a];
    cb(null);
  });
  assert.equal(got[0], 'osascript');
  assert.deepEqual(got[1].slice(-2), ['saboro', '管理会計Ⅱ：資料 2 件を保存しました "quoted"']);
  assert(!got[1].slice(0, -2).some(a => a.includes('管理会計')), '文言はスクリプトに含めない');
});
test('以前の保存先の引き継ぎ：保存先を選んでいない人の記録からいちばん多い場所を使い、既定と同じ・消えている・ホーム外なら使わない', () => {
  const home = '/Users/u',
    materials = [
      {path: '/Users/u/Documents/saboro/管理会計Ⅱ/a.pdf'},
      {path: '/Users/u/Documents/saboro/経営科学Ⅱ/b.pdf'},
      {path: '/Users/u/Desktop/2026_秋学期/管理会計Ⅱ/c.pdf'},
      {name: 'no path'}
    ];
  const exists = p => p === '/Users/u/Documents/saboro';
  assert.equal(
    adoptMaterialsRoot(materials, {defaultRoot: '/Users/u/Desktop/2026_秋学期', exists, home}),
    '/Users/u/Documents/saboro'
  );
  assert.equal(
    adoptMaterialsRoot(materials, {defaultRoot: '/Users/u/Documents/saboro', exists, home}),
    '',
    '既定と同じなら不要'
  );
  assert.equal(
    adoptMaterialsRoot(materials, {defaultRoot: '/x', exists: () => false, home}),
    '',
    '消えていれば使わない'
  );
  assert.equal(
    adoptMaterialsRoot([{path: '/tmp/x/a/b.pdf'}], {defaultRoot: '/x', exists: () => true, home}),
    '',
    'ホーム外は使わない'
  );
  assert.equal(adoptMaterialsRoot([], {defaultRoot: '/x', exists: () => true, home}), '');
});
const base = 'https://coursecue.hrk-6888.workers.dev',
  tok = c => c.repeat(64);
test('クラウド：公開時のアプリのバージョン（APP_VERSION）を状態と一緒に返し、「確認した」（seen）の仕事を受け付ける（料金の条件なし）', async () => {
  const store = memoryStore(),
    env = {OWNER_TOKEN: 'o', DEVICE_TOKEN: 'd', DEPLOYED_SHA: 'abc', APP_VERSION: '1.0.44'};
  const call = (path, {method = 'GET', token, body} = {}) =>
    handle(
      new Request(base + path, {
        method,
        headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Origin: base},
        body: body === undefined ? undefined : JSON.stringify(body)
      }),
      env,
      store,
      {waitUntil() {}}
    );
  await handle(
    new Request(base + '/api/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({owner: tok('a'), device: tok('b')})
    }),
    env,
    store,
    {waitUntil() {}}
  );
  const st = await (await call('/api/state', {token: tok('a')})).json();
  assert.equal(st.latestVersion, '1.0.44');
  const job = await call('/api/jobs', {method: 'POST', token: tok('a'), body: {kind: 'seen', payload: {all: true}}});
  assert.equal(job.status, 202);
  assert(!PAID_KINDS.includes('seen'));
});
test('公開：deploy は package.json のバージョンを APP_VERSION として Worker に渡す', () => {
  assert.match(
    src('.github/workflows/deploy.yml'),
    /--var APP_VERSION:\$\(node -p "require\('\.\/package\.json'\)\.version"\)/
  );
});
test('PC：確認した新着を見た印にして消す。授業開始の同期で資料を保存したら OS の通知。保存先を選んでいない人は以前の場所を引き継ぐ', () => {
  const b = src('local/bridge.js');
  assert.match(
    b,
    rx("job.kind==='seen'){", /[\s\S]{0,700}?/, 'state.newNotices=(state.newNotices||[]).filter(n=>!hit(n));')
  );
  assert.match(
    b,
    rx(
      "if(r?.materials>0&&platform.notify)await Promise.resolve(platform.notify('saboro',`${s.name}：資料 ${r.materials} 件を保存しました`))"
    )
  );
  assert.match(
    b,
    rx(
      'if(!state.settings?.downloadDir&&!state.rootAdopted){const adopted=adoptMaterialsRoot(state.materials,{defaultRoot:materialsRoot()});'
    )
  );
  assert.match(b, rx('notify:platform.notify||null,'));
  const m = src('local/manabo.js');
  assert.match(m, rx("this.notify?.('saboro',`${name}：出席コードの入力が出ています。SaBoRo の画面で入力できます`)"));
  assert.match(
    m,
    rx(
      'this.state.courseSummary={...this.state.courseSummary,[name]:{at:new Date().toISOString(),materials:this.state.materials.length-before,'
    )
  );
  assert.match(
    m,
    rx('infoIssues?.push(`${name}：シラバス・お知らせを読めませんでした（'),
    'シラバス・お知らせの失敗を要対応に出す'
  );
  assert.match(
    m,
    rx('infoIssues.push(`${name}：資料「${entry.name||entry.url}」を保存できません（'),
    '資料の保存の失敗を要対応に出す'
  );
  assert.match(m, rx('infoIssues.push(`重複した資料の整理に失敗（'));
  const d = src('desktop/main.js');
  assert.match(
    d,
    rx(
      'notify:(title,body)=>{if(!Notification.isSupported())return;new Notification({title:String(title).slice(0,100),body:String(body).slice(0,200)}).show();}'
    )
  );
  assert.match(d, rx("if(process.platform==='win32')app.setAppUserModelId('jp.coursecue.saboro');"));
});
test('画面：同期のまとめ・新着のお知らせ・更新の案内・回ごとの資料・今日の授業の Zoom と資料', () => {
  const app = src('dist/app.js');
  assert.match(
    app,
    rx(
      "function syncSummaryText(sm=state.syncSummary){if(!sm||sm.scope!=='all')return'';return`授業 ${sm.courses} 件・資料 ${sm.materials} 件保存・お知らせ ${sm.notices} 件"
    )
  );
  assert.match(app, rx("function noticePanel(){const list=state.newNotices||[];if(!list.length)return'';"));
  assert.match(
    app,
    rx("document.querySelectorAll('[data-seen]').forEach(e=>(e.onclick=()=>job('seen',null,{all:true})));")
  );
  assert.match(
    app,
    rx("if(state.runtime==='desktop'&&state.version&&newerVersion(state.latestVersion,state.version))")
  );
  assert.match(app, rx('html+=promptPanel();html+=noticePanel();html+=attentionPanel();'));
  assert.match(app, rx('function materialsByRound(mats){'));
  const tt = src('dist/timetable.js');
  assert.match(tt, rx("mode:s.mode||(ev?.status==='休講'||nev?.status==='休講'?'休講':'')||plan?.mode||c.mode||'',"));
  assert.match(tt, rx("room:s.room||(ev?.status==='授業変更'&&ev.room)||notice?.room||c.room||'',"));
  assert.match(
    tt,
    rx(
      'const mats=roundMaterials(s.i,s.round),extra=[info.zoom?`<a href="${esc(info.zoom)}" target="_blank" rel="noopener">Zoom</a>'
    )
  );
  // newerVersion の比較
  const fn = new Function(
    app.slice(app.indexOf('const newerVersion'), app.indexOf('};', app.indexOf('const newerVersion')) + 2) +
      ';return newerVersion;'
  )();
  assert.equal(fn('1.0.44', '1.0.43'), true);
  assert.equal(fn('1.0.43', '1.0.43'), false);
  assert.equal(fn('1.0.9', '1.0.10'), false);
  assert.equal(fn('', '1.0.43'), false);
});
