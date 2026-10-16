const icons = {
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>'
};
const ic = n => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[n]}</svg>`;
const API =
  ['localhost', '127.0.0.1'].includes(location.hostname) && location.port === '8787'
    ? location.origin
    : 'https://coursecue.hrk-6888.workers.dev';
// 学年暦：管理者画面で更新したもの（/api/academic-calendar）。取れなければ同梱のもの
const academicCalendar = () =>
  fetch(API + '/api/academic-calendar')
    .then(r => {
      if (!r.ok) throw Error();
      return r.json();
    })
    .catch(() => fetch('./academic-calendar.json').then(r => r.json()));
// 授業の一覧は PC の同期が manabo から集めたもの（state.courses）。接続前・同期前は空
let courses = [];
// manabo の授業 ID。未設定（''）の授業は Mac サービスが同期時に授業一覧から探して state.courseIds に入れる
const courseIdOf = i => state?.courses?.[i]?.id || state?.courseIds?.[courses[i]] || '';
// 同期した状態に授業一覧（Mac が manabo から取ったもの）があればそれを使う。古い Mac の状態なら固定の一覧
function adoptCourses() {
  if (key && Array.isArray(state?.courses)) courses = state.courses.map(c => c.name);
}
// 本人が動けば終わる状態は琥珀（wait）、異常は赤（alert）で分ける
// 状態の色は 3 系統：オレンジ＝あなたがすること、灰・青＝これから（saboro が進める／下書き）、緑＝完了。期限切れは締切の赤字で示す
const statuses = {
  ready: ['未着手', 'ready'],
  answered: ['本人の提出待ち', 'wait'],
  wait: ['要確認', 'wait'],
  code: ['出席コード待ち', 'wait'],
  draft: ['下書き', 'draft'],
  done: ['提出済み', 'done'],
  unknown: ['提出結果を確認', 'wait']
};
const taskTypes = ['課題', 'レポート', 'クイズ'];
// 前回の同期にかかった時間（Mac の記録）。ヘッダーには出さず、ホームの概要の下に表示する
const sec = ms => `${Math.max(1, Math.round(ms / 1000))}秒`;
// 「前回の同期」：manabo の内容を反映し終えた時刻（state.lastSync）と、かかった時間。同期を押しても時刻が変わらなければ、まだ終わっていない
const lastSyncText = () =>
  `前回の同期 ${state.lastSync ? `${esc(when(state.lastSync))} に反映` : ''}${syncTimingText() ? `${state.lastSync ? '・' : ''}${esc(syncTimingText())}` : ''}${syncSummaryText() ? `<br>${esc(syncSummaryText())}` : ''}`;
// 今回の同期で何をしたか（PC の state.syncSummary）：授業 n・資料 m 件保存・お知らせ k 件・失敗 j
function syncSummaryText(sm = state.syncSummary) {
  if (!sm || sm.scope !== 'all') return '';
  return `授業 ${sm.courses} 件・資料 ${sm.materials} 件保存・お知らせ ${sm.notices} 件${sm.newNotices ? `（新着 ${sm.newNotices}）` : ''}・失敗 ${sm.failures} 件`;
}
const courseSummaryText = name => {
  const r = state.courseSummary?.[name];
  return r ? `資料 ${r.materials} 件保存・お知らせ ${r.notices} 件${r.failures ? `・失敗 ${r.failures} 件` : ''}` : '';
};
// バージョンの比較（1.0.43 < 1.0.44）
const newerVersion = (a, b) => {
  const x = String(a || '')
      .split('.')
      .map(Number),
    y = String(b || '')
      .split('.')
      .map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
function syncTimingText() {
  const t = state.syncTiming;
  if (!t?.total) return '';
  const slow = Object.entries(t.courses || {}).sort((a, b) => b[1] - a[1])[0];
  return `${sec(t.total)}（CUBICS ${t.cubicsSkipped ? '1時間以内に確認済みのため省略' : sec(t.cubics || 0)}・授業 ${sec(t.classes ?? Object.values(t.courses || {}).reduce((a, b) => a + b, 0))}${slow ? `［最長 ${slow[0]} ${sec(slow[1])}］` : ''}${t.generated ? `・回答生成 ${t.generated}件 ${sec(t.generate)}` : ''}）`;
}
const views = {
  home: 'ホーム',
  courses: '授業',
  timetable: '時間割',
  tasks: '課題',
  attendance: '出席',
  needs: '要対応',
  settings: '設定'
};
// メニューに出す画面。授業はディレクトリから、要対応はホームの概要から開く
// 使う順に並べる。課題一覧の既定は「未提出」（やることが先に見える）
const navViews = ['home', 'tasks', 'timetable', 'attendance', 'settings'],
  filters = ['pending', 'overdue', 'soon', 'done', 'all'],
  DEFAULT_FILTER = 'pending',
  searchViews = ['home', 'courses', 'tasks', 'needs'];
const emptyState = () => ({tasks: [], materials: [], settings: {time: '16:30'}});
// 接続している端末の呼び名：Windows のアプリは PC、Mac と OS を知らせない古い版は Mac
// 同期で出た問題（「授業名：内容」）を、授業日が未設定の授業と、それ以外（授業情報を読み取れないなど）に分ける。それ以外は同じ内容ごとにまとめる
// 削除した授業（manabo連携で「この授業を削除」したもの）。一覧・時間割・設定に出さない
const removedCourse = i => !!(key && state?.courses?.[i]?.removed);
// ホーム上部の「要確認」：同期のエラー・AI が使えない・授業日が未設定・読み取れなかった情報を 1 枚にまとめる（同じ原因は 1 行）
const setupLink = ' <a href="http://127.0.0.1:8766/setup" target="_blank" rel="noopener">設定を開く</a>';
// ゴミ箱へ移した資料の知らせ：「閉じる」を押したときまでに移した分は出さない（この画面に覚える。新しく移したらまた出す）
const trashSeen = () => {
  try {
    return localStorage.getItem('coursecue-trash-seen') || '';
  } catch {
    return '';
  }
};
const aiReason = r => /課題生成に失敗|授業情報の読み取りに失敗/.test(r);
function attentionPanel() {
  if (!key) return '';
  const lines = [];
  const err = state.lastError && !(state.aiMissing && aiReason(state.lastError)) ? state.lastError : '';
  if (err)
    lines.push(
      `${state.lastErrorAt ? `<span class="muted">${when(state.lastErrorAt)}</span> ` : ''}${esc(briefError(err))}${/課題生成|API|キー|ID|パスワード|ログイン|認証|キーチェーン/.test(err) ? setupLink : ''}`
    );
  if (state.aiMissing)
    lines.push(
      `この ${dev()} では SaBoRo課題サポートを使えないため、回答の作成と授業情報の読み取りを省いています。${setupLink}`
    );
  // アプリが最新のバージョンより古い（クラウドが公開時のバージョンを知らせる）：更新の案内
  if (state.runtime === 'desktop' && state.version && newerVersion(state.latestVersion, state.version))
    lines.push(
      `新しいバージョン ${esc(state.latestVersion)} があります（いまは ${esc(state.version)}）。${state.os === 'win32' ? '画面右下の saboro のアイコンを右クリック' : 'メニューバーの saboro'} →「新しいバージョンを確認」から更新してください。`
    );
  const {undated, other} = issueSummary(state.issues || []);
  if (undated.length)
    lines.push(
      `授業日が未設定：${undated.map(esc).join('、')}（新しい課題を自動で見つけられません） <button class="linklike" data-view="settings">授業日を登録</button>`
    );
  for (const x of other) {
    if (state.aiMissing && aiReason(x.reason)) continue;
    lines.push(`${esc(briefError(x.reason))}：${x.names.map(esc).join('、')}`);
  }
  const recent = (state.trashed || []).filter(x => Date.now() - new Date(x.at) < 30 * DAY && x.at > trashSeen());
  const note = recent.length
    ? `<details class="attention-note"><summary>重複して保存されていた資料 ${recent.length} 件を ${dev()} のゴミ箱へ移動しました</summary><p>${recent.map(x => `${esc(x.name)}<span class="muted">（${when(x.at)}）</span>`).join('、')}</p></details><button class="linklike" id="trashseen" data-at="${esc(
        recent
          .map(x => x.at)
          .sort()
          .at(-1)
      )}">確認したので閉じる</button>`
    : '';
  if (!lines.length) return note ? `<div class="alert alert-info">${note}</div>` : '';
  return `<section class="alert alert-warning attention" id="attention" aria-label="要確認"><h2>要確認 <span class="attention-count">${lines.length}</span></h2><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>${note}</section>`;
}
// 課題の AI 利用の方針：授業の設定（自分の設定）があればそれを、なければその回の授業資料と課題の説明から判断した結果（t.aiPolicy）
function aiRule(t) {
  const own = state.timetable?.[courses[t.course]]?.ai,
    auto = t.aiPolicy;
  if (own === '禁止') return {forbidden: true, from: '自分の設定'};
  if (own === '許可') return {forbidden: false, from: '自分の設定'};
  if (auto?.forbidden) return {forbidden: true, from: '資料', evidence: auto.evidence, file: auto.file};
  return {forbidden: false, from: auto ? '資料に記載なし' : ''};
}
const aiNotice = (r, quiz) =>
  `<div class="ai-forbidden"><b>この回は AI の利用が禁止されています。</b>${quiz ? '回答は入力しますが、内容を自分で確認・修正してから manabo で提出してください。' : '表示している回答は参考です。自分で書いて manabo で提出してください（saboro からは提出しません）。'}${r.evidence ? `<small>根拠（${esc(r.file || '資料')}）：「${esc(r.evidence)}」</small>` : r.from === '自分の設定' ? '<small>授業の設定で「禁止」にしています。</small>' : ''}</div>`;
function issueSummary(issues) {
  const nameOf = s => {
      const m = String(s).match(/^(.+?)(?:\s第\d+回)?：/);
      return m ? m[1] : String(s);
    },
    reasonOf = s => {
      const i = String(s).indexOf('：');
      return i < 0 ? String(s) : String(s).slice(i + 1);
    };
  const undated = [...new Set(issues.filter(s => /：授業日未設定/.test(s)).map(nameOf))],
    groups = new Map();
  for (const s of issues.filter(s => !/：授業日未設定/.test(s))) {
    const r = reasonOf(s);
    groups.set(r, [...new Set([...(groups.get(r) || []), nameOf(s)])]);
  }
  return {undated, other: [...groups].map(([reason, names]) => ({reason, names}))};
}
const dev = () => (state?.os === 'win32' ? 'PC' : 'Mac');
let state = emptyState(),
  view = 'home',
  filter = DEFAULT_FILTER,
  query = '',
  selectedCourse = null,
  lastFocus = null,
  dialogDone = null,
  key = localStorage.getItem('coursecue-owner') || '';
// 画面の状態：Mac の記録を読めたか（loaded）、接続できない理由（offline）、処理中のボタン（busy）、ドロワーの未保存（dirty）、メニュー・ディレクトリの開閉
let loaded = !key,
  offline = '',
  dirty = false,
  drawerRoute = '',
  pendingDrawer = '',
  restoring = false,
  menuOpen = false,
  dirOpen = false;
const busy = {};
const ownerCourses = [...courses];
let guestData;
try {
  guestData = JSON.parse(localStorage.getItem('coursecue-personal') || 'null');
} catch {}
if (!key) {
  courses = guestData?.courses || [];
  state = guestData?.state || emptyState();
}
function savePersonal() {
  localStorage.setItem('coursecue-personal', JSON.stringify({courses, state}));
}
const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const DAY = 86400000,
  HOUR = 3600000;
