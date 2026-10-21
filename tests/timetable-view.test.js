import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
// 画面側（dist/app.js + dist/timetable.js）を読み込み、授業ごとの既定の授業形式を確かめる
// 画面に固定の授業一覧はない（PC の同期が manabo から集めた state.courses を使う）。テストでは一覧を入れてから描く
const NAMES = [
    '人材マネジメントⅡ',
    'コーポレートファイナンスⅡ',
    '国際ビジネス戦略',
    'サービス・マーケティング',
    '意思決定論',
    '管理会計Ⅱ',
    'マーケティング戦略',
    'ボランティア',
    '経営科学Ⅱ',
    '経済言論Ⅱ',
    '言葉と文化',
    'ゼミナールⅣ'
  ],
  IDS = [
    '103578',
    '103901',
    '103576',
    '103573',
    '103889',
    '103904',
    '103572',
    '103736',
    '103887',
    '103914',
    '104493',
    ''
  ],
  SET = `courses=${JSON.stringify(NAMES)};state.courses=${JSON.stringify(NAMES.map((name, i) => ({name, id: IDS[i]})))};`;
function boot() {
  const nodes = new Map();
  const el = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        textContent: '',
        value: '',
        style: {},
        classList: {
          add() {},
          remove() {},
          contains() {
            return false;
          }
        },
        focus() {}
      });
    return nodes.get(id);
  };
  const context = {
    location: {hostname: 'example.com', port: '', hash: ''},
    localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    document: {
      getElementById: el,
      querySelector: el,
      querySelectorAll: () => [],
      addEventListener() {},
      body: {style: {}},
      activeElement: null
    },
    crypto: webcrypto,
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    window: {},
    URLSearchParams,
    console
  };
  vm.createContext(context);
  for (const f of ['dist/profile-form.js', 'dist/app.js', 'dist/timetable.js'])
    vm.runInContext(readFileSync(f, 'utf8'), context);
  return src => vm.runInContext(src, context);
}
test('授業形式：資料 → CUBICS の教室（対面）→ CUBICS に枠なし（オンデマンド）の順で決まり、自分の設定が最優先', () => {
  const run = boot();
  run(
    `key='k';${SET}state.weekdays={['103578']:'月',['103576']:'火'};state.periods={['103578']:1,['103576']:3};state.courseInfo={'経営科学Ⅱ':{mode:{value:'オンライン',evidence:'x',file:'f'}}};state.cubics={weeks:[[2026,10,12,2026,10,17]],courses:{'経営科学Ⅱ':{weekday:'水',period:2,room:'562'},'意思決定論':{weekday:'木',period:2,room:'541'},'経済言論Ⅱ':{weekday:'金',period:2,room:''}},unmatched:[{label:'ゼミナールⅣ',weekday:'火',period:3,room:'521'}],events:[]};state.timetable={'言葉と文化':{mode:'対面'}}`
  );
  const cfg = JSON.parse(run(`JSON.stringify(Object.fromEntries(courses.map((c,i)=>[c,courseConfig(i)])))`));
  assert.equal(cfg['経営科学Ⅱ'].mode, 'オンライン');
  assert.equal(cfg['経営科学Ⅱ'].modeFrom, '資料');
  assert.equal(cfg['意思決定論'].mode, '対面');
  assert.equal(cfg['意思決定論'].modeFrom, 'CUBICS');
  assert.equal(cfg['人材マネジメントⅡ'].mode, 'オンデマンド', 'CUBICS に枠がない授業');
  assert.equal(cfg['国際ビジネス戦略'].mode, '', '対応づけに失敗した枠と同じ曜日・時限なら推定しない');
  assert.equal(cfg['経済言論Ⅱ'].mode, '', '枠はあるが教室がない場合は推定しない');
  assert.equal(cfg['言葉と文化'].mode, '対面');
  assert.equal(cfg['言葉と文化'].modeFrom, '');
  assert.equal(cfg['言葉と文化'].autoMode, 'オンデマンド');
  run(`state.cubics=null`);
  assert.equal(run(`courseConfig(courses.indexOf('意思決定論')).mode`), '', 'CUBICS を読んでいなければ推定しない');
});
test('回ごとの授業形式：自分の記録 → CUBICS の休講 → 資料・シラバスの回ごとの形式 → 授業の既定', () => {
  const run = boot();
  run(
    `key='k';${SET}state.cubics=null;state.courseInfo={'経営科学Ⅱ':{mode:{value:'対面',evidence:'x',file:'f'},sessions:[{from:2,to:4,mode:'オンデマンド',evidence:'第2回〜第4回（オンデマンド）',file:'シラバス'},{from:4,to:4,mode:'オンライン',evidence:'第4回 Zoom',file:'第1回.pdf'}]}};state.sessions={'経営科学Ⅱ':{3:{mode:'対面'}}}`
  );
  const m = r => run(`sessionInfo(courses.indexOf('経営科学Ⅱ'),${r}).mode`);
  assert.equal(m(1), '対面');
  assert.equal(m(2), 'オンデマンド');
  assert.equal(m(3), '対面', '自分の記録が優先');
  assert.equal(m(4), 'オンライン', '後の記載を優先');
  assert.equal(m('5'), '対面');
});
test('manabo の【動画】表記によるオンデマンドを、AI が読んだ回ごとの形式より優先する', () => {
  const run = boot();
  run(
    `key='k';${SET}state.cubics=null;state.courseInfo={'管理会計Ⅱ':{sessions:[{from:2,to:3,mode:'対面',evidence:'第2回・第3回は対面',file:'お知らせ'}]}};state.plannedModes={'管理会計Ⅱ':[{from:2,to:2,mode:'オンデマンド',evidence:'第2回 春学期の総括【動画】',file:'manabo のディレクトリ'}]}`
  );
  const m = r => run(`sessionInfo(courses.indexOf('管理会計Ⅱ'),${r}).mode`);
  assert.equal(m(2), 'オンデマンド');
  assert.equal(m(3), '対面');
  assert(run(`infoRows(courses.indexOf('管理会計Ⅱ'))`).includes('春学期の総括【動画】'));
});
test('エラーの表示は短く、長いもの（AI の出力の全文など）は最初の文だけにする', () => {
  const run = boot();
  assert.equal(
    run(`briefError('課題生成に失敗しました（Codex：出力の形式が不正／Claude Code：終了コード 1）')`),
    '課題生成に失敗しました（Codex：出力の形式が不正／Claude Code：終了コード 1）'
  );
  assert.equal(
    run(`briefError('課題生成に失敗しました。Codex: {"grounded":true,"draft":"東芝の…"} / Claude Code: 終了コード 1')`),
    '課題生成に失敗しました。'
  );
});
test('同期の問題は「授業日が未設定」と、それ以外（授業情報を読み取れないなど）に分けて数える', () => {
  const run = boot();
  const r = run(
    `issueSummary(['経営科学Ⅱ：授業日未設定（第1〜3回）','経営科学Ⅱ 第4回：授業日未設定（第4回）','管理会計Ⅱ：授業情報を読み取れません（Codex：未インストール）','意思決定論：授業情報を読み取れません（Codex：未インストール）','ゼミナールⅣ：manabo の授業一覧に見つかりません（授業 ID 未設定）'])`
  );
  assert.deepEqual(JSON.parse(JSON.stringify(r)), {
    undated: ['経営科学Ⅱ'],
    other: [
      {reason: '授業情報を読み取れません（Codex：未インストール）', names: ['管理会計Ⅱ', '意思決定論']},
      {reason: 'manabo の授業一覧に見つかりません（授業 ID 未設定）', names: ['ゼミナールⅣ']}
    ]
  });
});
test('manabo の時間切れ・接続のエラーは日本語の短い文にし、末尾の句点を重ねない', () => {
  const run = boot();
  assert.equal(
    run(
      `briefError('page.goto: Timeout 30000ms exceeded.\\nCall log:\\n  - navigating to "https://manabo.cnc.chukyo-u.ac.jp/"')`
    ),
    'manabo の応答がありませんでした（時間切れ）。時間をおいて同期し直してください。'
  );
  assert.equal(
    run(`briefError('page.goto: net::ERR_INTERNET_DISCONNECTED at https://manabo.cnc.chukyo-u.ac.jp/')`),
    'manabo に接続できませんでした。ネットワークを確かめて同期し直してください。'
  );
  assert.equal(run(`briefError('Something failed.\\n'+'x'.repeat(200))`), 'Something failed。');
});
test('要確認は 1 枚にまとめ、AI が使えない原因は 1 行だけにする', () => {
  const run = boot();
  const html = run(
    `key='k';state.aiMissing=true;state.lastError='課題生成に失敗しました（AI を使えません）';state.issues=['経営科学Ⅱ：授業情報を読み取れません（授業情報の読み取りに失敗しました（AI を使えません））','資格センター募集講座紹介：授業日未設定（第1回）','管理会計Ⅱ：同期できませんでした（manabo の応答がありませんでした（時間切れ））'];attentionPanel()`
  );
  assert.equal((html.match(/<li>/g) || []).length, 3, html);
  assert.match(html, /SaBoRo課題サポートを使えないため/);
  assert.doesNotMatch(html, /Codex|Claude/, '手段の名前は出さない');
  assert.match(html, /授業日が未設定：資格センター募集講座紹介/);
  assert.match(html, /管理会計Ⅱ/);
  assert.doesNotMatch(html, /課題生成に失敗/);
  assert.equal(run(`state.aiMissing=false;state.lastError='';state.issues=[];attentionPanel()`), '');
});
test('同期中は進み具合を出し、5 分以上変わらなければその旨を出す', () => {
  const run = boot();
  assert.equal(
    run(
      `state.running='sync';state.progress={phase:'授業',done:3,total:8,current:'管理会計Ⅱ',at:new Date().toISOString()};runningText()`
    ),
    '同期中：授業 3/8（管理会計Ⅱ）'
  );
  assert.match(
    run(`state.progress.at=new Date(Date.now()-7*60000).toISOString();runningText()`),
    /同期中（7分間変化がありません）/
  );
  assert.equal(run(`state.progress=null;runningText()`), '同期中');
});
test('その回で AI の利用が禁止された課題は提出ボタンを出さず、参考である旨と根拠を出す', () => {
  const run = boot();
  const html = forbid =>
    run(
      `key='k';${SET}state.features=['attendance'];state.tasks=[{id:'a',course:0,round:3,title:'第3回課題',type:'レポート',status:'draft',answer:'参考の回答',generation:{draft:'参考の回答'},aiPolicy:{forbidden:${forbid},evidence:'生成AIの使用は禁止',file:'第3回.pdf'},url:'https://manabo.cnc.chukyo-u.ac.jp/content/1/report/tok/'}];detail('a');document.getElementById('drawer').innerHTML`
    );
  const f = html(true);
  assert.doesNotMatch(f, /id="submit"/);
  assert.match(f, /この回は AI の利用が禁止されています/);
  assert.match(f, /生成AIの使用は禁止/);
  assert.match(f, /id="generate"/, '参考の回答は作れる');
  assert.match(html(false), /id="submit"/, '記載のない授業はこれまでどおり提出できる');
});
// どの AI の手段で作ったか・使用量の内訳は利用者の画面に出さない（管理者画面だけ）
test('利用者の画面には AI の手段・使用量の内訳を出さない', () => {
  const run = boot();
  assert.equal(run(`typeof usagePanel`), 'undefined');
  const src = readFileSync('dist/app.js', 'utf8');
  assert.doesNotMatch(src, /generatedBy|Claude API|手段：/);
});
// お支払い：必須で未払いなら支払いの案内（月額・Stripe へのリンク）を出し、支払い後は設定に契約の状態と解約のリンクを出す
test('支払いが必要な間は支払いの案内を出し、支払い後は設定に状態と解約のリンクを出す', () => {
  const run = boot();
  const html = run(
    `key='k';state.billing={required:true,allowed:false,active:false,price:2500,checkoutUrl:'https://buy.stripe.com/x?client_reference_id=abc',portalUrl:''};[billingBlocked(),billingPanel()]`
  );
  assert.equal(html[0], true);
  assert.match(html[1], /月額 2,500円（税込）/);
  assert.match(html[1], /解約するまで毎月自動で決済/);
  assert.match(html[1], /href="https:\/\/buy\.stripe\.com\/x\?client_reference_id=abc"/);
  assert.match(
    run(`state.billing={required:true,allowed:false,status:'canceled',checkoutUrl:''};billingPanel()`),
    /定期支払いが終了している[\s\S]*管理者に連絡/
  );
  const ok = run(
    `state.billing={required:true,allowed:true,active:true,cancelAtPeriodEnd:true,periodEnd:'2026-11-14T00:00:00Z',portalUrl:'https://billing.stripe.com/p/login/t'};[billingBlocked(),billingStatusPanel()]`
  );
  assert.equal(ok[0], false);
  assert.match(ok[1], /解約の手続き済みです。2026年11月14日 まで使えます/);
  assert.match(ok[1], /解約・カードの変更/);
  assert.equal(
    run(`state.billing={required:false,allowed:true,active:false};billingStatusPanel()`),
    '',
    '必須でなく契約もなければ何も出さない'
  );
});
test('プランが「無料」でも定期支払いが有効なら、契約の状態と解約のリンクを出す。契約がなければ「無料で利用中」だけ', () => {
  const run = boot();
  const paid = run(
    `key='k';state.billing={required:false,allowed:true,active:true,exempt:true,status:'active',periodEnd:'2026-11-14T00:00:00Z',portalUrl:'https://billing.stripe.com/p/login/t'};billingStatusPanel()`
  );
  assert.match(paid, /定期支払いは有効です。次回の決済日：2026年11月14日/);
  assert.match(paid, /解約・カードの変更/);
  assert.doesNotMatch(paid, /無料で利用中/);
  const free = run(
    `state.billing={required:false,allowed:true,active:false,exempt:true,portalUrl:'https://billing.stripe.com/p/login/t'};billingStatusPanel()`
  );
  assert.match(free, /無料で利用中です。/);
  assert.doesNotMatch(free, /解約・カードの変更/);
});
test('設定の「SaBoRo の AI」：今月の回数・無料分・超過分の使用料と作り方を出す（準備中は出さない）', () => {
  const run = boot();
  assert.equal(
    run(`key='k';state.ai={available:false,reason:'not_configured',used:0,included:60};saboroAiPanel()`),
    '',
    '準備中は出さない'
  );
  const html = run(`state.ai={available:true,reason:'',used:12,included:60,overage:true,overageYen:0};saboroAiPanel()`);
  assert.match(html, /今月の課題生成：<strong>12回<\/strong>／無料分 60回/);
  assert.match(html, /締切まで24時間以内の回答はすぐ作ります/);
  assert.match(html, /無料分（60回）を超えた後は、使った量に応じて使用料/);
  assert.match(
    run(`state.ai={available:true,reason:'',used:61,included:60,overage:true,overageYen:135};saboroAiPanel()`),
    /61回目からは使用量に応じた使用料：今月 135円/
  );
  assert.match(
    run(`state.ai={available:false,reason:'limit',used:60,included:60,overage:false,overageYen:0};saboroAiPanel()`),
    /今月の無料分（60回）を使い切りました/
  );
});
test('課題の詳細：出力が上限で途切れた課題には「高度な生成を使う（使用回数/上限）」を出し、使い切ったら出さない', () => {
  const run = boot();
  const html = offer => {
    run(
      `key='k';state.tasks=[{id:'t1',title:'レポート',type:'レポート',status:'wait',course:0,action:'出力が上限で途切れました',advancedOffer:${JSON.stringify(offer)}}];detail('t1')`
    );
    return run(`document.getElementById('drawer').innerHTML`);
  };
  assert.match(html({used: 1, limit: 3}), /id="advanced">高度な生成を使う（1\/3）<\/button>/);
  assert.doesNotMatch(html({used: 3, limit: 3}), /id="advanced"/);
});
test('接続用リンク（#connect=）：このパソコンの saboro で確かめられなければ、確認するまで接続先を切り替えない', async () => {
  const nodes = new Map(),
    saved = [];
  const el = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        textContent: '',
        value: '',
        style: {},
        classList: {
          add() {},
          remove() {},
          contains() {
            return false;
          }
        },
        focus() {},
        querySelector() {
          return null;
        },
        querySelectorAll() {
          return [];
        },
        addEventListener() {}
      });
    return nodes.get(id);
  };
  const context = {
    location: {hostname: 'example.com', port: '', hash: '#connect=attacker-key', pathname: '/'},
    history: {replaceState() {}, pushState() {}},
    localStorage: {
      getItem: k => (k === 'coursecue-owner' ? 'my-key' : null),
      setItem: (k, v) => saved.push([k, v]),
      removeItem() {}
    },
    document: {
      getElementById: el,
      querySelector: el,
      querySelectorAll: () => [],
      addEventListener() {},
      body: {style: {}},
      activeElement: null
    },
    crypto: webcrypto,
    setInterval() {},
    setTimeout(f) {},
    clearTimeout() {},
    window: {},
    URLSearchParams,
    TextEncoder,
    console
  };
  vm.createContext(context);
  vm.runInContext(readFileSync('dist/app.js', 'utf8'), context);
  await new Promise(r => setImmediate(r));
  assert.equal(vm.runInContext('key', context), 'my-key', '確かめるまでは元の接続先のまま');
  assert.deepEqual(
    saved.filter(([k]) => k === 'coursecue-owner'),
    []
  );
  assert.match(el('dialog').innerHTML, /別の接続先に切り替えようとしています/);
});
test('ゴミ箱へ移した資料の知らせは「閉じる」で消え、そのあと新しく移したらまた出る', () => {
  const run = boot();
  run(
    `const mem={};localStorage.getItem=k=>mem[k]??null;localStorage.setItem=(k,v)=>{mem[k]=String(v)};key='k';state.issues=[];state.lastError='';state.aiMissing=false;state.trashed=[{name:'第1回_資料 (2).pdf',at:new Date(Date.now()-2*864e5).toISOString()},{name:'第2回_資料 (2).pdf',at:new Date(Date.now()-864e5).toISOString()}]`
  );
  const html = run(`attentionPanel()`);
  assert.match(html, /2 件を/);
  const at = html.match(/data-at="([^"]+)"/)[1];
  assert.equal(at, run(`state.trashed[1].at`), '新しい方の時刻を覚える');
  run(`localStorage.setItem('coursecue-trash-seen',${JSON.stringify(at)})`);
  assert.equal(run(`attentionPanel()`), '', '閉じたあとは出さない');
  run(`state.trashed.push({name:'第3回_資料 (2).pdf',at:new Date().toISOString()})`);
  const again = run(`attentionPanel()`);
  assert.match(again, /1 件を/, '新しく移した分だけ出す');
  assert.match(again, /第3回_資料/);
});
test('前回の同期は、反映し終えた時刻とかかった時間を出す', () => {
  const run = boot();
  assert.equal(
    run(
      `state.lastSync='2026-10-15T07:31:17.485Z';state.syncTiming={total:50000,cubicsSkipped:true,classes:47000,courses:{'経済原論Ⅱ':19000}};lastSyncText()`
    ),
    '前回の同期 10/15(木) 16:31 に反映・50秒（CUBICS 1時間以内に確認済みのため省略・授業 47秒［最長 経済原論Ⅱ 19秒］）'
  );
  assert.equal(
    run(`state.syncTiming=null;lastSyncText()`),
    '前回の同期 10/15(木) 16:31 に反映',
    'かかった時間がなくても時刻は出す'
  );
});
test('授業のページの課題一覧に「この授業を同期」と、この授業を最後に確かめた時刻を出す', () => {
  const run = boot();
  run(
    `key='k';${SET}state.lastSync='2026-10-15T05:08:00.000Z';state.courseSynced={[courses[1]]:'2026-10-15T07:31:00.000Z'}`
  );
  const html = run(`courseSyncTools(1)`);
  assert.match(html, /id="synccourse"/);
  assert.match(html, /10\/15\(木\) 16:31 に確認/, '授業ごとの同期の方が新しければその時刻');
  assert.match(run(`courseSyncTools(0)`), /14:08 に確認/, 'なければ全体の同期の時刻');
  assert.equal(run(`key='';courseSyncTools(0)`), '', '接続前は出さない');
});
test('経験を問う課題は「質問に答えて生成」だけを出し、質問があれば答える欄を出す', () => {
  const run = boot();
  const html = extra =>
    run(
      `key='k';${SET}state.features=['attendance'];state.tasks=[{id:'a',course:0,round:3,title:'第3回課題',description:'あなたのアルバイト経験を踏まえて述べよ',type:'レポート',status:'wait',answer:'',url:'https://manabo.cnc.chukyo-u.ac.jp/content/1/report/tok/'${extra || ''}}];detail('a');document.getElementById('drawer').innerHTML`
    );
  const plain = html();
  assert.match(plain, /id="personalask"/);
  assert.doesNotMatch(plain, /id="personalauto"|AIにすべて任せて/, 'AI に任せる作り方は出さない');
  assert.doesNotMatch(plain, /id="generate"/);
  assert.doesNotMatch(plain, /id="personalsend"/);
  const asked = html(
    `,personalChoice:true,personalQuestions:[{text:'アルバイトの種類は？',choices:['飲食','なし']},{text:'一番大変だったことは？',choices:[]}]`
  );
  assert.match(asked, /質問に答える（2問）/);
  assert.match(asked, /name="pq0" value="飲食"/);
  assert.match(asked, /id="pqx1"/);
  assert.match(asked, /id="pqsave"/);
  assert.match(asked, /id="personalsend"/);
  assert.match(html(`,personalMode:'plain'`), /id="generate"/, '経験が不要とわかった課題はふつうに作る');
  assert.match(
    run(
      `state.tasks[0].description='本日の講義の感想';delete state.tasks[0].personalMode;detail('a');document.getElementById('drawer').innerHTML`
    ),
    /id="generate"/
  );
});
test('設定に「自分について」と「文体」を出し、過去のレポートの読み取りはこのパソコンの設定画面へ案内する', () => {
  const run = boot();
  const html = run(
    `key='k';${SET}state.settings={profile:'経営学部',style:'短い文が多い'};view='settings';render();document.getElementById('app').innerHTML`
  );
  assert.match(html, /id="profile"[^>]*>経営学部</);
  assert.match(html, /id="style"[^>]*>短い文が多い</);
  assert.match(html, /5\. 過去のレポート/);
  assert.match(html, /127\.0\.0\.1:8766\/setup/);
});
test('設定の「自分について」はアンケートで選べ、選んだ答えに印が付く', () => {
  const run = boot();
  const html = run(
    `key='k';${SET}state.settings={profileForm:{faculty:'経営学部',job:['飲食','販売・接客']}};view='settings';render();document.getElementById('app').innerHTML`
  );
  assert.match(html, /id="pfwrap"/);
  assert.match(html, /name="pf-faculty" value="経営学部" checked/);
  assert.match(html, /name="pf-job" value="販売・接客" checked/);
  assert.match(html, /name="pf-year" value="3年">/, '答えていない質問は印なし');
  assert.match(html, /そのほか自分について（自由記述・任意）/);
});
test('授業の設定で保存するファイルの種類を選べ、授業の情報に選んだ種類を出す（古いアプリでは出さない）', () => {
  const run = boot();
  run(`key='k';${SET}state.features=['filetypes'];state.timetable={[courses[0]]:{fileTypes:['PDF','PowerPoint']}}`);
  run(`openCourseConfig(0)`);
  const html = run(`document.getElementById('drawer').innerHTML`);
  assert.match(html, /保存するファイルの種類/);
  assert.match(html, /data-filetype="PDF" checked/);
  assert.match(html, /data-filetype="PowerPoint" checked/);
  assert.doesNotMatch(html, /data-filetype="Word" checked/);
  run(`openCourseConfig(1)`);
  assert.equal(
    (run(`document.getElementById('drawer').innerHTML`).match(/data-filetype="[^"]+" checked/g) || []).length,
    7,
    '未設定ならすべての種類を保存'
  );
  assert.match(run(`courseHeader(0)`), /保存する資料<\/th><td>PDF・PowerPoint/);
  assert.match(run(`courseHeader(1)`), /すべての種類/);
  run(`state.timetable={[courses[0]]:{fileTypes:[]}}`);
  assert.match(run(`courseHeader(0)`), /保存しない/);
  run(`state.features=[]`);
  run(`openCourseConfig(0)`);
  assert.doesNotMatch(run(`document.getElementById('drawer').innerHTML`), /保存するファイルの種類/);
  assert.doesNotMatch(run(`courseHeader(0)`), /保存する資料/);
});
test('課題の詳細：よく使う操作（生成・保存・提出）だけを並べ、manabo で開く・ダウンロードなどは「その他」にまとめる', () => {
  const run = boot();
  const html = run(
    `key='k';${SET}state.features=['attendance'];state.tasks=[{id:'a',course:0,round:3,title:'第3回課題',type:'レポート',status:'draft',answer:'回答',generation:{draft:'回答'},url:'https://manabo.cnc.chukyo-u.ac.jp/content/1/report/tok/'}];detail('a');document.getElementById('drawer').innerHTML`
  );
  const bar = html.slice(html.indexOf('class="actions sticky"'));
  const more = bar.slice(bar.indexOf('class="more-actions"'), bar.indexOf('</details>'));
  assert.match(more, /id="download"/);
  assert.match(more, /manaboで開く/);
  assert.doesNotMatch(more, /id="generate"|id="save"|id="submit"/);
  assert.match(bar, /id="generate"/);
  assert.match(bar.slice(bar.indexOf('</details>')), /id="submit"/, '提出は「その他」の外に分けて置く');
});
test('「課題を生成」の処理中は、資料の確認中か回答の作成中かを出す', () => {
  const run = boot();
  assert.equal(run(`generatingText({phase:'新しい資料の確認'})`), '新しい資料を確認中…');
  assert.equal(run(`generatingText({phase:'授業','done':1})`), '新しい資料を確認中…', '授業の読み直しの途中');
  assert.equal(run(`generatingText({phase:'回答の作成'})`), '回答を作成中…');
  assert.equal(run(`generatingText(null)`), '回答中…');
});
test('設定の自動処理は変えるとすぐ保存し（保存ボタンはない）、保存する資料の種類の全授業の既定を選べる', () => {
  const run = boot();
  const html = run(
    `key='k';${SET}state.features=['filetypes','defaultfiletypes'];state.settings={fileTypes:['PDF']};view='settings';render();document.getElementById('app').innerHTML`
  );
  assert.doesNotMatch(html, /<button[^>]*id="savesettings"/);
  assert.match(html, /id="autosettings"/);
  assert.match(html, /変更はすぐに保存します/);
  assert.match(html, /保存する資料の種類（全授業の既定）/);
  assert.match(html, /data-deftype="PDF" checked/);
  assert.doesNotMatch(html, /data-deftype="Word" checked/);
  assert.match(run(`courseHeader(0)`), /保存する資料<\/th><td>PDF <span class="muted">（全授業の既定）/);
  run(`state.timetable={[courses[0]]:{fileTypes:['Word']}}`);
  assert.match(run(`courseHeader(0)`), /保存する資料<\/th><td>Word<\/td>/, '授業ごとの指定が優先');
  run(`openCourseConfig(1)`);
  const drawer = run(`document.getElementById('drawer').innerHTML`);
  assert.match(drawer, /id="cc-ftdefault" checked/);
  assert.match(drawer, /data-filetype="PDF" checked/);
  assert.doesNotMatch(drawer, /data-filetype="Word" checked/, '既定に従う授業は既定の種類に印');
  run(`state.features=['filetypes'];view='settings';render()`);
  assert.doesNotMatch(run(`document.getElementById('app').innerHTML`), /全授業の既定/, '古いアプリでは出さない');
});