const dueTime = t => (t.dueAt ? new Date(t.dueAt).getTime() : null);
const when = s =>
  s
    ? new Date(s).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: 'numeric',
        day: 'numeric',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '未確認';
const needs = t => ['wait', 'code', 'unknown', 'answered'].includes(t.status);
const pending = t => t.status !== 'done';
const overdue = t => pending(t) && !!t.dueAt && dueTime(t) <= Date.now();
const soon = t => pending(t) && !!t.dueAt && dueTime(t) > Date.now() && dueTime(t) - Date.now() <= 3 * DAY;
function remaining(t) {
  const ms = dueTime(t) - Date.now(),
    a = Math.abs(ms),
    span =
      a >= DAY
        ? Math.floor(a / DAY) + '日'
        : a >= HOUR
          ? Math.floor(a / HOUR) + '時間'
          : Math.max(1, Math.floor(a / 60000)) + '分';
  return ms <= 0 ? '期限切れ · ' + span + '超過' : 'あと' + span;
}
// 連携時は manabo から未取得、個人用では本人が未入力なので言い方を変える
const noDue = () => (key ? '締切未確認' : '締切未設定');
function deadline(t) {
  if (!t.dueAt) return `<span class="deadline">${noDue()}</span>`;
  if (!pending(t)) return `<span class="deadline">締切 ${when(t.dueAt)}</span>`;
  const level = overdue(t) ? 'overdue' : dueTime(t) - Date.now() <= DAY ? 'urgent' : soon(t) ? 'soon' : '';
  return `<span class="deadline ${level}">締切 ${when(t.dueAt)}<small>${remaining(t)}</small></span>`;
}
const localInput = s => {
  if (!s) return '';
  const d = new Date(s);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const round = t => (t.round ? '第' + t.round + '回' : key ? '回数未確認' : '回数未設定');
async function api(path, method = 'GET', data) {
  const r = await fetch(API + path, {
    method,
    headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
    body: data ? JSON.stringify(data) : undefined
  });
  if (r.status === 401) throw Error(dev() + ' から接続してください');
  if (r.status === 402) throw Error('お支払いが必要です。画面の「お支払い」から手続きしてください');
  if (!r.ok) throw Error('接続できません');
  return r.json();
}
function toast(s) {
  const e = document.getElementById('toast');
  e.textContent = s;
  e.style.display = 'block';
  e.onclick = () => {
    e.style.display = 'none';
  };
  clearTimeout(window.tt);
  window.tt = setTimeout(() => (e.style.display = 'none'), 5000);
}
// 「3時間前」など。ヘッダーの同期時刻に添える
function ago(s) {
  if (!s) return '';
  const m = Math.round((Date.now() - new Date(s)) / 60000);
  return m < 1
    ? 'たった今'
    : m < 60
      ? `${m}分前`
      : m < 1440
        ? `${Math.floor(m / 60)}時間前`
        : `${Math.floor(m / 1440)}日前`;
}
// 履歴（戻る・進む）：#v=画面&c=授業&f=絞り込み&d=ドロワー
const hasHistory = typeof history !== 'undefined' && typeof history.pushState === 'function';
function hashOf() {
  const p = new URLSearchParams();
  if (view !== 'home') p.set('v', view);
  if (selectedCourse !== null) p.set('c', selectedCourse);
  if (filter !== DEFAULT_FILTER) p.set('f', filter);
  if (drawerRoute) p.set('d', drawerRoute);
  const s = p.toString();
  return s ? '#' + s : location.pathname + (location.search || '');
}
function pushRoute(replace = false) {
  if (!hasHistory) return;
  const data = {saboro: true, d: drawerRoute};
  try {
    replace ? history.replaceState(data, '', hashOf()) : history.pushState(data, '', hashOf());
  } catch {}
}
function readRoute() {
  const p = new URLSearchParams((location.hash || '').slice(1));
  const v = p.get('v');
  view = v && views[v] ? v : 'home';
  const c = p.get('c');
  selectedCourse = c !== null && courses[+c] !== undefined ? +c : null;
  if (selectedCourse !== null) view = 'courses';
  filter = filters.includes(p.get('f')) ? p.get('f') : DEFAULT_FILTER;
  return p.get('d') || '';
}
function go(v, c = null, f = DEFAULT_FILTER) {
  view = v;
  selectedCourse = c;
  filter = f;
  menuOpen = false;
  dirOpen = false;
  pushRoute();
  render();
  if (typeof scrollTo === 'function') scrollTo(0, 0);
}
function openRoute(d) {
  const [kind, arg = ''] = d.split(':');
  if (kind === 'task') detail(arg);
  else if (kind === 'new') addTaskDrawer();
  else if (kind === 'session' && typeof openSession === 'function') {
    const [i, r] = arg.split('.').map(Number);
    if (courses[i] !== undefined && r) openSession(i, r);
  } else if (kind === 'course' && typeof openCourseConfig === 'function' && courses[+arg] !== undefined)
    openCourseConfig(+arg);
  else if (kind === 'att' && typeof openAttendance === 'function' && courses[+arg] !== undefined) openAttendance(+arg);
}
function restoreDrawer() {
  if (!pendingDrawer || !loaded) return;
  const d = pendingDrawer;
  pendingDrawer = '';
  restoring = true;
  try {
    openRoute(d);
  } finally {
    restoring = false;
  }
}
// 処理中のボタン：再描画しても「同期中…」などの表示と無効化を保つ
function setBusy(id, label) {
  if (label) busy[id] = label;
  else delete busy[id];
  applyBusy();
}
function applyBusy() {
  for (const [id, label] of Object.entries(busy)) {
    const b = document.getElementById(id);
    if (b) {
      b.disabled = true;
      b.textContent = label;
    }
  }
  if (key && state.running && !busy.sync) {
    const b = document.getElementById('sync');
    if (b) {
      b.disabled = true;
      b.textContent = state.running === 'sync' ? '同期中…' : dev() + ' が処理中…';
    }
  }
  if (key && state.running && !busy.synccourse) {
    const b = document.getElementById('synccourse');
    if (b) b.disabled = true;
  }
}
// 処理中の表示：同期なら「同期中 3/9（管理会計Ⅱ）」のように進み具合を出す。端末からの知らせが 5 分以上変わらなければ止まっている可能性を出す（回答の作成は 1 件に数分かかることがある）
function runningText() {
  const p = state.progress,
    label = state.running === 'sync' ? '同期中' : '処理中';
  if (!p) return label;
  const quiet = Date.now() - new Date(p.at || 0).getTime();
  if (quiet > 5 * 60000) return `${label}（${Math.round(quiet / 60000)}分間変化がありません）`;
  return `${label}：${p.phase}${p.total ? ` ${p.done}/${p.total}` : ''}${p.current ? `（${String(p.current).slice(0, 24)}）` : ''}`;
}
async function load() {
  if (document.activeElement?.matches?.('input,textarea,select')) return;
  if (!key) {
    render();
    return;
  }
  try {
    state = await api('/api/state');
    adoptCourses();
    const first = !loaded;
    loaded = true;
    if (offline) {
      offline = '';
      toast('接続を回復しました');
    }
    if (typeof reapplyPending === 'function') reapplyPending();
    render();
    if (first) restoreDrawer();
    showPrompts();
  } catch (e) {
    if (offline !== e.message) toast(e.message);
    offline = e.message;
    render();
  }
}
// 出力が上限で途切れた課題で、今月の高度な生成がまだ使えるか
const advancedLeft = t => t.status === 'wait' && !!t.advancedOffer && t.advancedOffer.used < t.advancedOffer.limit;
async function job(kind, task = null, payload = {}, buttonFor = null) {
  if (!key) {
    toast('manabo連携が必要です');
    return;
  }
  try {
    const queued = await api('/api/jobs', 'POST', {kind, task, payload});
    toast(
      payload.pickDownloadDir
        ? dev() + ' にフォルダの選択画面を出します'
        : kind === 'sync'
          ? '同期を開始します'
          : kind === 'generate'
            ? '自動回答を開始します'
            : kind === 'supplement' || kind === 'timetable'
              ? '保存しました'
              : kind === 'link'
                ? '対応づけを予約しました。次の同期で締切・提出状況を確認します'
                : kind === 'prompt'
                  ? '出席コードを送りました（' + dev() + ' が manabo に入れます）'
                  : kind === 'seen'
                    ? 'お知らせを確認済みにします'
                    : '処理を予約しました'
    );
    if (['generate', 'sync', 'settings', 'attendance'].includes(kind)) {
      const buttonId = buttonFor || (kind === 'sync' ? 'sync' : kind === 'settings' ? 'savesettings' : 'generate');
      setBusy(
        buttonId,
        kind === 'sync'
          ? '同期開始待ち…'
          : payload.pickDownloadDir
            ? dev() + ' の応答待ち…'
            : kind === 'settings'
              ? dev() + ' に反映中…'
              : '開始待ち…'
      );
      const poll = setInterval(async () => {
        try {
          const jobs = await api('/api/jobs');
          const current = jobs.find(j => j.id === queued.id);
          if (!current) return;
          setBusy(
            buttonId,
            payload.pickDownloadDir
              ? current.status === 'running'
                ? dev() + ' で選択してください…'
                : state.running
                  ? dev() + ' が別の処理中（終わると画面が出ます）…'
                  : dev() + ' の応答待ち…'
              : kind === 'settings'
                ? dev() + ' に反映中…'
                : current.status === 'running'
                  ? kind === 'sync'
                    ? '同期中…'
                    : kind === 'attendance'
                      ? '提出中…'
                      : '回答中…'
                  : '開始待ち…'
          );
          if (['done', 'waiting', 'failed'].includes(current.status)) {
            clearInterval(poll);
            setBusy(buttonId, '');
            await load();
            if (task && !dirty && document.getElementById('overlay').classList.contains('open')) detail(task);
            const result = typeof current.result === 'string' ? JSON.parse(current.result) : current.result;
            toast(
              kind === 'attendance' && result?.taskStatus === 'done'
                ? '出席コードを入れて提出しました'
                : kind === 'sync' && current.status === 'done'
                  ? '同期しました'
                  : kind === 'settings' && current.status === 'done'
                    ? payload.pickDownloadDir || payload.downloadDir !== undefined
                      ? result?.message || dev() + ' が新しいバージョンではないため変更できませんでした'
                      : '設定を保存しました'
                    : briefError(result?.message || '処理を確認してください')
            );
          }
        } catch {
          clearInterval(poll);
          setBusy(buttonId, '');
          toast('処理状況を取得できません');
        }
      }, 2000);
    }
    await load();
  } catch (e) {
    toast(e.message);
  }
}
// confirm() の代わりに使う確認ダイアログ
function ask(message, ok = 'OK', danger = false) {
  return new Promise(resolve => {
    const d = document.getElementById('dialog'),
      prev = document.activeElement;
    d.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-text"><div class="modal-header" id="dialog-title">確認</div><p class="modal-body" id="dialog-text">${esc(message)}</p><div class="modal-footer"><button class="btn" id="dialog-cancel">キャンセル</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="dialog-ok">${esc(ok)}</button></div></div>`;
    d.classList.add('open');
    const done = v => {
      d.classList.remove('open');
      d.innerHTML = '';
      dialogDone = null;
      prev?.focus?.();
      resolve(v);
    };
    dialogDone = done;
    document.getElementById('dialog-ok').onclick = () => done(true);
    document.getElementById('dialog-cancel').onclick = () => done(false);
    d.onclick = e => {
      if (e.target === d) done(false);
    };
    document.getElementById('dialog-cancel').focus();
  });
}
// 出席コードの入力：PC の同期で manabo の授業ページに出た入力画面（prompt）を、この画面にも同じ形で出す。入れると PC が manabo の入力画面に渡す
function promptCode(name, message) {
  return new Promise(resolve => {
    const d = document.getElementById('dialog'),
      prev = document.activeElement;
    d.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-text"><div class="modal-header" id="dialog-title">${esc(name)}：manabo の入力</div><div class="modal-body"><p id="dialog-text" style="margin:0 0 10px">${esc(message || '出席コードを入力してください')}</p><input class="form-control" id="dialog-input" inputmode="numeric" autocomplete="off" aria-label="出席コード"></div><div class="modal-footer"><button class="btn" id="dialog-cancel">あとで</button><button class="btn btn-primary" id="dialog-ok">OK</button></div></div>`;
    d.classList.add('open');
    const done = v => {
      d.classList.remove('open');
      d.innerHTML = '';
      dialogDone = null;
      prev?.focus?.();
      resolve(v);
    };
    dialogDone = () => done(null);
    const input = document.getElementById('dialog-input');
    document.getElementById('dialog-ok').onclick = () => done(input.value.trim());
    document.getElementById('dialog-cancel').onclick = () => done(null);
    input.onkeydown = e => {
      if (e.key === 'Enter') done(input.value.trim());
    };
    d.onclick = e => {
      if (e.target === d) done(null);
    };
    input.focus();
  });
}
// 入力待ちの出席コード（PC の状態 state.prompts）。一度出した入力は、同じものをもう一度自動では出さない（ホームの「入力する」で出せる）
const promptShown = new Set();
const pendingPrompts = () => Object.entries(state?.prompts || {}).map(([name, p]) => ({name, ...p}));
let promptBusy = false;
async function showPrompts(force = null) {
  if (promptBusy || dialogDone) return;
  const list = pendingPrompts().filter(p => (force ? p.name === force : !promptShown.has(p.name + p.at)));
  if (!list.length) return;
  promptBusy = true;
  try {
    for (const p of list) {
      promptShown.add(p.name + p.at);
      const code = await promptCode(p.name, p.message);
      if (code) await job('prompt', null, {course: p.name, code});
    }
  } finally {
    promptBusy = false;
  }
}
// 新着のお知らせ（PC の state.newNotices）。「確認した」で PC に見た印を付けて消す
function noticePanel() {
  const list = state.newNotices || [];
  if (!list.length) return '';
  return `<div class="alert alert-info"><strong>新しいお知らせ ${list.length} 件</strong><ul class="notes" style="margin:6px 0">${list
    .slice(0, 20)
    .map(
      n =>
        `<li>${esc(n.course)}：${esc(n.title)}${n.date ? ` <span class="muted">（${esc(jpDate(n.date))}）</span>` : ''}</li>`
    )
    .join(
      ''
    )}</ul>${list.length > 20 ? `<p class="muted">ほか ${list.length - 20} 件</p>` : ''}<button class="btn btn-sm" data-seen="all">確認した</button></div>`;
}
function promptPanel() {
  const list = pendingPrompts();
  if (!list.length) return '';
  return list
    .map(
      p =>
        `<div class="alert alert-warning"><strong>${esc(p.name)}</strong>：manabo で出席コードの入力画面が出ています（${when(p.at)}）。<button class="btn btn-primary" data-prompt="${esc(p.name)}" style="margin-left:8px">入力する</button></div>`
    )
    .join('');
}
// ドロワー。route を渡すと履歴に積み、戻るで閉じられる。別のドロワーに置き換わるときは履歴を増やさない
function openDrawer(title, body, focusId, route = '') {
  const o = document.getElementById('overlay'),
    was = o.classList.contains('open');
  if (!was) lastFocus = document.activeElement;
  const d = document.getElementById('drawer');
  d.innerHTML = `<div class="drawerhead"><h2 id="drawer-title">${esc(title)}</h2><button class="close" id="close" aria-label="閉じる">${ic('close')}</button></div><div class="drawerbody">${body}</div>`;
  dirty = false;
  d.oninput = () => {
    dirty = true;
  };
  o.classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('close').onclick = () => close();
  if (route) {
    const changed = route !== drawerRoute;
    drawerRoute = route;
    if (changed && !restoring) pushRoute(was);
  }
  applyBusy();
  document.getElementById(focusId || 'close').focus();
}
function closeNow() {
  const o = document.getElementById('overlay');
  dirty = false;
  drawerRoute = '';
  if (!o.classList.contains('open')) return;
  o.classList.remove('open');
  document.body.style.overflow = '';
  lastFocus?.focus?.();
}
async function close(force = false) {
  const o = document.getElementById('overlay');
  if (!o.classList.contains('open')) return;
  if (!force && dirty && !(await ask('保存していない変更があります。閉じますか？', '閉じる', true))) return;
  const pushed = hasHistory && history.state?.d;
  closeNow();
  if (pushed) history.back();
  else pushRoute(true);
}
const panel = (title, body, {mark = true, center = false, tools = '', flush = false, id = ''} = {}) =>
  `<section class="panel"${id ? ` id="${id}"` : ''}><h2 class="panel-heading${center ? ' center' : ''}">${mark ? '<span class="mark" aria-hidden="true"></span>' : ''}${title}${tools ? `<span class="tools">${tools}</span>` : ''}</h2><div class="panel-body${flush ? ' flush' : ''}">${body}</div></section>`;
function row(t) {
  const [label, cl] = statuses[t.status] || ['未確認', 'ready'];
  return `<li><button class="task" data-task="${esc(t.id)}"><span class="task-main"><span class="task-title">${esc(t.title)}</span><span class="meta">${esc(courses[t.course] ?? '授業未設定')} · ${round(t)} · ${esc(t.type || '課題')}${courses[t.course] != null && aiRule(t).forbidden ? ' · <span class="attn">AI利用禁止</span>' : ''}</span>${needs(t) && t.action ? `<span class="rowaction">${esc(t.action)}</span>` : ''}</span><span class="right"><span class="label ${cl}">${label}</span>${deadline(t)}</span></button></li>`;
}
const inFilter = (t, f) =>
  f === 'all' ||
  (f === 'pending' && pending(t)) ||
  (f === 'done' && !pending(t)) ||
  (f === 'soon' && soon(t)) ||
  (f === 'overdue' && overdue(t));
function matched(t, f = filter) {
  const q = query.trim().toLowerCase();
  return (
    (!q || ((courses[t.course] || '') + t.title).toLowerCase().includes(q)) &&
    (selectedCourse === null || selectedCourse === t.course) &&
    inFilter(t, f)
  );
}
const byDue = (a, b) => pending(b) - pending(a) || (dueTime(a) ?? Infinity) - (dueTime(b) ?? Infinity);
// タブには絞り込み前の件数を添える
function list(rows, tabs = true, empty = '課題はありません') {
  const shown = rows.filter(t => matched(t)).sort(byDue),
    all = rows.filter(t => matched(t, 'all')).length;
  return `${
    tabs
      ? `<div class="tabs">${[
          ['pending', '未提出'],
          ['overdue', '期限切れ'],
          ['soon', '3日以内'],
          ['done', '提出済み'],
          ['all', 'すべて']
        ]
          .map(
            ([v, l]) =>
              `<button class="tab ${v === filter ? 'active' : ''}" data-filter="${v}" aria-pressed="${v === filter}">${l}<span class="count">${rows.filter(t => matched(t, v)).length}</span></button>`
          )
          .join('')}</div>`
      : ''
  }${shown.length ? `<ul class="tasklist">${shown.map(row).join('')}</ul>` : `<p class="empty">${query ? '検索に一致する課題はありません' : tabs && filter !== 'all' && all ? `この絞り込みに該当する課題はありません。<button class="linklike" data-filter="all">すべて（${all}件）を見る</button>` : empty}</p>`}`;
}
// 授業ページの先頭：曜日・教室・形式・次回・出席のまとめ（時間割の関数がある場合）
// 授業ごとの同期：課題一覧の見出しに、この授業を manabo で最後に確かめた時刻（全体の同期か、この授業の同期の新しい方）とボタンを出す
// 経験・体験を問う課題：「質問に答えて生成」だけを出す（AI が経験を組み立てる作り方は選べない）。PERSONAL は local/generate.js と同じ
const PERSONAL =
  /経験|体験|エピソード|思い出(?![しすせそ])|あなた自身|自分自身|(?:あなた|自分)が.{0,15}(?:した|してきた|行った|参加した|取り組んだ)/;
const personalTask = t =>
  !!key &&
  t.personalMode !== 'plain' &&
  (!!t.personalChoice || PERSONAL.test([t.title, t.description].filter(Boolean).join('\n')));
function personalSection(t) {
  if (!personalTask(t)) return '';
  const qs = t.personalQuestions || [];
  const head = `<p class="muted">経験・体験を元に答える課題です。「質問に答えて生成」を押すと、かんたんな質問（最大 6 問）が出ます。答えると、その内容を元に回答を作ります。${t.personalMode === 'answers' ? '今の回答は、質問への答えを元に作ったものです。' : ''}</p>`;
  if (!qs.length) return `<div class="drawer-section">${head}</div>`;
  return `<details class="drawer-section" open><summary>質問に答える（${qs.length}問）</summary>${head}${qs.map((q, i) => `<div class="field"><label${q.choices.length ? '' : ` for="pqx${i}"`}>${i + 1}. ${esc(q.text)}</label>${q.choices.length ? `<div>${q.choices.map(c => `<label class="check"><input type="radio" name="pq${i}" value="${esc(c)}"> ${esc(c)}</label>`).join(' ')}</div><input class="form-control" id="pqx${i}" maxlength="200" placeholder="ほかの答え・くわしく（任意）">` : `<input class="form-control" id="pqx${i}" maxlength="200">`}</div>`).join('')}<label class="check"><input type="checkbox" id="pqsave"> 答えを設定の「自分について」に保存する（次から同じことを聞かれにくくなります）</label><div class="actions"><button class="btn btn-primary" id="personalsend">答えて生成</button></div></details>`;
}
function courseSyncTools(i) {
  if (!key) return '';
  const at = [state.lastSync, state.courseSynced?.[courses[i]]].filter(Boolean).sort().at(-1);
  const sm = courseSummaryText(courses[i]);
  return `${at ? `<span class="muted">${esc(when(at))} に確認${sm ? `（${esc(sm)}）` : ''}</span> ` : ''}<button class="linklike" id="synccourse">この授業を同期</button>`;
}
function courseHeader(i) {
  if (typeof courseConfig !== 'function') return '';
  const cfg = courseConfig(i),
    s = typeof attendanceSummary === 'function' ? attendanceSummary(i) : null,
    dates = typeof courseDates === 'function' ? courseDates(i) : {},
    today = typeof todayISO === 'function' ? todayISO() : '',
    next = Object.entries(dates).find(([, d]) => d >= today);
  const unset = '<span class="muted">未設定</span>';
  return panel(
    '授業の情報',
    `<table class="table-default"><tr><th>曜日・時限</th><td>${cfg.weekday ? `${esc(cfg.weekday)}曜${cfg.period ? ` ${cfg.period}限` : ''}` : unset}</td></tr><tr><th>教室</th><td>${esc(cfg.room) || unset}</td></tr><tr><th>授業形式</th><td>${(typeof modeLabel === 'function' && modeLabel(cfg.mode)) || unset}${cfg.modeFrom ? ` <span class="muted">（${cfg.modeFrom === 'CUBICS' ? 'CUBICSから推定' : '資料'}）</span>` : ''}</td></tr><tr><th>AI の利用</th><td>${(() => {
      const own = state.timetable?.[courses[i]]?.ai;
      if (own)
        return own === '禁止'
          ? '<span class="attn">禁止</span> <span class="muted">（自分の設定・全回）</span>'
          : '<span class="muted">許可（自分の設定・全回）</span>';
      const banned = [
        ...new Set(state.tasks.filter(t => t.course === i && t.aiPolicy?.forbidden).map(t => t.round))
      ].sort((a, b) => a - b);
      return banned.length
        ? `<span class="attn">禁止の回：${banned.map(r => `第${r}回`).join('、')}</span> <span class="muted">（その回の資料）</span>`
        : '<span class="muted">禁止の記載なし（その回の資料から判断）</span>';
    })()}</td></tr><tr><th>次回</th><td>${next ? `第${next[0]}回 ${typeof dayLabel === 'function' ? dayLabel(next[1]) : next[1]}${next[1] === today ? ' <span class="label draft">今日</span>' : ''}` : '<span class="muted">予定なし</span>'}</td></tr>${s ? `<tr><th>出席</th><td>出席 ${s.出席}・遅刻 ${s.遅刻}・欠席 ${s.欠席}・公欠 ${s.公欠}${cfg.limit != null ? `（欠席の上限 ${cfg.limit}回）` : ''}${s.未記録 ? ` <span class="attn">未記録 ${s.未記録}</span>` : ''}</td></tr>` : ''}</table><div class="actions"><button class="btn btn-sm" data-coursecfg="${i}">授業の設定</button><button class="btn btn-sm" data-attendance="${i}">出席を記録</button><button class="btn btn-sm" data-view="timetable">時間割へ</button>${key && state.features?.includes('removecourse') ? `<button class="btn btn-sm" id="removecourse-${i}" data-removecourse="${i}">この授業を削除</button>` : ''}</div>`
  );
}
// 左のディレクトリ。スマホでは manabo と同じくボタンで開閉する
function directory() {
  const total = state.tasks.filter(pending).length;
  return (
    `<button class="menu-collapse" id="dirtoggle" aria-expanded="${dirOpen}" aria-controls="dirpanel">ディレクトリ${total ? `<span class="badge">${total}<span class="sr-only">件未提出</span></span>` : ''}</button>` +
    panel(
      'ディレクトリ',
      `<button class="topdir ${view === 'courses' && selectedCourse === null ? 'selected' : ''}" data-view="courses">授業一覧</button><ul class="dirlist">${courses
        .map((c, i) => {
          if (removedCourse(i)) return '';
          const n = state.tasks.filter(t => t.course === i && pending(t)).length;
          return `<li><button data-course="${i}" class="${selectedCourse === i ? 'selected' : ''}"${selectedCourse === i ? ' aria-current="page"' : ''}><img class="folder-icon" src="/folder-icon.png" alt="" width="16" height="12">${esc(c)}${n ? `<span class="badge">${n}<span class="sr-only">件未提出</span></span>` : ''}</button></li>`;
        })
        .join('')}</ul>`,
      {mark: false, center: true, id: 'dirpanel'}
    )
  );
}
function courseTable() {
  const rows = courses
    .map((c, i) => ({c, i}))
    .filter(({i}) => !removedCourse(i))
    .filter(({c}) => !query || c.toLowerCase().includes(query.trim().toLowerCase()));
  return rows.length
    ? `<table class="table-default"><thead><tr><th scope="col">授業名</th><th scope="col" class="num">課題</th><th scope="col" class="num">未提出</th></tr></thead><tbody>${rows
        .map(({c, i}) => {
          const ts = state.tasks.filter(t => t.course === i);
          return `<tr><td><button class="linklike" data-course="${i}">${esc(c)}</button></td><td class="num">${ts.length}</td><td class="num">${ts.filter(pending).length}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : '<p class="empty">授業がありません</p>';
}
// 削除した授業の一覧（元に戻せる）
function removedCourses() {
  const rows = courses.map((c, i) => ({c, i})).filter(({i}) => removedCourse(i));
  return rows.length
    ? `<details class="removed-courses"><summary>削除した授業（${rows.length}件）</summary><p class="muted" style="margin:8px 0">同期で読まない授業です。元に戻すと、次の同期から課題・資料を集めます。</p>${rows.map(({c, i}) => `<div class="course-edit"><span>${esc(c)}</span><button class="btn btn-sm" id="restorecourse-${i}" data-restorecourse="${i}">元に戻す</button></div>`).join('')}</details>`
    : '';
}
const addCourseForm = () =>
  `<div class="field"><label for="newcourse">授業名</label><div class="inline"><input class="form-control" id="newcourse" placeholder="例：経済原論Ⅱ"><button class="btn btn-primary" id="addcourse">追加</button></div></div>`;
// 設定の「授業の整理」：表示する授業ごとに削除、削除した授業は元に戻す（この端末のアカウントだけに反映）
function courseManager() {
  const shown = courses.map((c, i) => ({c, i})).filter(({i}) => !removedCourse(i));
  return `<p class="muted">削除した授業は同期で読まず、一覧・時間割に出しません。この ${dev()} だけに反映します。</p><ul class="course-manage">${shown.map(({c, i}) => `<li><span>${esc(c)}</span><button class="btn btn-sm" id="removecourse-${i}" data-removecourse="${i}">削除</button></li>`).join('')}</ul>${removedCourses()}`;
}
function settingsConnected() {
  const auto = courses.map((c, i) => ({c, i, w: state.weekdays?.[courseIdOf(i)]})).filter(({i}) => !removedCourse(i)),
    unset = auto.filter(r => !r.w),
    set = auto.filter(r => r.w);
  const dateField = ({c, i, w}) =>
    `<div class="field"><label for="schedule-${i}">${esc(c)} · 第1回${w ? `<span class="muted" style="font-weight:400">（${esc(w)}曜・学年暦から自動設定）</span>` : ''}</label><input class="form-control" style="max-width:200px" type="date" id="schedule-${i}" data-schedule="${i}" value="${esc(state.schedules?.[courseIdOf(i)]?.[1] || '')}"></div>`;
  const pick = state.features?.includes('pickfolder');
  // 認証情報は一度入れたら変えないので、保存済みなら折りたたむ。日常的に触る「自動処理」を先に置く
  const credForm = `<div class="field" style="margin-top:15px"><label for="manabo-id">manabo ID</label><input class="form-control" id="manabo-id" autocomplete="username"></div><div class="field"><label for="manabo-password">パスワード</label><input class="form-control" id="manabo-password" type="password" autocomplete="current-password"><small>この Mac/PC にだけ暗号化して保存します。</small></div><div class="actions"><button class="btn btn-primary" id="savecredentials">認証情報を保存</button><button class="btn" id="verifylogin">接続確認</button></div>`;
  // 認証情報が未設定なら、それが先決なので manabo連携 を先頭に。保存済みなら一番下へ（接続解除と一緒に）
  const credPanel = panel(
    'manabo連携',
    `<table class="table-default"><tr><th>認証情報</th><td>${state.credentialsConfigured ? (state.os === 'win32' ? '暗号化して保存済み' : 'キーチェーン保存済み') : '<span class="attn">未設定</span>'}</td></tr><tr><th>${state.runtime === 'desktop' ? 'アプリのバージョン' : dev() + ' サービスのバージョン'}</th><td>${state.runtime === 'desktop' ? `<code>${esc(state.version || '')}</code> <span class="muted">（アプリは自動で更新を確認します）</span>` : state.version ? `<code>${esc(state.version.slice(0, 7))}</code>${state.deployed ? (macOutdated() ? ` <span class="attn">公開バージョン <code>${esc(state.deployed.slice(0, 7))}</code> への更新待ち</span><small class="muted" style="display:block">${dev()} は処理の合間に自動で更新します。長く変わらないときは ${dev()} でサービスを再起動してください（npm start または install:agent）。</small>` : ' <span class="muted">（公開バージョンと同じ）</span>') : ''}` : '<span class="muted">未確認</span>'}</td></tr></table>${state.credentialsConfigured ? `<details id="cred-details" style="margin-top:15px"><summary>認証情報を変更する</summary>${credForm}</details><div class="actions"><button class="btn" id="logout">この端末の接続を解除</button></div>` : `<p class="muted" style="margin-top:10px">同期・自動回答には manabo の ID とパスワードが必要です。</p>${credForm}`}`
  );
  let html = state.credentialsConfigured ? '' : credPanel;
  // 自動処理は下の「設定を保存」でまとめて保存。ダウンロード先は選ぶとすぐ反映するので別の枠にする
  html += panel(
    '自動処理',
    `<div class="field"><label for="time">実行時刻（日本時間）</label><input class="form-control" style="max-width:160px" type="time" id="time" value="${esc(state.settings?.time || '16:30')}"></div><label class="check"><input type="checkbox" id="autogen" ${state.settings?.autoGenerate !== false ? 'checked' : ''}> レポートなどの回答を自動で作る</label><label class="check"><input type="checkbox" id="classsync" ${state.settings?.classSync !== false ? 'checked' : ''}> 授業の開始時刻に、その授業を同期する（出席コードの入力が出たら、この画面にも出します）</label><div class="field"><label for="campus">キャンパス（授業の開始時刻）</label><select class="form-control" id="campus" style="max-width:200px">${['名古屋', '豊田'].map(c => `<option value="${c}"${(state.settings?.campus || '名古屋') === c ? ' selected' : ''}>${c}（1限 ${c === '豊田' ? '9:30' : '9:00'}〜）</option>`).join('')}</select></div><p class="muted">${state.aiMissing ? `この ${dev()} では SaBoRo課題サポートを使えないため、回答は作りません。` : 'クイズはこの設定にかかわらず常に自動で回答を入力します（提出は本人が manabo で）。'}</p><h3 class="sub">自分について（回答の作成に使います）</h3><p class="muted">当てはまるものを選んでください。</p><div id="pfwrap">${typeof ProfileForm === 'object' ? ProfileForm.profileFormHtml(state.settings?.profileForm) : ''}</div><div class="field"><label for="profile">そのほか自分について（自由記述・任意）</label><textarea class="form-control" id="profile" rows="5" maxlength="2000" placeholder="例：経営学部3年。飲食店のアルバイトを2年続けていて、新人の指導もしている。テニスサークルに所属。将来はマーケティングの仕事に就きたい。">${esc(state.settings?.profile || '')}</textarea><p class="muted">「あなたの考え」「自分の経験を踏まえて」など、自分について聞かれる設問の回答に使います。課題と一緒に、回答を作る AI へ送ります。経験・体験を問う課題では、ここに書いていないことを短い質問でたずねます。</p></div><div class="field"><label for="style">文体（回答をあなたの書き方に近づけます）</label><textarea class="form-control" id="style" rows="4" maxlength="1000" placeholder="過去のレポートから読み取ると入ります。自分で書いてもかまいません。">${esc(state.settings?.style || '')}</textarea><p class="muted">過去のレポートや ChatGPT・Claude の履歴から読み取るには、${dev()} の設定画面の「4. 過去のレポート」で選んでください。${setupLink}</p>${state.profileSuggestion?.text ? `<p class="attn">${esc(state.profileSuggestion.source)} の履歴から読み取った「自分について」の候補があります。${dev()} の設定画面で確かめて足してください。${setupLink}</p>` : state.chatImport ? `<p class="muted">${esc(state.chatImport.source)} の書き出しの zip を待っています（ダウンロードすると ${dev()} が自動で読み取ります）。</p>` : ''}</div><h3 class="sub">授業日（第1回の日付）</h3><p class="muted">曜日が分かる授業は学年暦から自動で設定します。${unset.length ? '曜日が分からない授業だけ入れてください。' : ''}</p>${unset.length ? unset.map(dateField).join('') : '<p class="muted">すべての授業の授業日が設定済みです。</p>'}${set.length ? `<details class="field" id="schedule-details"><summary>自動設定済みの授業（${set.length}件）の第1回を変える</summary><div style="margin-top:10px">${set.map(dateField).join('')}</div></details>` : ''}<div class="actions"><button class="btn btn-primary" id="savesettings">設定を保存</button><span class="muted save-scope">実行時刻・回答の自動作成・授業日を保存します</span></div>`
  );
  html += panel(
    `資料のダウンロード先（${dev()} のフォルダ）`,
    `<p style="margin:0 0 6px;word-break:break-all"><code>${esc(state.settings?.downloadDir || state.defaultDownloadDir || '既定のフォルダ')}</code>${state.settings?.downloadDir ? '' : ' <span class="muted">（既定）</span>'}</p><div class="actions" style="margin-top:0"><button class="btn" id="pickdir"${pick ? '' : ' disabled'}>フォルダを選択…</button>${state.settings?.downloadDir ? '<button class="btn" id="resetdir">既定に戻す</button>' : ''}</div>${pick ? '' : '<div class="alert alert-warning" style="margin-top:8px">' + dev() + ' のアプリを新しいバージョンにすると選べるようになります。</div>'}<small class="muted" style="display:block;margin-top:6px">選ぶとすぐ反映します。${state.os === 'win32' ? '' : '初回は「Finder を制御」の許可で「OK」を押してください。'}</small>`
  );
  if (state.features?.includes('removecourse')) html += panel('授業の整理', courseManager());

  return (
    html + (state.credentialsConfigured ? credPanel : `<button class="btn" id="logout">この端末の接続を解除</button>`)
  );
}
// 資料のリンク：Mac に保存したファイル（ローカルサーバー経由）と manabo の両方。Mac 以外の端末（ローカルサーバーに届かない）では manabo を主にする
const LOCAL = 'http://127.0.0.1:8766';
// エラーの表示は短く：長いもの（古い版のアプリが送る AI の出力の全文など）は最初の文だけにする
const briefError = m => {
  m = String(m || '').trim();
  if (/Timeout \d+ms exceeded/i.test(m))
    return 'manabo の応答がありませんでした（時間切れ）。時間をおいて同期し直してください。';
  if (/net::ERR_|ECONNRESET|ENOTFOUND|EAI_AGAIN/.test(m))
    return 'manabo に接続できませんでした。ネットワークを確かめて同期し直してください。';
  if (m.length <= 120 && !/[{}\[\]]/.test(m)) return m;
  const first = m
    .split(/[。\n]/)[0]
    .replace(/[（(].*$/, '')
    .trim()
    .slice(0, 60);
  return (first || '処理に失敗しました').replace(/[。.]$/, '') + '。';
};
let localOk = null;
const isMac =
  typeof navigator !== 'undefined' && /Macintosh/.test(navigator.userAgent || '') && !(navigator.maxTouchPoints > 1);
// Mac サービスがまだ公開バージョンに追いついていないか（追いつく前は /open がない）
const macOutdated = () =>
  state.runtime !== 'desktop' &&
  !!(
    state.deployed &&
    state.version &&
    !state.deployed.startsWith(state.version) &&
    !state.version.startsWith(state.deployed)
  );
function probeLocal() {
  if (typeof fetch !== 'function' || !key) return;
  fetch(LOCAL + '/ping', {
    mode: 'no-cors',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined
  })
    .then(
      () => {
        localOk = true;
      },
      () => {
        localOk = false;
      }
    )
    .then(() => {
      if (view === 'courses') render();
    });
}
// 資料を回ごとにまとめる（記録の round、なければ名前の「第N回」。どちらもなければ「その他」）
const materialRound = m =>
  Number(m.round) ||
  Number(
    String(m.name || '')
      .normalize('NFKC')
      .match(/第\s*0?(\d+)\s*回/)?.[1] || 0
  );
function materialsByRound(mats) {
  const groups = new Map();
  for (const m of mats) {
    const r = materialRound(m);
    groups.set(r, [...(groups.get(r) || []), m]);
  }
  const rounds = [...groups.keys()].sort((a, b) => (a || 99) - (b || 99));
  if (rounds.length === 1 && rounds[0] === 0) return `<div class="materials">${mats.map(materialLink).join('')}</div>`;
  return rounds
    .map(
      r =>
        `<h3 class="sub" style="margin:8px 0 4px">${r ? `第${r}回` : 'その他'}</h3><div class="materials">${groups
          .get(r)
          .map(materialLink)
          .join('')}</div>`
    )
    .join('');
}
function materialLink(m) {
  const manabo = `<a class="btn btn-sm" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)}</a>`;
  if (!m.sha256) return manabo;
  const local = `${LOCAL}/open?id=${esc(m.sha256)}`;
  return localOk === false && !isMac
    ? `<span class="material">${manabo}<a class="btn btn-sm btn-alt" href="${local}" target="_blank" rel="noopener" aria-label="${esc(m.name)} を ${dev()} で開く">${dev()}</a></span>`
    : `<span class="material"><a class="btn btn-sm" href="${local}" target="_blank" rel="noopener" title="${dev()} に保存したファイルを開く">${esc(m.name)}</a><a class="btn btn-sm btn-alt" href="${esc(m.url)}" target="_blank" rel="noopener" aria-label="${esc(m.name)} を manabo で開く">manabo</a></span>`;
}
// お支払い：管理者が「支払いを必須」にしていて、定期支払いが有効でないときは、作業（同期・回答の作成など）がサーバーで止まる
// その間は設定以外の画面の代わりに支払いの案内を出す。支払いは Stripe（初回の支払い後は解約するまで毎月自動で決済）
const billingBlocked = () => !!(key && state.billing?.required && !state.billing?.allowed);
const jpDate = s => {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};
function billingPanel() {
  const b = state.billing || {},
    price = b.price ? `月額 ${b.price.toLocaleString('ja-JP')}円（税込）` : '月額';
  const again = b.status && ['canceled', 'unpaid', 'incomplete_expired'].includes(b.status);
  return panel(
    'お支払い',
    `<p>${again ? '定期支払いが終了しているため、同期や回答の作成を止めています。' : 'saboro を使い始めるには、お支払いの手続きが必要です。'}</p><p><strong>${price}</strong>・初回のお支払い後は、解約するまで毎月自動で決済されます。</p>
 ${b.checkoutUrl ? `<p><a class="btn btn-primary" href="${esc(b.checkoutUrl)}" target="_blank" rel="noopener">お支払いに進む（Stripe）</a></p><p class="muted">お支払いが済むと、数秒〜1分ほどでこの画面が自動で切り替わります。お支払いの画面は Stripe（決済サービス）が表示します。</p>` : '<div class="alert alert-warning">お支払いの準備がまだできていません。管理者に連絡してください。</div>'}`
  );
}
// 定期支払いが有効なら、プランが「無料」でも契約の状態と解約のリンクを出す（解約できないまま課金が続かないように）
function billingStatusPanel() {
  const b = state.billing || {};
  if (!key || (!b.required && !b.active && !b.exempt)) return '';
  if (billingBlocked()) return billingPanel();
  const text = !b.active
    ? '無料で利用中です。'
    : b.cancelAtPeriodEnd
      ? `解約の手続き済みです。${b.periodEnd ? jpDate(b.periodEnd) + ' まで' : '期間の終わりまで'}使えます。`
      : b.status === 'past_due'
        ? 'お支払いを再試行しています。カードの情報を確認してください。'
        : `定期支払いは有効です。${b.periodEnd ? '次回の決済日：' + jpDate(b.periodEnd) : ''}`;
  return panel(
    'お支払い',
    `<p style="margin:0 0 8px">${esc(text)}</p>${b.portalUrl && b.active ? `<a class="btn" href="${esc(b.portalUrl)}" target="_blank" rel="noopener">解約・カードの変更（Stripe）</a>` : ''}`
  );
}
// SaBoRo の AI：今月の回数・無料分・超過分の使用料と、急ぐ依頼とそれ以外の作り方の違い（どの手段で作ったかは出さない）
function saboroAiPanel() {
  const a = state.ai;
  if (!key || !a || a.reason === 'not_configured') return '';
  const over = a.used >= a.included;
  const why =
    {
      limit: `今月の無料分（${a.included}回）を使い切りました。来月まで SaBoRo課題サポートは使えません。`,
      daily_limit: '今日の上限に達しました。明日また使えます。',
      not_configured: 'SaBoRo課題サポートは準備中です。',
      payment_required: 'お支払いが済むと使えます。'
    }[a.reason] || '';
  return panel(
    'SaBoRo課題サポート',
    `<p style="margin:0 0 6px">今月の課題生成：<strong>${a.used}回</strong>／無料分 ${a.included}回${over && a.overage ? `（${a.included + 1}回目からは使用量に応じた使用料：今月 ${a.overageYen.toLocaleString('ja-JP')}円。月額と一緒に請求します）` : ''}</p>${why ? `<p class="attn" style="margin:0 0 6px">${esc(why)}</p>` : ''}<p class="muted" style="margin:0">画面から頼んだ回答と、締切まで24時間以内の回答はすぐ作ります。それ以外は順番待ちでまとめて作り（通常1時間以内、遅くとも24時間以内）、出来上がったら自動で入力します。${a.overage ? `無料分（${a.included}回）を超えた後は、使った量に応じて使用料がかかります。` : ''}</p>`
  );
}
function render() {
  const n = state.tasks.filter(needs).length;
  document.getElementById('gnav').innerHTML =
    `<ul>${navViews.map(v => `<li><button data-view="${v}" class="${view === v || (v === 'tasks' && view === 'needs') ? 'active' : ''}"${view === v ? ' aria-current="page"' : ''}>${views[v]}${v === 'home' && n ? `<span class="badge">${n}<span class="sr-only">件要対応</span></span>` : ''}</button></li>`).join('')}</ul>`;
  const gnav = document.getElementById('gnav'),
    toggle = document.getElementById('navtoggle');
  gnav.classList[menuOpen ? 'add' : 'remove']('in');
  toggle.setAttribute?.('aria-expanded', String(menuOpen));
  document.getElementById('headeraction').innerHTML = key
    ? '<button class="btn btn-black" id="sync">同期</button>'
    : courses.length
      ? '<button class="btn btn-black" id="addtask">課題を追加</button>'
      : '';
  document.getElementById('mode').textContent = key ? 'manabo連携' : '個人用';
  const macOnline = state.deviceSeen && Date.now() - new Date(state.deviceSeen) < 60000;
  document.getElementById('status').innerHTML = (
    key
      ? [
          `自動確認 ${state.settings?.time || '16:30'}`,
          offline
            ? `<span class="status-alert">${esc(offline)}（15秒ごとに再試行）</span>`
            : !loaded
              ? dev() + ' 確認中…'
              : macOnline
                ? dev() + ' 接続中'
                : state.deviceSeen
                  ? `${dev()} 未接続（最終 ${when(state.deviceSeen)}）`
                  : dev() + ' 未接続',
          state.running
            ? runningText()
            : state.lastSync
              ? `同期 ${when(state.lastSync)}（${ago(state.lastSync)}）`
              : loaded
                ? '同期待ち'
                : '読み込み中…'
        ]
      : ['このブラウザに保存']
  )
    .map(s => `<li>${s.startsWith('<') ? s : esc(s)}</li>`)
    .join('');
  const title = view === 'courses' && selectedCourse !== null ? courses[selectedCourse] : views[view];
  const trail = [['home', 'ホーム']];
  if (view !== 'home') trail.push([view, views[view]]);
  if (view === 'courses' && selectedCourse !== null) trail.push(['', courses[selectedCourse]]);
  document.getElementById('breadcrumb').innerHTML = trail
    .map(([v, l], i) =>
      i === trail.length - 1
        ? `<li class="active" aria-current="page">${esc(l)}</li>`
        : `<li><button class="linklike" data-view="${v}">${esc(l)}</button></li>`
    )
    .join('');
  document.getElementById('pagetitle').textContent = title;
  document.title = `${title} — saboro`;
  document.getElementById('searchbox').hidden = !searchViews.includes(view);
  let html = '';
  if (key && loaded && billingBlocked() && view !== 'settings') html = billingPanel();
  else if (key && !loaded)
    html = panel(
      '読み込み中',
      `<p class="empty">${offline ? esc(offline) + '。15秒ごとに再試行します。' : dev() + ' の記録を読み込んでいます…'}</p>`
    );
  else if (view === 'home') {
    // 概要：未提出の総数と、その内訳（要対応・期限切れ・3日以内は重なることがある）、提出済み
    const stats = [
      ['pending', '未提出', state.tasks.filter(pending).length],
      ['needs', 'うち要対応', n],
      ['overdue', 'うち期限切れ', state.tasks.filter(overdue).length],
      ['soon', 'うち3日以内', state.tasks.filter(soon).length],
      ['done', '提出済み', state.tasks.filter(t => !pending(t)).length]
    ];
    html += promptPanel();
    html += noticePanel();
    html += attentionPanel();
    if (typeof todayPanel === 'function') html += todayPanel();
    html += panel(
      '概要',
      `<div class="stats">${stats.map(([v, l, c]) => `<button class="stat ${['needs', 'overdue'].includes(v) && c ? 'alert-' + v : ''} ${['needs', 'overdue', 'soon'].includes(v) ? 'stat-sub' : ''}" data-stat="${v}" aria-label="${l} ${c}件の一覧"><span class="stat-label">${l}</span><span class="stat-num">${c}<small>件</small></span></button>`).join('')}</div>${key && (state.lastSync || syncTimingText()) ? `<p class="muted" style="margin:8px 0 0">${lastSyncText()}</p>` : ''}`
    );
    if (n) html += panel('要対応', list(state.tasks.filter(needs), false), {flush: true});
    html += panel(
      '未提出の課題',
      list(
        state.tasks.filter(t => pending(t) && !needs(t)),
        false,
        state.tasks.some(t => pending(t) && needs(t))
          ? '未提出の課題は要対応に表示しています'
          : '未提出の課題はありません'
      ),
      {flush: true, tools: '締切順'}
    );
  } else if (view === 'courses') {
    if (selectedCourse !== null && removedCourse(selectedCourse)) selectedCourse = null;
    if (selectedCourse === null) html += panel('授業一覧', courseTable() + removedCourses());
    else {
      html += courseHeader(selectedCourse);
      html += panel(`${esc(courses[selectedCourse])} - 課題一覧`, list(state.tasks), {
        flush: true,
        tools: courseSyncTools(selectedCourse)
      });
      const mats = state.materials.filter(m => m.course === courses[selectedCourse]);
      if (key)
        html += panel(
          `${esc(courses[selectedCourse])} - 資料`,
          mats.length
            ? `${materialsByRound(mats)}<p class="muted" style="margin:10px 0 0">${macOutdated() ? `<span class="attn">${dev()} サービスがまだ新しいバージョン（${esc(state.deployed.slice(0, 7))}）に切り替わっていないため、${dev()} のファイルはまだ開けません。</span> ` : ''}${localOk === false && !isMac ? 'この端末からは manabo で開きます。' + dev() + ' 上のブラウザなら、保存したファイルをそのまま開けます。' : '資料名で ' + dev() + ' に保存したファイルを、「manabo」で manabo 上のファイルを開きます。'}</p>`
            : '<p class="empty">資料はまだ取得されていません</p>'
        );
    }
  } else if (view === 'timetable') html += typeof timetableView === 'function' ? timetableView() : '';
  else if (view === 'attendance') html += typeof attendanceView === 'function' ? attendanceView() : '';
  else if (view === 'tasks') html += panel('課題一覧', list(state.tasks), {flush: true});
  else if (view === 'needs')
    html += panel('要対応', list(state.tasks.filter(needs), false, '対応が必要な課題はありません'), {flush: true});
  else if (!key) {
    html += panel(
      '授業',
      `${addCourseForm()}${courses.length ? `<details id="courses-details"><summary>授業名の変更・削除（${courses.length}件）</summary>${courses.map((c, i) => `<div class="course-edit"><input class="form-control" id="coursename-${i}" value="${esc(c)}" aria-label="授業名（${esc(c)}）"><button class="btn btn-sm" data-rename="${i}">名前を保存</button><button class="btn btn-sm" data-delcourse="${i}">削除</button></div>`).join('')}</details>` : ''}`
    );
    html += panel(
      'データ',
      `<p>データはこのブラウザだけに保存されます。別の端末で使うときや、ブラウザのデータを消す前にバックアップしてください。</p><div class="actions"><button class="btn" id="exportpersonal">バックアップを保存</button><input class="file-input" id="importpersonal" type="file" accept="application/json"><label class="btn" for="importpersonal">バックアップを読み込む</label></div>`
    );
    html += panel(
      'manabo連携',
      `<p>デスクトップアプリ（Mac・Windows）を入れると、manabo の ID とパスワードの保存、SaBoRo課題サポートの確認、接続の 3 手順で同期・課題の自動生成まで動きます。</p><div class="actions"><a class="btn btn-primary" href="https://github.com/Peyangpiece/SaBoRo/releases/latest" target="_blank" rel="noopener">アプリをダウンロード（Mac / Windows）</a></div><details id="link-details" style="margin-top:12px"><summary>すでにこのパソコンでアプリやサービスが動いているとき</summary><a class="btn" href="http://127.0.0.1:8766/setup" target="_blank" rel="noopener">はじめの設定を開く</a><span class="muted">（このパソコン上でだけ開けます）</span></details>`
    );
  } else html += billingStatusPanel() + saboroAiPanel() + settingsConnected();
  // 未接続で授業もないときの最初の画面：manabo との接続を先に案内する（授業を手で追加するのは接続しないときだけ）
  if (!key && !courses.length && view !== 'settings')
    html = `<div class="col-full">${panel('manabo と接続', `<p>manabo と接続すると、授業・課題・締切・資料を自動で集め、課題の自動回答まで動きます。デスクトップアプリ（Mac・Windows）を起動し、「はじめの設定」で manabo の ID とパスワードを保存して「saboroを接続」を押してください。</p><div class="actions"><a class="btn btn-primary" id="connectmanabo" href="${LOCAL}/setup">manabo と接続</a><a class="btn" href="https://github.com/Peyangpiece/SaBoRo/releases/latest" target="_blank" rel="noopener">アプリをダウンロード（Mac / Windows）</a></div><p class="muted" style="margin-top:10px">「manabo と接続」は、アプリが動いているこのパソコンでだけ開けます。まだ入れていなければ、先にアプリをダウンロードしてください。</p><details id="manual-details" style="margin-top:15px"><summary>manabo と接続せずに使う（授業を手で追加する）</summary>${addCourseForm()}</details>`)}</div>`;
  else html = `<div class="col-side${dirOpen ? ' open' : ''}">${directory()}</div><div class="col-main">${html}</div>`;
  // 15秒ごとの再描画で開いた <details> が閉じないよう、開いていたものを覚えて戻す
  const open = [...(document.querySelectorAll('#app details[id][open]') || [])].map(d => d.id);
  document.getElementById('app').innerHTML = html;
  for (const id of open) document.getElementById(id)?.setAttribute?.('open', '');
  bindView();
  applyBusy();
}
function addTaskDrawer() {
  openDrawer(
    '課題を追加',
    `<div class="field"><label for="tasktitle">課題名</label><input class="form-control" id="tasktitle"></div><div class="field"><label for="taskcourse">授業</label><select class="form-control" id="taskcourse">${courses.map((c, i) => (removedCourse(i) ? '' : `<option value="${i}"${selectedCourse === i ? ' selected' : ''}>${esc(c)}</option>`)).join('')}</select></div><div class="field"><label for="tasktype">種類</label><select class="form-control" id="tasktype">${taskTypes.map(v => `<option>${v}</option>`).join('')}</select></div><div class="field"><label for="taskdue">締切</label><input class="form-control" id="taskdue" type="datetime-local"></div><div class="actions"><button class="btn btn-primary" id="createtask">追加</button><button class="btn" id="cancelcreate">キャンセル</button></div>`,
    'tasktitle',
    'new'
  );
  document.getElementById('cancelcreate').onclick = () => close();
  document.getElementById('createtask').onclick = () => {
    const title = document.getElementById('tasktitle').value.trim(),
      due = document.getElementById('taskdue').value;
    if (!title) {
      toast('課題名を入力してください');
      return;
    }
    state.tasks.push({
      id: crypto.randomUUID(),
      title,
      course: +document.getElementById('taskcourse').value,
      dueAt: due ? new Date(due).toISOString() : null,
      status: 'ready',
      type: document.getElementById('tasktype').value || '課題',
      answer: '',
      description: '',
      url: ''
    });
    savePersonal();
    close(true);
    render();
    toast('課題を追加しました');
  };
}
// 第1回の日付から学年暦（なければ毎週）で全回の日付を作る
async function schedulesFromInputs() {
  const schedules = {...state.schedules};
  let rounds = {};
  try {
    rounds = (await academicCalendar()).rounds || {};
  } catch {}
  document.querySelectorAll('[data-schedule]').forEach(e => {
    if (!e.value) return;
    const dates = {},
      term = Object.values(rounds).find(r => r[0] === e.value);
    for (let n = 1; n <= 15; n++) {
      if (term) {
        dates[n] = term[n - 1];
        continue;
      }
      const d = new Date(e.value + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + 7 * (n - 1));
      dates[n] = d.toISOString().slice(0, 10);
    }
    schedules[courseIdOf(+e.dataset.schedule)] = dates;
  });
  return schedules;
}
function bindView() {
  const bind = (id, f) => {
    const e = document.getElementById(id);
    if (e) e.onclick = f;
  };
  bind('addcourse', () => {
    const name = document.getElementById('newcourse').value.trim();
    if (!name) {
      toast('授業名を入力してください');
      return;
    }
    if (courses.includes(name)) {
      toast('登録済みの授業です');
      return;
    }
    courses.push(name);
    savePersonal();
    if (view !== 'settings') view = 'home';
    render();
    toast('授業を追加しました');
  });
  bind('addtask', () => {
    if (!courses.length) {
      go('settings');
      return;
    }
    addTaskDrawer();
  });
  bind('dirtoggle', () => {
    dirOpen = !dirOpen;
    render();
  });
  bind('exportpersonal', () => {
    const a = document.createElement('a'),
      u = URL.createObjectURL(new Blob([JSON.stringify({version: 1, courses, state})], {type: 'application/json'}));
    a.href = u;
    a.download = 'saboro-backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  });
  const importer = document.getElementById('importpersonal');
  if (importer)
    importer.onchange = async () => {
      try {
        const d = JSON.parse(await importer.files[0].text());
        if (
          d.version !== 1 ||
          !Array.isArray(d.courses) ||
          !d.courses.every(c => typeof c === 'string') ||
          !Array.isArray(d.state?.tasks) ||
          !Array.isArray(d.state?.materials) ||
          d.state.tasks.some(
            t =>
              typeof t.id !== 'string' ||
              typeof t.title !== 'string' ||
              !Number.isInteger(t.course) ||
              t.course < 0 ||
              t.course >= d.courses.length
          )
        )
          throw Error();
        if (
          !(await ask(
            'このブラウザのデータをバックアップの内容で置き換えますか？現在のデータは消えます。',
            '置き換える',
            true
          ))
        )
          return;
        courses = d.courses;
        state = d.state;
        selectedCourse = null;
        savePersonal();
        render();
        toast('読み込みました');
      } catch {
        toast('バックアップを確認してください');
      } finally {
        importer.value = '';
      }
    };
  document.querySelectorAll('[data-rename]').forEach(
    e =>
      (e.onclick = () => {
        const i = +e.dataset.rename,
          name = document.getElementById('coursename-' + i).value.trim();
        if (!name) {
          toast('授業名を入力してください');
          return;
        }
        if (courses.some((c, j) => c === name && j !== i)) {
          toast('登録済みの授業です');
          return;
        }
        const old = courses[i];
        for (const k of ['timetable', 'sessions'])
          if (state[k]?.[old]) {
            state[k] = {...state[k], [name]: state[k][old]};
            delete state[k][old];
          }
        courses[i] = name;
        savePersonal();
        render();
        toast('授業名を変更しました');
      })
  );
  document.querySelectorAll('[data-removecourse]').forEach(
    e =>
      (e.onclick = async () => {
        const i = +e.dataset.removecourse,
          name = courses[i],
          count = state.tasks.filter(t => t.course === i).length;
        if (
          !(await ask(
            `「${name}」を削除しますか？今後この授業の課題・資料は manabo から集めません${count ? `（課題 ${count} 件も一覧から外します）` : ''}。ダウンロード済みの資料はフォルダに残ります。この ${dev()} だけに反映し、設定の「授業の整理」から元に戻せます。`,
            '削除',
            true
          ))
        )
          return;
        await job('settings', null, {removeCourse: name}, e.id);
      })
  );
  document
    .querySelectorAll('[data-restorecourse]')
    .forEach(e => (e.onclick = () => job('settings', null, {restoreCourse: courses[+e.dataset.restorecourse]}, e.id)));
  document.querySelectorAll('[data-delcourse]').forEach(
    e =>
      (e.onclick = async () => {
        const i = +e.dataset.delcourse,
          count = state.tasks.filter(t => t.course === i).length;
        if (
          !(await ask(
            `「${courses[i]}」${count ? `と課題${count}件` : ''}を削除しますか？元に戻せません。`,
            '削除',
            true
          ))
        )
          return;
        state.tasks = state.tasks
          .filter(t => t.course !== i)
          .map(t => (t.course > i ? {...t, course: t.course - 1} : t));
        for (const k of ['timetable', 'sessions']) if (state[k]) delete state[k][courses[i]];
        courses.splice(i, 1);
        selectedCourse = null;
        savePersonal();
        render();
        toast('授業を削除しました');
      })
  );
  bind('sync', () => job('sync'));
  bind('synccourse', () => {
    if (selectedCourse !== null) job('sync', null, {course: courses[selectedCourse]}, 'synccourse');
  });
  bind('verifylogin', () => job('verify'));
  bind('savecredentials', async () => {
    const username = document.getElementById('manabo-id').value.trim(),
      password = document.getElementById('manabo-password').value;
    if (!username || !password) {
      toast('ID・パスワードを入力してください');
      return;
    }
    if (!state.credentialPublicKey) {
      toast(dev() + ' の接続を確認してください');
      return;
    }
    try {
      const {encryptCredentials} = await import('./credentials.js');
      const payload = await encryptCredentials(state.credentialPublicKey, username, password);
      await api('/api/jobs', 'POST', {kind: 'credentials', payload});
      document.getElementById('manabo-password').value = '';
      toast('保存を予約しました。' + dev() + ' で処理します。');
    } catch {
      toast('保存できませんでした');
    }
  });
  bind('logout', async () => {
    if (
      !(await ask(
        'この端末と' + dev() + ' の接続を解除しますか？再接続には' + dev() + ' の設定画面が必要です。',
        '解除する',
        true
      ))
    )
      return;
    key = '';
    localStorage.removeItem('coursecue-owner');
    courses = guestData?.courses || [];
    state = guestData?.state || emptyState();
    loaded = true;
    offline = '';
    view = 'home';
    selectedCourse = null;
    pushRoute(true);
    render();
  });
  // 実行時刻・自動生成・授業日を一度に保存する（ダウンロード先は別：押した時点で反映）
  bind('savesettings', async () => {
    const schedules = await schedulesFromInputs();
    job('settings', null, {
      time: document.getElementById('time').value,
      autoGenerate: document.getElementById('autogen').checked,
      classSync: !!document.getElementById('classsync')?.checked,
      campus: document.getElementById('campus')?.value || '名古屋',
      schedules,
      ...(document.getElementById('profile') ? {profile: document.getElementById('profile').value} : {}),
      ...(typeof ProfileForm === 'object' && document.getElementById('pfwrap')
        ? {profileForm: ProfileForm.readProfileForm(document.getElementById('pfwrap'))}
        : {}),
      ...(document.getElementById('style') ? {style: document.getElementById('style').value} : {})
    });
  });
  bind('pickdir', () => job('settings', null, {pickDownloadDir: true}, 'pickdir'));
  bind('resetdir', async () => {
    if (await ask('資料のダウンロード先を既定のフォルダに戻しますか？', '戻す'))
      job('settings', null, {downloadDir: ''}, 'resetdir');
  });
  document
    .querySelectorAll('[data-stat]')
    .forEach(
      e =>
        (e.onclick = () =>
          go(e.dataset.stat === 'needs' ? 'needs' : 'tasks', null, e.dataset.stat === 'needs' ? 'all' : e.dataset.stat))
    );
  document.querySelectorAll('[data-prompt]').forEach(e => (e.onclick = () => showPrompts(e.dataset.prompt)));
  document.querySelectorAll('[data-seen]').forEach(e => (e.onclick = () => job('seen', null, {all: true})));
  document.querySelectorAll('[data-filter]').forEach(
    e =>
      (e.onclick = () => {
        filter = e.dataset.filter;
        pushRoute(true);
        render();
      })
  );
  bind('trashseen', e => {
    try {
      localStorage.setItem('coursecue-trash-seen', e.currentTarget.dataset.at);
    } catch {}
    render();
  });
  document.querySelectorAll('[data-view]').forEach(e => (e.onclick = () => go(e.dataset.view)));
  document.querySelectorAll('[data-course]').forEach(e => (e.onclick = () => go('courses', +e.dataset.course)));
  document.querySelectorAll('[data-task]').forEach(e => (e.onclick = () => detail(e.dataset.task)));
  if (typeof bindTimetable === 'function') bindTimetable();
}
function detail(id) {
  const t = state.tasks.find(t => t.id === id);
  if (!t) return;
  const [label, cl] = statuses[t.status] || ['未確認', 'ready'];
  const quiz = t.type === 'クイズ';
  let body = `<p class="drawer-label">${esc(courses[t.course] ?? '授業未設定')} · ${round(t)} · ${esc(t.type || '課題')}</p><span class="label ${cl}">${label}</span><table class="table-default"><tr><th>締切</th><td>${t.dueAt ? `${when(t.dueAt)}${pending(t) ? ` <span class="deadline ${overdue(t) ? 'overdue' : ''}">（${remaining(t)}）</span>` : ''}` : noDue()}${key && t.deadlineText && !t.deadlineText.startsWith('（') ? `<small class="muted" style="display:block">${/^(資料|課題ページ|注意点)/.test(t.deadlineText) ? '' : 'manabo の表示：'}${esc(t.deadlineText)}</small>` : ''}</td></tr>${key ? `<tr><th>最終確認</th><td>${when(t.checkedAt)}</td></tr>` : ''}${t.action ? `<tr><th>次の対応</th><td>${esc(t.action)}</td></tr>` : ''}</table>`;
  // 設問 → 根拠 → 回答 の順。課題名などの編集・補足は普段使わないので折りたたみ、ボタンは下に固定する
  body += `<h3>設問</h3>${t.description ? `<p class="question">${esc(t.description)}</p>` : `<p class="muted">${key ? '設問はまだ取得されていません。同期すると表示されます。' : '設問は登録されていません。'}</p>`}`;
  if (key) {
    const evidence = t.generation?.answers
      ?.map(a => a.evidence)
      .filter(Boolean)
      .join('\n\n');
    body += `<details class="drawer-section"${evidence ? ' open' : ''}><summary>根拠${evidence ? '' : '（未生成）'}</summary><p class="evidence">${esc(evidence || '未生成。「課題を生成」で資料から作ります。')}</p></details>`;
  }
  if (key) {
    const notes = [...(t.generation?.notes || []), ...(t.generation?.needsUser || [])];
    if (notes.length)
      body += `<details class="drawer-section" open><summary>注意点 <span class="label wait">${notes.length}</span></summary><ul class="notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul><small class="muted" style="display:block;margin-top:5px">回答本文には含めていません。提出前に確認してください。</small></details>`;
  }
  if (key && t.candidates?.length)
    body += `<details class="drawer-section" open><summary>manabo の課題と対応づける <span class="label wait">要選択</span></summary><p class="muted" style="margin:8px 0">同じ回に課題が複数あり、どれがこの課題か特定できませんでした。選ぶと次の同期から締切・提出状況を確認します。</p><div class="field"><label for="linkcandidate">manabo の課題</label><select class="form-control" id="linkcandidate">${t.candidates.map(c => `<option value="${esc(c.url)}">${esc(c.title)}</option>`).join('')}</select></div><div class="actions" style="margin-top:0"><button class="btn btn-primary" id="linktask">この課題に対応づける</button></div></details>`;
  body += `<h3><label for="answer">回答・下書き</label></h3><textarea class="form-control" id="answer">${esc(t.answer)}</textarea>`;
  if (key)
    body += `<details class="drawer-section"${t.status === 'wait' || t.supplement ? ' open' : ''}><summary><label for="supplement">本人の経験・補足</label>${t.status === 'wait' ? ' <span class="label wait">要入力</span>' : ''}</summary><textarea class="form-control" id="supplement">${esc(t.supplement || '')}</textarea><small class="muted" style="display:block;margin-top:5px">資料だけで書けない内容（自分の経験など）を書くと、生成に反映します。</small></details>${t.status === 'code' && !state.features?.includes('attendance') ? '<p class="muted">出席コードはアプリ（Mac/PC）を新しいバージョンにすると、ここから入れて提出できます。いまは「待機中のブラウザ」で入れてください。</p>' : ''}${aiRule(t).forbidden ? aiNotice(aiRule(t), quiz) : ''}${t.status === 'code' && state.features?.includes('attendance') && !aiRule(t).forbidden ? `<div class="drawer-section" id="attendance"><div class="field"><label for="attcode">出席コード</label><div class="course-edit"><input class="form-control" id="attcode" inputmode="numeric" autocomplete="off" placeholder="授業で示された出席コード"><button class="btn btn-primary" id="attsubmit">出席コードを入れて提出</button></div><small>出席コード以外の回答は入力済みです。出席コードを選び、入力済みの回答と一緒に manabo に提出します。</small></div></div>` : ''}${personalSection(t)}<div class="actions sticky">${personalTask(t) ? '<button class="btn btn-primary" id="personalask">質問に答えて生成</button>' : `<button class="btn btn-primary" id="generate">${quiz ? '回答開始・自動回答' : '課題を生成'}</button>`}${advancedLeft(t) ? `<button class="btn" id="advanced">高度な生成を使う（${t.advancedOffer.used}/${t.advancedOffer.limit}）</button>` : ''}<button class="btn" id="save">保存</button>${t.url ? `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">manaboで開く</a>` : ''}${['code', 'answered'].includes(t.status) || (quiz && t.generation) ? '<a class="btn" href="http://127.0.0.1:8766/browser" target="_blank" rel="noopener">待機中のブラウザ</a>' : ''}<button class="btn" id="download">ダウンロード</button>${!['done', 'code', 'unknown', 'answered'].includes(t.status) && !quiz && !aiRule(t).forbidden ? '<button class="btn btn-danger submit-btn" id="submit" title="提出すると取り消せません">manaboに提出…</button>' : ''}</div>`;
  else
    body += `<details class="drawer-section"><summary>課題情報を変更する</summary><div class="field"><label for="edit-title">課題名</label><input class="form-control" id="edit-title" value="${esc(t.title)}"></div><div class="field"><label for="edit-course">授業</label><select class="form-control" id="edit-course">${courses.map((c, i) => (removedCourse(i) && i !== t.course ? '' : `<option value="${i}"${i === t.course ? ' selected' : ''}>${esc(c)}</option>`)).join('')}</select></div><div class="field"><label for="edit-type">種類</label><select class="form-control" id="edit-type">${[...new Set([...taskTypes, t.type || '課題'])].map(v => `<option${v === (t.type || '課題') ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div><div class="field"><label for="edit-due">締切</label><input class="form-control" id="edit-due" type="datetime-local" value="${localInput(t.dueAt)}"></div></details><div class="actions sticky"><button class="btn btn-primary" id="save">保存</button><button class="btn" id="togglestatus">${pending(t) ? '提出済みにする' : '未提出に戻す'}</button><button class="btn" id="download">ダウンロード</button><button class="btn" id="deletetask">削除</button></div><p class="muted" style="margin-top:10px">自動回答・課題生成はmanabo連携時に利用できます。</p>`;
  openDrawer(t.title, body, undefined, 'task:' + id);
  const val = i => document.getElementById(i).value;
  document.getElementById('download').onclick = () => {
    const url = URL.createObjectURL(new Blob([val('answer')], {type: 'text/markdown'})),
      a = document.createElement('a');
    a.href = url;
    a.download = `${t.round ? '第' + t.round + '回_' : ''}${t.title}_下書き.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (key) {
    const link = document.getElementById('linktask');
    if (link)
      link.onclick = async () => {
        await job('link', id, {url: val('linkcandidate')});
        closeNow();
        render();
      };
    const save = async () => {
      await job('supplement', id, {text: val('supplement'), answer: val('answer')});
      dirty = false;
    };
    document.getElementById('save').onclick = save;
    const replaceOk = async () => {
      const draft = (document.getElementById('answer')?.value ?? t.answer ?? '').trim();
      return !draft || (await ask('今の回答・下書きを、新しく作る回答で置き換えます。よろしいですか？', '作り直す'));
    };
    const gen = document.getElementById('generate');
    if (gen)
      gen.onclick = async () => {
        if (!(await replaceOk())) return;
        await save();
        await job('generate', id);
      };
    const pask = document.getElementById('personalask');
    if (pask)
      pask.onclick = async () => {
        await save();
        await job('generate', id, {personal: 'ask'}, 'personalask');
      };
    const psend = document.getElementById('personalsend');
    if (psend)
      psend.onclick = async () => {
        const answers = (t.personalQuestions || []).map((q, i) => {
          const picked = document.querySelector(`input[name="pq${i}"]:checked`)?.value || '',
            typed = (document.getElementById(`pqx${i}`)?.value || '').trim();
          return {text: q.text, answer: [picked, typed].filter(Boolean).join('、')};
        });
        if (!answers.some(a => a.answer)) {
          toast('質問に1つ以上答えてください');
          return;
        }
        if (!(await replaceOk())) return;
        await save();
        await job(
          'generate',
          id,
          {personal: 'answers', answers, saveProfile: !!document.getElementById('pqsave')?.checked},
          'personalsend'
        );
      };
    const adv = document.getElementById('advanced');
    if (adv)
      adv.onclick = async () => {
        const a = t.advancedOffer;
        if (
          !(await ask(
            `出力の上限を広げて作り直します。高度な生成は月 ${a.limit} 回までで、今月は ${a.used} 回使っています。使いますか？`,
            '使う'
          ))
        )
          return;
        await save();
        await job('generate', id, {advanced: true}, 'advanced');
      };
    const att = document.getElementById('attsubmit');
    if (att)
      att.onclick = async () => {
        const code = document.getElementById('attcode').value.trim();
        if (!code) {
          toast('出席コードを入れてください');
          return;
        }
        if (await ask(`出席コード「${esc(code)}」と入力済みの回答で提出しますか？提出後は取り消せません。`, '提出する'))
          job('attendance', id, {code}, 'attsubmit');
      };
    const sub = document.getElementById('submit');
    if (sub)
      sub.onclick = async () => {
        if (await ask('この課題をmanaboに提出しますか？提出後は取り消せません。', '提出する')) job('submit', id);
      };
    return;
  }
  document.getElementById('save').onclick = () => {
    const title = val('edit-title').trim();
    if (!title) {
      toast('課題名を入力してください');
      return;
    }
    const due = val('edit-due');
    Object.assign(t, {
      title,
      course: +val('edit-course'),
      type: val('edit-type'),
      dueAt: due ? new Date(due).toISOString() : null,
      answer: val('answer')
    });
    savePersonal();
    render();
    detail(id);
    toast('保存しました');
  };
  document.getElementById('togglestatus').onclick = () => {
    if (pending(t)) {
      t.status = 'done';
      t.submittedAt = new Date().toISOString();
      toast('提出済みにしました');
    } else {
      t.status = t.answer ? 'draft' : 'ready';
      delete t.submittedAt;
      toast('未提出に戻しました');
    }
    savePersonal();
    render();
    detail(id);
  };
  document.getElementById('deletetask').onclick = async () => {
    if (!(await ask(`「${t.title}」を削除しますか？元に戻せません。`, '削除', true))) return;
    state.tasks = state.tasks.filter(x => x.id !== id);
    savePersonal();
    close(true);
    render();
    toast('課題を削除しました');
  };
}
document.getElementById('searchicon').innerHTML = ic('search');
document.getElementById('search').oninput = e => {
  query = e.target.value;
  render();
};
document.getElementById('overlay').onclick = e => {
  if (e.target.id === 'overlay') close();
};
document.getElementById('navtoggle').onclick = () => {
  menuOpen = !menuOpen;
  render();
};
// キー操作：Esc で閉じる、/ で検索、Ctrl/⌘+S でドロワーの保存、Tab はドロワー・ダイアログ内で循環
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (dialogDone) dialogDone(false);
    else close();
    return;
  }
  const typing = document.activeElement?.matches?.('input,textarea,select');
  const drawerOpen = document.getElementById('overlay').classList.contains('open');
  if (e.key === '/' && !typing && !drawerOpen && !dialogDone && !document.getElementById('searchbox').hidden) {
    e.preventDefault();
    document.getElementById('search').focus();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && drawerOpen && !dialogDone) {
    const b = ['save', 'ss-save', 'cc-save', 'createtask'].map(id => document.getElementById(id)).find(Boolean);
    if (b) {
      e.preventDefault();
      b.click();
    }
    return;
  }
  if (e.key !== 'Tab') return;
  const box = dialogDone
    ? document.getElementById('dialog')
    : document.getElementById('overlay').classList.contains('open')
      ? document.getElementById('drawer')
      : null;
  if (!box) return;
  const es = [...box.querySelectorAll('button:not(:disabled),a[href],input:not(.file-input),select,textarea,summary')],
    first = es[0],
    last = es.at(-1);
  if (!first) return;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});
// 戻る・進む：履歴の画面を描き直し、ドロワーは履歴に合わせて開閉する
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
  window.addEventListener('popstate', () => {
    const d = readRoute();
    restoring = true;
    try {
      if (d) {
        if (loaded) openRoute(d);
        else pendingDrawer = d;
      } else closeNow();
    } finally {
      restoring = false;
    }
    render();
  });
// 接続用リンク（#connect=）：このパソコンの saboro から開いたものか確かめてから切り替える。他人のリンクで接続先を切り替えられると、manabo のパスワードをその人の鍵で暗号化して渡してしまうため
// このパソコンの saboro が同じ鍵を持っていれば（鍵のハッシュを渡して画像が返れば）そのまま切り替え、確かめられなければ（別のパソコン・ブラウザの制限など）確認を出す
function ownedLocally(candidate) {
  return new Promise(resolve => {
    if (typeof Image !== 'function' || !globalThis.crypto?.subtle) return resolve(false);
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(candidate)).then(
      b => {
        const h = [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''),
          img = new Image(),
          timer = setTimeout(() => resolve(false), 2000);
        img.onload = () => {
          clearTimeout(timer);
          resolve(true);
        };
        img.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
        img.src = LOCAL + '/owned?h=' + h;
      },
      () => resolve(false)
    );
  });
}
async function connectFrom(candidate) {
  if (!candidate || candidate === key) return;
  if (
    !(await ownedLocally(candidate)) &&
    !(await ask(
      '別の接続先に切り替えようとしています。自分のパソコンの saboro の「saboroを接続」から開いた場合だけ「接続する」を押してください。他の人から送られたリンクなら切り替えないでください（manabo のパスワードを他人に渡してしまうおそれがあります）。',
      '接続する',
      true
    ))
  )
    return;
  courses = ownerCourses;
  state = emptyState();
  key = candidate;
  loaded = false;
  localStorage.setItem('coursecue-owner', key);
  render();
  load();
  probeLocal();
}
const fragment = new URLSearchParams(location.hash.slice(1)),
  connectKey = fragment.get('connect');
if (connectKey !== null) history.replaceState(null, '', location.pathname);
pendingDrawer = readRoute();
pushRoute(true);
render();
load();
probeLocal();
setInterval(load, 15000);
// 学期の表示は学年暦（管理者画面で更新したもの）から入れる
if (typeof fetch === 'function')
  academicCalendar()
    .then(c => {
      const el = document.getElementById('term');
      if (el && c?.term) el.textContent = c.term;
    })
    .catch(() => {});
setTimeout(restoreDrawer, 0);
connectFrom(connectKey);
