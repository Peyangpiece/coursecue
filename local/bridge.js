import {
  checkDownloadDir,
  pickFolder,
  openableMaterial,
  defaultDownloadRoot,
  desktopDir,
  adoptMaterialsRoot
} from './download-dir.js';
import {dueClassSyncs, CAMPUSES} from './schedule.js';
import {mergeTasks} from './task-identity.js';
import {dropSpareTasks} from './content-resolution.js';
import {updateToDeployed, shouldUpdate} from './auto-update.js';
import {createCredentialKey, decryptCredentials} from './credential-envelope.js';
import {platform} from './platform.js';
import {stateFile} from './state-file.js';
// 画面に出す端末の呼び名（Windows は PC）
const deviceName = platform.name === 'win32' ? 'PC' : 'Mac';
import '../dist/profile-form.js';
import http from 'node:http';
import {homedir} from 'node:os';
import {findExportZip, readExport, selectStudy} from './chat-import.js';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {createHash, timingSafeEqual} from 'node:crypto';
import {Manabo} from './manabo.js';
import QRCode from 'qrcode';
import {LEGACY_COURSES, courseNames, courseIdOf, contentType, removeCourse, restoreCourse} from './core.js';
import {requestAllowed} from './local-server.js';
import {
  createGenerator,
  createCourseInfoExtractor,
  createPersonalQuestioner,
  createStyleLearner,
  createChatProfiler,
  detectProviders
} from './generate.js';
import {refreshCalendar, calendar} from './calendar.js';
import {usageLog, addUsage} from './usage.js';
import {applyTimetablePatch} from './timetable.js';
const repo = dirname(dirname(fileURLToPath(import.meta.url))),
  root = process.env.COURSECUE_ROOT || dirname(repo),
  work = process.env.COURSECUE_WORK || join(root, 'tmp/coursecue');
// 資料の置き場所の既定：デスクトップの「<西暦>_<学期名>」（学年暦の学期から。学期が変わると新しいフォルダ）。COURSECUE_ROOT で固定もできる
const materialsRoot = () =>
  process.env.COURSECUE_ROOT || defaultDownloadRoot({desktop: desktopDir(), term: calendar.term});
await mkdir(work, {recursive: true, mode: 0o700});
export const keychain = (op, name, value) =>
  op === 'get' ? platform.secrets.get(name) : platform.secrets.set(name, value);
const savedCredentials = () => {
  try {
    const c = JSON.parse(keychain('get', 'manabo') || 'null');
    return c && typeof c === 'object' ? c : null;
  } catch {
    return null;
  }
};
let owner = keychain('get', 'owner'),
  device = keychain('get', 'device');
if (!owner || !device) {
  if (!platform.register) throw Error('npm run setup を実行してください');
  const made = await platform.register();
  owner = made.owner;
  device = made.device;
}
const stateStore = stateFile(join(work, 'state.json'));
let state = await stateStore.load();
if (!state) {
  state = {
    courses: [],
    tasks: [],
    materials: [],
    schedules: {},
    connection: 'credentials_required',
    settings: {time: '16:30', autoGenerate: true},
    issues: []
  };
}
const merged = mergeTasks(state.tasks);
if (merged.archived.length) {
  await writeFile(join(work, 'tasks-before-dedup-' + Date.now() + '.json'), JSON.stringify(state.tasks, null, 2), {
    mode: 0o600
  });
  state.tasks = merged.tasks;
  state.duplicateArchive = [...(state.duplicateArchive || []), ...merged.archived].slice(-100);
}
// 期限後提出用などの予備の提出先から作った課題は、起動時にも外す（記録は spareArchive に残す）
const spare = dropSpareTasks(state.tasks);
if (spare.archived.length) {
  state.tasks = spare.tasks;
  state.spareArchive = [...(state.spareArchive || []), ...spare.archived].slice(-100);
}
let credentialKey = keychain('get', 'credential-envelope');
if (!credentialKey) {
  credentialKey = JSON.stringify(createCredentialKey());
  if (keychain('set', 'credential-envelope', credentialKey) === null) throw Error('暗号鍵を保存できません');
}
credentialKey = JSON.parse(credentialKey);
const apiBase = process.env.COURSECUE_API || 'https://coursecue.hrk-6888.workers.dev';
let deployedSha = '',
  deployedSig = '',
  lastUpdateTry = 0;
// クラウドの応答の状態ごとの理由（画面の「要対応」に出る。原因が分かるように）
const API_ERRORS = {
  401: 'クラウドに接続できません（この PC の鍵が登録されていません。はじめの設定をやり直してください）',
  402: 'お支払いが必要です',
  413: '状態が大きすぎてクラウドに保存できません（2 MB まで。終わった課題を減らしてください）',
  429: 'クラウドが混み合っています',
  500: 'クラウドで処理に失敗しました'
};
async function api(path, method = 'GET', body) {
  const r = await fetch(apiBase + path, {
    method,
    headers: {Authorization: 'Bearer ' + device, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!r.ok) throw Error(API_ERRORS[r.status] || `クラウド接続に失敗（${r.status}）`);
  const d = r.headers.get('x-coursecue-deployed');
  if (d) deployedSha = d;
  const sg = r.headers.get('x-coursecue-deployed-sig');
  if (sg) deployedSig = sg;
  const b = r.headers.get('x-coursecue-billing');
  if (b) state.billingBlocked = b === 'required';
  return r.json();
}
async function save() {
  await stateStore.save(state);
  await api('/api/state', 'POST', {
    ...state,
    credentialPublicKey: credentialKey.publicKey,
    deviceSeen: new Date().toISOString(),
    credentialsConfigured: !!keychain('get', 'manabo'),
    tasks: state.tasks.map(({draftPath, submissionIntent, generation, ...t}) => ({
      ...t,
      generation,
      submissionIntent: !!submissionIntent,
      hasDraft: !!draftPath
    })),
    materials: state.materials.map(({path, ...m}) => m)
  });
}
if (!state.courses) state.courses = LEGACY_COURSES.map(([name, id]) => ({name, id}));
// 既定の保存先が変わっても、以前の場所に保存した資料を使い続ける（保存先を選んでいない人だけ、一度だけ）
if (!state.settings?.downloadDir && !state.rootAdopted) {
  const adopted = adoptMaterialsRoot(state.materials, {defaultRoot: materialsRoot()});
  if (adopted) {
    state.settings = {...state.settings, downloadDir: adopted};
    console.error('saboro: 以前の資料の保存先を使います', adopted);
  }
  state.rootAdopted = true;
}
state.defaultDownloadDir = materialsRoot();
state.features = ['pickfolder', 'attendance', 'removecourse', 'aipolicy', 'attcheck']; // AI の使用量：1 回ごとに usage.jsonl に追記し、月ごとの集計を状態に持つ（画面に出す。料金を決めるための実測用）
const usageFile = usageLog(join(work, 'usage.jsonl'));
async function recordUsage(e) {
  state.usage = addUsage(state.usage, e);
  await usageFile.record(e).catch(err => console.error('saboro: 使用量を記録できません', err.message));
}
const lms = new Manabo({
  root: materialsRoot,
  work,
  state,
  save,
  trash: platform.trash,
  quarantine: platform.quarantine,
  notify: platform.notify || null,
  credentials: async () => {
    const s = keychain('get', 'manabo');
    return s ? JSON.parse(s) : null;
  },
  ai: createGenerator({onUsage: recordUsage, saboro}),
  extract: createCourseInfoExtractor({onUsage: recordUsage, saboro}),
  ask: createPersonalQuestioner({onUsage: recordUsage, saboro})
});
let running = false,
  lastDay = '',
  lastAiCheck = 0,
  aiReady = [];
// この端末で AI（Codex・Claude Code・SaBoRo の AI）を使えるか。使えなければ同期で回答の作成と授業情報の読み取りを省き、画面に 1 か所だけ案内を出す（state.aiMissing）
async function checkAi() {
  try {
    const d = await detectProviders();
    const cloud = await api('/api/agent/ai')
      .then(r => !!r?.available)
      .catch(() => false);
    const ok = !!(d.codex || d.claude || cloud);
    lms.aiAvailable = ok;
    if (ok) delete state.aiMissing;
    else state.aiMissing = true;
  } catch {
    lms.aiAvailable = undefined;
  }
}
// SaBoRo の AI（こちらの API キーでクラウドが作る）。応答が数分かかっても、クラウドが空白を送り続けるので接続は切れない
async function saboro(body) {
  const r = await fetch(apiBase + '/api/agent/ai', {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + device, 'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw Error('SaBoRo課題サポートに接続できません');
  }
}
// SaBoRo の AI の Batch を待っている課題と授業情報：10 分ごとに出来上がったかを確かめ、出来上がったものから 1 件ずつ受け取る（課題は回答の入力をやり直す）
async function aiResume() {
  const waiting = state.tasks.filter(t => t.aiPending && t.status !== 'done'),
    infos = Object.entries(state.courseInfo || {}).filter(([, v]) => v?.pending);
  if (!waiting.length && !infos.length) {
    aiReady = [];
    return false;
  }
  if (!aiReady.length && Date.now() - lastAiCheck >= 10 * 60 * 1000) {
    lastAiCheck = Date.now();
    const {ready = []} = await api('/api/agent/ai/ready', 'POST', {
      keys: [...new Set([...waiting.map(t => t.aiPending), ...infos.map(([, v]) => v.pending)])]
    });
    aiReady = [
      ...infos.filter(([, v]) => ready.includes(v.pending)).map(([course]) => ({course})),
      ...waiting.filter(t => ready.includes(t.aiPending)).map(t => t.id)
    ];
  }
  const id = aiReady.shift();
  if (id?.course) {
    if (running) return false;
    running = true;
    try {
      await lms.resumeCourseInfo(id.course);
    } catch (e) {
      console.error('saboro: 授業情報を読み取れません', e.message);
    } finally {
      running = false;
    }
    await save();
    return true;
  }
  const t = id && state.tasks.find(x => x.id === id && x.aiPending);
  if (!t) return false;
  try {
    await run({kind: 'generate', task: t.id, auto: true});
  } catch (e) {
    delete t.aiPending;
    t.action = `回答を作成できませんでした（${e.message}）`;
    await save();
  }
  return true;
}
// 本文を読む（上限を超えたら止める）
async function readLimited(req, max) {
  let b = '';
  for await (const c of req) {
    b += c;
    if (b.length > max) throw Error('入力が大きすぎます');
  }
  return b;
}
// 過去のレポート（最初の設定・設定画面から。最大 3 本、1 本 8 MB まで）：パソコンの中で本文を取り出し、AI に文体と「自分について」の候補を読み取らせる。ファイルは読み終えたら消す
const REPORT_BODY_MAX = 35e6,
  REPORT_TYPES = /\.(docx|pdf|txt|md)$/i,
  learnStyle = createStyleLearner({onUsage: recordUsage, saboro});
async function learnFromReports(files) {
  if (!Array.isArray(files) || !files.length || files.length > 3) throw Error('レポートは 1〜3 本選んでください');
  const dir = join(work, 'reports-tmp');
  await mkdir(dir, {recursive: true, mode: 0o700});
  const reports = [];
  try {
    for (const [i, f] of files.entries()) {
      const name = String(f?.name || '')
        .replace(/[\\/]/g, '_')
        .slice(0, 120);
      if (!REPORT_TYPES.test(name)) throw Error('Word（.docx）・PDF・テキストを選んでください');
      const data = Buffer.from(String(f.data || ''), 'base64');
      if (!data.length || data.length > 8e6) throw Error('1 本 8 MB までにしてください');
      const path = join(dir, `${i}-${name}`);
      await writeFile(path, data, {mode: 0o600});
      const text = (await lms.textOf(path)).replace(/\s+\n/g, '\n').trim().slice(0, 15000);
      await rm(path, {force: true});
      if (text) reports.push({file: name, text});
    }
  } finally {
    await rm(dir, {recursive: true, force: true}).catch(() => {});
  }
  if (!reports.length) throw Error('レポートの文字を読み取れませんでした');
  return learnStyle(reports, {profile: state.settings?.profile || ''});
}
// ChatGPT・Claude の書き出しの取り込み：本人が「取り込む」を押してから 3 時間、「ダウンロード」フォルダを 15 秒ごとに見て、書き出しの zip が入ったら読む。
// 学業に関係する本人のメッセージだけを AI に送り、「自分について」の候補（state.profileSuggestion）にする。本人が確かめて足す。zip は消さない
const CHAT_SOURCES = {
    chatgpt: {name: 'ChatGPT', url: 'https://chatgpt.com/'},
    claude: {name: 'Claude', url: 'https://claude.ai/'}
  },
  CHAT_WAIT = 3 * 3600e3,
  profileFromChats = createChatProfiler({onUsage: recordUsage, saboro});
let chatBusy = false;
export async function checkChatImport(now = Date.now(), dir = join(homedir(), 'Downloads')) {
  const job = state.chatImport;
  if (!job || chatBusy || job.status === 'failed') return; // 失敗したら繰り返さない（同じ zip で AI を何度も使わない）。本人がもう一度「取り込む」を押せばやり直す
  if (now > job.until) {
    delete state.chatImport;
    await save().catch(() => {});
    return;
  }
  const path = await findExportZip(dir, job.since, now);
  if (!path) return;
  chatBusy = true;
  try {
    state.chatImport = {...job, status: 'reading'};
    await save().catch(() => {});
    const {source, conversations} = readExport(path);
    const chats = selectStudy(conversations);
    if (!chats.length) {
      state.profileSuggestion = {
        source,
        text: '',
        count: 0,
        at: new Date().toISOString(),
        message: '学業に関係する会話が見つかりませんでした'
      };
      delete state.chatImport;
    } else {
      const r = await profileFromChats(chats, {profile: state.settings?.profile || ''});
      state.profileSuggestion = {source, text: r.profile, count: chats.length, at: new Date().toISOString()};
      delete state.chatImport;
    }
  } catch (e) {
    state.chatImport = {...job, status: 'failed', error: String(e.message).slice(0, 200)};
  } finally {
    chatBusy = false;
    await save().catch(() => {});
  }
}
// 経験・体験を問う課題の作り方（画面から）：ask（質問を作る）・answers（本人の答えを元に作る。最大 6 問）
function personalOptions(p) {
  const personal = ['ask', 'answers'].includes(p?.personal) ? p.personal : null;
  if (personal !== 'answers') return personal ? {personal} : {};
  const answers = Array.isArray(p.answers)
    ? p.answers
        .slice(0, 6)
        .filter(a => a && typeof a.text === 'string' && typeof a.answer === 'string')
        .map(a => ({text: a.text.slice(0, 100), answer: a.answer.trim().slice(0, 300)}))
    : [];
  if (!answers.length) throw Error('質問への答えがありません');
  return {personal, answers, saveProfile: p.saveProfile === true};
}
async function run(job) {
  if (running) throw Error('別の処理が実行中');
  running = true;
  try {
    state.running = job.kind;
    await save();
    if (job.kind === 'credentials') {
      const credentials = decryptCredentials(credentialKey.privateKey, job.payload);
      if (keychain('set', 'manabo', JSON.stringify(credentials)) === null) throw Error('キーチェーンに保存できません');
      state.connection = 'ready';
      delete state.lastError;
      await save();
    } else if (job.kind === 'verify') {
      await lms.login();
      state.connection = 'connected';
      delete state.lastError;
      await save();
    } else if (job.kind === 'sync' && typeof job.payload?.course === 'string') {
      // 授業ごとの同期：その授業だけ読む（提出状況のまとめての確認・学年暦の確認・前回の同期の記録は全体の同期に任せる）
      await checkAi();
      const i = courseNames(state).indexOf(job.payload.course);
      if (i < 0) throw Error('その授業は見つかりません');
      await lms.sync({course: i});
      await save();
    } else if (job.kind === 'sync') {
      await checkAi();
      await lms.progress('提出状況の確認');
      await lms.collectSubmitted();
      await save();
      const at = Date.now();
      await lms.refreshPending(t => ['code', 'answered'].includes(t.status));
      const refresh = Date.now() - at;
      await refreshCalendar({cache: join(work, 'academic-calendar.json'), url: apiBase + '/api/academic-calendar'});
      await lms.sync();
      state.syncTiming = {...state.syncTiming, refresh, total: Date.now() - at};
      await save();
    } else if (job.kind === 'timetable') {
      applyTimetablePatch(state, job.payload, courseNames(state));
      await save();
    } else if (job.kind === 'prompt') {
      // SaBoRo の画面で入れた出席コードを、開いたままの入力画面に渡す。入れたらその授業を読み直す
      const name = String(job.payload?.course || ''),
        i = courseNames(state).indexOf(name);
      if (i < 0) throw Error('その授業は見つかりません');
      await lms.answerPrompt(name, job.payload?.code);
      await save();
      // 入れたコードを同じ授業の利用者と共有する（画面の入力の「他ユーザーの入力コード」）。共有に失敗しても出席の処理は続ける
      await api('/api/attendance-codes', 'POST', {
        course: courseIdOf(i, state) || name,
        code: String(job.payload?.code ?? '').trim()
      }).catch(() => {});
      try {
        await lms.sync({course: i});
      } catch (e) {
        state.issues = [
          ...(state.issues || []),
          `${name}：出席コードのあとの同期に失敗（${String(e.message).slice(0, 80)}）`
        ];
      }
      await save();
      return {ok: true, message: `${name} の出席コードを入れました`};
    } else if (job.kind === 'attcheck') {
      // 「出席確認」：授業ページを開き、出席コードの入力が出ているかだけ確かめる（出ていれば画面に入力が出る）
      const name = String(job.payload?.course || ''),
        i = courseNames(state).indexOf(name);
      if (i < 0) throw Error('その授業は見つかりません');
      const open = await lms.checkAttendance(i);
      await save();
      return {
        ok: true,
        open,
        message: open ? `${name}：出席コードの入力が出ています` : '現在、出席は受け付けておりません'
      };
    } else if (job.kind === 'seen') {
      // 新着のお知らせを「確認した」：見た印に加え、新着から消す（keys で選んだものだけ、または all で全部）
      const keys = Array.isArray(job.payload?.keys) ? job.payload.keys.map(String) : [],
        all = job.payload?.all === true,
        hit = n => all || keys.includes(n.key);
      for (const n of (state.newNotices || []).filter(hit))
        state.noticeSeen = {
          ...state.noticeSeen,
          [n.course]: [...new Set([...(state.noticeSeen?.[n.course] || []), n.key])]
        };
      state.newNotices = (state.newNotices || []).filter(n => !hit(n));
      await save();
    } else if (job.kind === 'settings') {
      const {
        time,
        autoGenerate,
        campus,
        classSync,
        profile,
        profileForm,
        style,
        schedules,
        pickDownloadDir,
        removeCourse: remove,
        restoreCourse: restore
      } = job.payload;
      if (typeof remove === 'string') {
        const r = removeCourse(state, remove);
        await save();
        return {
          ok: true,
          message: `「${remove}」を削除しました${r.tasks ? `（課題 ${r.tasks} 件も一覧から外しました）` : ''}`
        };
      }
      if (typeof restore === 'string') {
        restoreCourse(state, restore);
        await save();
        return {ok: true, message: `「${restore}」を元に戻しました。次の同期から読みます`};
      }
      let {downloadDir} = job.payload;
      if (pickDownloadDir === true) {
        const chosen = await (platform.pickFolder || pickFolder)(state.settings.downloadDir || materialsRoot());
        if (!chosen) return {message: 'フォルダの選択を取り消しました'};
        downloadDir = chosen;
      }
      if (downloadDir !== undefined) {
        const dir = checkDownloadDir(downloadDir);
        if (dir) await mkdir(dir, {recursive: true});
        state.settings.downloadDir = dir;
        await save();
        return {ok: true, message: `ダウンロード先を ${dir || root} にしました`};
      }
      if (time && !/^\d{2}:\d{2}$/.test(time)) throw Error('時刻が不正');
      if (profile !== undefined && (typeof profile !== 'string' || profile.length > 2000))
        throw Error('「自分について」は 2000 字以内で入力してください');
      if (style !== undefined && (typeof style !== 'string' || style.length > 1000))
        throw Error('「文体」は 1000 字以内で入力してください');
      Object.assign(state.settings, {
        ...(profileForm !== undefined ? {profileForm: globalThis.ProfileForm.cleanProfileForm(profileForm)} : {}),
        ...(typeof profile === 'string' ? {profile: profile.trim()} : {}),
        ...(typeof style === 'string' ? {style: style.trim()} : {}),
        ...(time ? {time} : {}),
        ...(typeof autoGenerate === 'boolean' ? {autoGenerate} : {}),
        ...(CAMPUSES.includes(campus) ? {campus} : {}),
        ...(typeof classSync === 'boolean' ? {classSync} : {})
      });
      if (schedules) state.schedules = schedules;
      await save();
    } else {
      const t = state.tasks.find(t => t.id === job.task);
      if (!t) throw Error('課題がありません');
      if (job.kind === 'supplement') {
        t.supplement = job.payload.text || '';
        if (job.payload.answer !== undefined && job.payload.answer !== t.answer) {
          t.answer = job.payload.answer;
          t.answerEdited = true;
        }
        await save();
      } else if (job.kind === 'link') {
        const url = String(job.payload.url || '');
        if (!(t.candidates || []).some(c => c.url === url)) throw Error('候補にない課題です');
        t.url = url;
        t.type = contentType(url);
        t.imported = false;
        t.status = t.answer ? 'draft' : 'ready';
        t.action = '';
        delete t.candidates;
        await save();
      } else if (job.kind === 'generate') {
        await lms.login();
        await lms.process(t, false, {
          urgent: !job.auto,
          advanced: job.payload?.advanced === true,
          ...personalOptions(job.payload)
        });
      } else if (job.kind === 'submit') {
        await lms.login();
        await lms.process(t, true);
      } else if (job.kind === 'attendance') {
        await lms.login();
        await lms.enterAttendance(t, job.payload?.code);
      }
    }
    delete state.lastError;
    delete state.lastErrorAt;
    if (state.connection === 'attention') state.connection = 'connected';
    const target = state.tasks.find(t => t.id === job.task);
    return {
      ok: !target || ['answered', 'code', 'draft', 'done'].includes(target.status),
      message: target?.action || '処理完了',
      taskStatus: target?.status
    };
  } finally {
    state.running = null;
    delete state.progress;
    running = false;
    await save().catch(() => {});
  }
}
// 「はじめの設定」：saboro 本体（manabo の見た目に合わせた dist/saboro.css）と同じ見た目にする
const setup = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>はじめの設定 — saboro</title><style>*{box-sizing:border-box}html,body{margin:0;padding:0}body{border-top:5px solid #e50020;background:#fff;color:#333;font-family:"Hiragino Kaku Gothic Pro","ヒラギノ角ゴ Pro W3","メイリオ",Meiryo,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.42857143}a{color:#005bac;text-decoration:none}a:hover{color:#78090f;text-decoration:underline}.screen{margin-top:8px;border-top:5px solid #005bac}.nav1{min-height:50px;background:#fbfbfb;padding:5px 14px 0}.nav1 img{display:block;height:34px;width:auto}.nav2{background:#005bac;color:#fff;padding:6px 18px}.crumb{background:#f5f5f5;padding:5px 15px;margin-bottom:15px;color:#666}main{max-width:760px;margin:0 auto;padding:0 15px 30px}.panel{margin-bottom:15px;background:#fff;border:1px solid #d8d8d8;border-radius:4px;box-shadow:1px 1px 6px rgba(0,0,0,.08)}.panel h2{display:flex;align-items:center;margin:0;padding:7px;background:#f5f5f5;border-radius:3px 3px 0 0;font-size:14px;font-weight:400;line-height:20px}.mark{display:inline-block;width:17px;height:10px;margin-right:5px;border-radius:32px;background:#005bac}.body{padding:15px}.body>:first-child{margin-top:0}.body>:last-child{margin-bottom:0}p{margin:0 0 10px}.field{margin:0 0 15px}.field label{display:block;margin-bottom:5px;font-weight:700}.form-control{display:block;width:100%;height:34px;padding:6px 12px;font:inherit;color:#555;background:#fff;border:1px solid #ccc;border-radius:4px;box-shadow:inset 0 1px 1px rgba(0,0,0,.075)}.form-control:focus{border-color:#66afe9;outline:0;box-shadow:inset 0 1px 1px rgba(0,0,0,.075),0 0 8px rgba(102,175,233,.6)}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.btn{display:inline-flex;align-items:center;justify-content:center;padding:6px 12px;font:inherit;color:#333;background:#fff;border:1px solid #ccc;border-radius:4px;cursor:pointer;text-decoration:none}.btn:hover{background:#e6e6e6;border-color:#adadad;color:#333;text-decoration:none}.btn-primary{color:#fff;background:#005bac;border-color:transparent}.btn-primary:hover{background:#003b70;border-color:transparent;color:#fff}small,.muted{color:#666}small{display:block;margin-top:5px;font-size:12px;line-height:1.6}.note{margin-top:10px;padding:8px 12px;background:#f9f9f9;border:1px solid #ddd;border-radius:4px}.ok{color:#3c763d}.ng{color:#a66100}#result{margin-top:10px}.pf{border:0;padding:0;margin:0 0 12px;min-width:0}.pf legend{font-weight:700;margin-bottom:4px;padding:0}.pf-options .check{display:inline-block;margin:2px 14px 2px 0;font-weight:400}.pf-note{margin-top:4px;max-width:360px}#result:empty{display:none}</style><div class="screen"><div class="nav1"><img src="/logo.svg" alt="CHOKYO SaBoRo" width="90" height="34"></div><div class="nav2" id="pagename">はじめの設定</div></div><div class="crumb">saboro / <span id="crumbname">はじめの設定</span></div><main><p id="saved-back" hidden><a class="btn" href="/pair">← saboro に戻る</a></p><p id="intro">この画面で済ませるのは 3 つだけです。授業・課題・締切・資料は、接続後の同期で manabo から自動で集めます。</p>
<section class="panel"><h2><span class="mark" aria-hidden="true"></span>1. manabo の ID とパスワード</h2><div class="body"><form id="form" method="post" action="/credentials"><div class="field"><label for="id">ログインID</label><input class="form-control" id="id" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required></div><div class="field"><label for="pw">パスワード</label><input class="form-control" id="pw" name="password" type="password" autocomplete="current-password" required><small id="pw-saved" hidden>パスワードは保存済みです。変えるときだけ入力してください（空のままなら保存済みのものを使います）。</small></div><small>この Mac/PC にだけ暗号化して保存します。クラウドには送りません。</small><div class="actions"><button class="btn btn-primary">保存して manabo に接続を確認</button></div></form><p class="note" id="inapp" hidden>アプリの画面では、ブラウザ（Safari・Chrome など）に保存したパスワードを使えません。保存済みのパスワードで入れるときは <a href="/setup#browser" target="_blank" rel="noopener">ブラウザでこの画面を開く</a>。保存したら、この画面に戻って 3. の「saboroを接続」を押してください。</p><p id="result"></p></div></section>
<section class="panel"><h2><span class="mark" aria-hidden="true"></span>2. SaBoRo課題サポート</h2><div class="body"><p id="ai">確認中…</p><small>課題の回答は saboro が自動で作ります。設定は要りません。</small></div></section>
<section class="panel"><h2><span class="mark" aria-hidden="true"></span>3. saboro を接続</h2><div class="body"><p>この画面を saboro に接続します。以後はどの端末からでも同じ接続キーで使えます。</p><div class="actions"><a class="btn btn-primary" href="/pair">saboroを接続</a><a class="btn" href="/browser">manabo ブラウザを開く</a></div><small>manabo ブラウザは、出席コードの入力など本人の操作が必要なときに使います。</small></div></section>
<section class="panel" id="phone"><h2><span class="mark" aria-hidden="true"></span>4. スマホと連携</h2><div class="body"><p>スマホのカメラでこの QR コードを読むと、同じ接続キーで saboro が開きます。課題・締切・時間割・お知らせの確認、同期の指示、出席コードの入力ができます（manabo の自動操作はこのパソコンが行うので、パソコンが起動している必要があります）。</p><p><img src="/qr.svg" alt="スマホと連携する QR コード" width="220" height="220" style="display:block;border:1px solid #ddd;border-radius:4px"></p><small>開いて「接続する」を押したら、iPhone は Safari の共有メニューから「ホーム画面に追加」、Android は Chrome のメニューから「ホーム画面に追加」を選ぶと、アプリのように使えます（追加した saboro を初めて開くときにも「接続する」を押します）。QR コードには接続キーが入っています。他の人に見せないでください。</small></div></section>
<section class="panel"><h2><span class="mark" aria-hidden="true"></span>5. 過去のレポート（任意）</h2><div class="body"><p>自分で書いたレポートを 1〜3 本選ぶと、文体（文の長さ・書き出しや締めくくりの癖・よく使う言い回し）と、自分についての情報を読み取ります。回答があなたの書いたような文章になります。</p><div class="field"><input class="form-control" id="reports" type="file" multiple accept=".docx,.pdf,.txt,.md"></div><small>Word（.docx）・PDF・テキスト、1 本 8 MB まで。ファイルはこのパソコンの中で読み、本文だけを AI に 1 回送ります（運営者のサーバーには保存しません）。この読み取りは月の回数に数えません。</small><div class="actions"><button class="btn" id="readreports" type="button">読み取る</button></div><p id="reportresult"></p><div class="note"><b>ChatGPT・Claude の履歴から読み取る（任意）</b><p>ボタンを押すと ChatGPT（または Claude）がブラウザで開きます。設定の「データコントロール」（Claude は「プライバシー」）で「データをエクスポート」を押し、届いたメールのリンクからダウンロードしてください。ダウンロードした zip は、このパソコンが「ダウンロード」フォルダから自動で見つけて読み取ります（3 時間まで待ちます）。</p><small>zip はこのパソコンの中で読み、学業に関係するあなたのメッセージだけを AI に送ります。それ以外の会話は送りません。運営者のサーバーには保存しません。</small><div class="actions"><button class="btn" id="chatgpt" type="button">ChatGPT の履歴を取り込む</button><button class="btn" id="claude" type="button">Claude の履歴を取り込む</button></div><p id="chatstate"></p><div id="chatsuggest" hidden><label for="chattext">読み取った「自分について」の候補（直してから足せます）</label><textarea class="form-control" id="chattext" rows="5" style="height:auto"></textarea><div class="actions"><button class="btn btn-primary" id="chatadd" type="button">6. の「自分について」に足す</button><button class="btn" id="chatclose" type="button">閉じる</button></div></div></div></div></section>
<section class="panel"><h2><span class="mark" aria-hidden="true"></span>6. 自分について（任意）</h2><div class="body"><p>当てはまるものを選んでください。「自分の考え」「自分の経験を踏まえて」など、自分について聞かれる設問の回答に使います。</p><div id="pfwrap"></div><div class="field"><label for="profile">そのほか自分について（自由記述・任意）</label><textarea class="form-control" id="profile" rows="5" maxlength="2000" style="height:auto" placeholder="例：経営学部3年。飲食店のアルバイトを2年続けていて、新人の指導もしている。テニスサークルに所属。将来はマーケティングの仕事に就きたい。"></textarea><small>「あなたの考え」「自分の経験を踏まえて」など、自分について聞かれる設問の回答に使います。</small></div><div class="field"><label for="style">文体</label><textarea class="form-control" id="style" rows="4" maxlength="1000" style="height:auto" placeholder="5. で過去のレポートを読み取ると入ります。自分で書いてもかまいません。"></textarea></div><div class="actions"><button class="btn btn-primary" id="saveprofile" type="button">保存</button></div><p id="profileresult"></p></div></section></main>
<script src="/profile-form.js"></script><script>const $=id=>document.getElementById(id);if(window.ProfileForm)$('pfwrap').innerHTML=ProfileForm.profileFormHtml({});const connectionText={connected:'manabo に接続できています。',ready:'保存済みです。接続はまだ確認していません。',attention:'manabo に接続できませんでした。ID とパスワードを確かめてください。'};async function status(){try{const d=await (await fetch('/status')).json();if(!d.configured)return;document.title='設定 — saboro';$('pagename').textContent='設定';$('crumbname').textContent='設定';$('intro').textContent='manabo の ID とパスワード・SaBoRo課題サポート・saboro との接続の設定です。変えるところだけ入力してください。';$('saved-back').hidden=false;$('id').value=d.username;if(!$('profile').value)$('profile').value=d.profile||'';if(window.ProfileForm)$('pfwrap').innerHTML=ProfileForm.profileFormHtml(d.profileForm);if(!$('style').value)$('style').value=d.style||'';$('pw').required=false;$('pw').placeholder='••••••••（保存済み）';$('pw-saved').hidden=false;if(!$('result').textContent)$('result').textContent=connectionText[d.connection]||''}catch{}}status();if(/Electron\\//.test(navigator.userAgent))$('inapp').hidden=false;$('readreports').onclick=async()=>{const out=$('reportresult'),files=[...$('reports').files];if(!files.length||files.length>3){out.textContent='レポートを 1〜3 本選んでください。';return}out.textContent='読み取り中…（1 分ほどかかります）';try{const list=await Promise.all(files.map(f=>new Promise((ok,ng)=>{if(f.size>8e6){ng(Error('1 本 8 MB までにしてください'));return}const r=new FileReader();r.onload=()=>ok({name:f.name,data:String(r.result).split(',')[1]||''});r.onerror=()=>ng(Error('ファイルを読めませんでした'));r.readAsDataURL(f)})));const d=await (await fetch('/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:list})})).json();if(!d.ok){out.textContent=d.message||'読み取れませんでした。';return}$('style').value=d.style;const have=$('profile').value.trim(),add=d.profile.split('\\n').map(x=>x.trim()).filter(x=>x&&!have.includes(x));$('profile').value=[have,...add].filter(Boolean).join('\\n').slice(0,2000);out.textContent='読み取りました。6. の内容を確かめて、直してから「保存」を押してください。'}catch(e){out.textContent=e.message||'読み取れませんでした。'}};
const post=(u,b)=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
async function chat(){try{const d=await (await fetch('/status')).json(),j=d.chatImport,g=d.profileSuggestion,out=$('chatstate');if(j)out.textContent=j.status==='reading'?j.source+' の履歴を読み取っています…':j.status==='failed'?'読み取れませんでした（'+(j.error||'不明なエラー')+'）。もう一度ボタンを押してください。':j.source+' の書き出しの zip を待っています（「ダウンロード」フォルダに入ると自動で読み取ります）。';else if(!g)out.textContent='';if(g&&$('chatsuggest').hidden){if(g.text){$('chattext').value=g.text;$('chatsuggest').hidden=false;out.textContent=g.source+' の会話 '+g.count+' 件から読み取りました。内容を確かめて足してください。'}else out.textContent=g.message||'読み取れる内容がありませんでした。'}}catch{}}
const startChat=async source=>{const d=await (await post('/chat-import',{source})).json();if(d.ok){window.open(d.url,'_blank');$('chatsuggest').hidden=true}chat()};$('chatgpt').onclick=()=>startChat('chatgpt');$('claude').onclick=()=>startChat('claude');
$('chatadd').onclick=async()=>{const have=$('profile').value.trim(),add=$('chattext').value.split('\\n').map(x=>x.trim()).filter(x=>x&&!have.includes(x));$('profile').value=[have,...add].filter(Boolean).join('\\n').slice(0,2000);await post('/chat-import/stop');$('chatsuggest').hidden=true;$('chatstate').textContent='足しました。6. の「保存」を押すと使われます。'};$('chatclose').onclick=async()=>{await post('/chat-import/stop');$('chatsuggest').hidden=true;$('chatstate').textContent=''};chat();setInterval(chat,5000);
$('saveprofile').onclick=async()=>{const out=$('profileresult');try{const r=await fetch('/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:$('profile').value,style:$('style').value,profileForm:window.ProfileForm?ProfileForm.readProfileForm($('pfwrap')):undefined})});out.textContent=r.ok?'保存しました。次に作る回答から使います。':'保存できませんでした。'}catch{out.textContent='保存できませんでした。'}};
async function ai(){try{const d=await (await fetch('/ai-status')).json();$('ai').innerHTML=d.ok?'<b class="ok">使えます</b>':'<b class="ng">今は使えません</b>（お支払いの状態や接続を確かめてください）'}catch{$('ai').textContent='サービスに接続できませんでした。'}}ai();
$('form').onsubmit=async e=>{e.preventDefault();const out=$('result');out.textContent='保存して接続を確認中…';const r=await fetch('/credentials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('id').value,password:$('pw').value})});$('pw').value='';if(!r.ok){out.textContent='保存できませんでした。';return}status();try{const v=await fetch('/verify',{method:'POST'});const d=await v.json();out.textContent='保存しました。'+d.message}catch{out.textContent='保存しました。接続の確認は後でできます。'}};</script></html>`;
// 画面の「資料」から Mac に保存したファイルを開いたときの小さな応答ページ（開けたら自動で閉じる）
const openPage = (message, close = false) =>
  `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>saboro</title><style>body{font:15px -apple-system,sans-serif;color:#333;margin:60px auto;max-width:420px;padding:20px;text-align:center}</style><p>${message}</p>${close ? '<script>setTimeout(()=>window.close(),700)</script>' : ''}`;
http
  .createServer(async (req, res) => {
    try {
      const deny = requestAllowed(req);
      if (deny) {
        res.writeHead(deny).end();
        return;
      }
      if (req.url === '/setup' || req.url === '/') {
        res
          .writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
          })
          .end(setup);
        return;
      }
      if (req.url === '/pair') {
        res
          .writeHead(302, {
            Location: apiBase + '/#connect=' + encodeURIComponent(owner),
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer'
          })
          .end();
        return;
      }
      if (req.url === '/ai-status') {
        await checkAi();
        res
          .writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'})
          .end(JSON.stringify({ok: lms.aiAvailable !== false}));
        return;
      }
      if (req.url === '/status') {
        const c = savedCredentials();
        res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(
          JSON.stringify({
            configured: !!c?.password,
            username: c?.username || '',
            connection: state.connection || '',
            profile: state.settings?.profile || '',
            profileForm: state.settings?.profileForm || {},
            style: state.settings?.style || '',
            chatImport: state.chatImport || null,
            profileSuggestion: state.profileSuggestion || null
          })
        );
        return;
      }
      // スマホと連携：接続キー入りの URL を QR コードにして出す（この画面の中だけ。別のサイトからは requestAllowed が断る）
      if (req.url === '/qr.svg') {
        const svg = await QRCode.toString(apiBase + '/#connect=' + encodeURIComponent(owner), {
          type: 'svg',
          margin: 1,
          width: 220
        });
        res
          .writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer'
          })
          .end(svg);
        return;
      }
      if (req.url === '/logo.svg') {
        res
          .writeHead(200, {'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400'})
          .end(await readFile(join(repo, 'dist/saboro-logo.svg')));
        return;
      }
      if (req.url === '/ping') {
        res.writeHead(204, {'Cache-Control': 'no-store'}).end();
        return;
      } // 画面の接続用リンクが、このパソコンの鍵のものかを確かめる（鍵の SHA-256 が同じなら 1×1 の画像を返す。鍵そのものは返さない）
      if (req.url.startsWith('/owned?')) {
        const h = Buffer.from(String(new URL(req.url, 'http://127.0.0.1:8766').searchParams.get('h') || ''), 'utf8'),
          mine = Buffer.from(createHash('sha256').update(owner).digest('hex'), 'utf8');
        if (h.length === mine.length && timingSafeEqual(h, mine)) {
          res
            .writeHead(200, {'Content-Type': 'image/gif', 'Cache-Control': 'no-store'})
            .end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
        } else res.writeHead(404, {'Cache-Control': 'no-store'}).end();
        return;
      }
      if (req.url.startsWith('/open?')) {
        const id = new URL(req.url, 'http://127.0.0.1:8766').searchParams.get('id'),
          file = openableMaterial(state.materials, id, lms.root);
        if (!file) {
          res
            .writeHead(404, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'})
            .end(openPage('この資料は ' + deviceName + ' に見つかりません。同期すると保存し直します。'));
          return;
        }
        platform.openPath(file);
        res
          .writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'})
          .end(openPage(deviceName + ' で資料を開きました。このタブは閉じて構いません。', true));
        return;
      }
      if (req.url === '/browser') {
        // 同期などの処理中は、裏で動いているブラウザを切り替えられないので待ってもらう
        if (running) {
          res
            .writeHead(409, {'Content-Type': 'text/html; charset=utf-8'})
            .end(
              '<meta charset="utf-8"><p>同期などの処理中です。終わってから、もう一度「manabo ブラウザを開く」を押してください。</p><p><a href="/setup">設定に戻る</a></p>'
            );
          return;
        }
        running = true;
        try {
          await lms.showBrowser();
        } finally {
          running = false;
        }
        res.writeHead(302, {Location: '/setup'}).end();
        return;
      }
      if (req.url === '/verify' && req.method === 'POST') {
        if (running) {
          res
            .writeHead(409, {'Content-Type': 'application/json'})
            .end(JSON.stringify({message: '処理中です。完了後に確認してください。'}));
          return;
        }
        running = true;
        try {
          await lms.login();
          state.connection = 'connected';
          delete state.lastError;
          await save();
          res
            .writeHead(200, {'Content-Type': 'application/json'})
            .end(JSON.stringify({message: 'manaboに接続しました。'}));
        } catch (e) {
          state.connection = 'attention';
          state.lastError = e.message;
          state.lastErrorAt = new Date().toISOString();
          await save();
          res.writeHead(400, {'Content-Type': 'application/json'}).end(JSON.stringify({message: e.message}));
        } finally {
          running = false;
        }
        return;
      }
      if (req.url === '/chat-import' && req.method === 'POST') {
        const d = JSON.parse(await readLimited(req, 1000));
        const source = CHAT_SOURCES[d.source];
        if (!source) throw Error('取り込み元が不正');
        state.chatImport = {source: source.name, since: Date.now(), until: Date.now() + CHAT_WAIT};
        await save().catch(() => {});
        res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({ok: true, url: source.url}));
        return;
      }
      if (req.url === '/chat-import/stop' && req.method === 'POST') {
        delete state.chatImport;
        delete state.profileSuggestion;
        await save().catch(() => {});
        res.writeHead(200, {'Content-Type': 'application/json'}).end('{}');
        return;
      }
      if (req.url === '/profile-form.js') {
        res
          .writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store'})
          .end(await readFile(join(repo, 'dist/profile-form.js')));
        return;
      }
      if (req.url === '/profile' && req.method === 'POST') {
        const d = JSON.parse(await readLimited(req, 20000));
        const profile = String(d.profile ?? '').trim(),
          style = String(d.style ?? '').trim();
        if (profile.length > 2000 || style.length > 1000) throw Error('長すぎます');
        state.settings = {
          ...state.settings,
          profile,
          style,
          ...(d.profileForm !== undefined ? {profileForm: globalThis.ProfileForm.cleanProfileForm(d.profileForm)} : {})
        };
        await save().catch(() => {});
        res.writeHead(200, {'Content-Type': 'application/json'}).end('{}');
        return;
      }
      if (req.url === '/reports' && req.method === 'POST') {
        const d = JSON.parse(await readLimited(req, REPORT_BODY_MAX));
        let out;
        try {
          out = {ok: true, ...(await learnFromReports(d.files))};
        } catch (e) {
          out = {ok: false, message: String(e.message).slice(0, 200)};
        }
        res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(out));
        return;
      }
      if (req.url === '/credentials' && req.method === 'POST') {
        let b = '';
        for await (const c of req) {
          b += c;
          if (b.length > 10000) throw Error('入力が長すぎます');
        }
        const d = JSON.parse(b),
          saved = savedCredentials(),
          username = String(d.username || '').trim(),
          password = String(d.password || '') || saved?.password || '';
        if (!username || !password) throw Error('入力が不足');
        if (keychain('set', 'manabo', JSON.stringify({username, password})) === null) throw Error('保存失敗');
        state.connection = 'ready';
        await save().catch(() => {});
        res.writeHead(200).end('{}');
        return;
      }
      res.writeHead(404).end();
    } catch {
      res.writeHead(400).end('{"error":"処理に失敗"}');
    }
  })
  .listen(8766, '127.0.0.1', () => console.log('saboro local: http://127.0.0.1:8766/setup'));
async function tick() {
  if (running) return;
  try {
    const job = await api('/api/agent/claim', 'POST', {});
    if (!job && shouldUpdate({deployed: deployedSha, head: state.version, running, lastTry: lastUpdateTry})) {
      lastUpdateTry = Date.now();
      const r = await autoUpdate();
      if (r && r !== 'current') lastUpdateTry = Date.now() + 9 * 60 * 1000;
      return;
    }
    if (job) {
      try {
        const result = await run(job);
        await api('/api/agent/finish', 'POST', {id: job.id, status: result.ok ? 'done' : 'waiting', result});
      } catch (e) {
        state.connection = 'attention';
        state.lastError = e.message;
        state.lastErrorAt = new Date().toISOString();
        await save();
        await api('/api/agent/finish', 'POST', {id: job.id, status: 'waiting', result: {message: e.message}});
      }
    } else {
      const now = new Date(),
        day = now.toLocaleDateString('sv-SE', {timeZone: 'Asia/Tokyo'}),
        hm = now.toLocaleTimeString('en-GB', {timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit'}); // 支払いが必要な間（サーバーが知らせる）は、自動の同期もしない。支払いが済めば同じ日のうちに実行する
      // 授業の開始時刻には、その授業だけを同期する（出席コードの入力が出れば SaBoRo の画面に出す）。同じ授業は 1 日 1 回
      const due = !state.billingBlocked && state.settings?.classSync !== false ? dueClassSyncs(state, now) : [];
      if (hm >= state.settings.time && day !== lastDay && state.lastScheduledDay !== day && !state.billingBlocked) {
        lastDay = day;
        state.lastScheduledDay = day;
        try {
          await run({kind: 'sync'});
        } catch (e) {
          state.lastError = e.message;
          state.lastErrorAt = new Date().toISOString();
          state.connection = 'attention';
          await save();
        }
      } else if (due.length) {
        const s = due[0];
        state.classSynced = {[day]: {...(state.classSynced?.[day] || {}), [s.name]: new Date().toISOString()}};
        try {
          await run({kind: 'sync', payload: {course: s.name}});
          // 授業開始の同期で資料を保存したら OS の通知で知らせる（アプリ：OS の通知、Mac のサービス：通知センター）
          const r = state.courseSummary?.[s.name];
          if (r?.materials > 0 && platform.notify)
            await Promise.resolve(platform.notify('saboro', `${s.name}：資料 ${r.materials} 件を保存しました`)).catch(
              () => {}
            );
        } catch (e) {
          state.lastError = e.message;
          state.lastErrorAt = new Date().toISOString();
          state.connection = 'attention';
          await save();
        }
      } else if (!(await aiResume().catch(() => false))) await save();
    }
  } catch (e) {
    console.error('saboro: 同期接続待ち');
  }
}
// 公開に成功したコミットまで自動更新し、launchd に再起動させる。COURSECUE_AUTO_UPDATE=0 で無効
// 再起動。launchd（npm run install:agent）配下なら終了するだけで KeepAlive が起動し直す。npm start で動かしているときは、新しいバージョンのプロセスを自分で起こしてから終了する
function restart() {
  if (platform.restart) {
    platform.restart();
    return;
  }
  const underLaunchd = process.env.COURSECUE_LAUNCHD == '1' || /coursecue/i.test(process.env.XPC_SERVICE_NAME || '');
  if (!underLaunchd) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: repo,
      detached: true,
      stdio: 'inherit',
      env: {...process.env, COURSECUE_RESTARTED: '1'}
    });
    child.unref();
  }
  process.exit(0);
}
async function autoUpdate() {
  if (running || process.env.COURSECUE_AUTO_UPDATE === '0') return;
  try {
    const r = updateToDeployed({repo, target: deployedSha, signature: deployedSig});
    if (r === 'updated') {
      console.error('saboro: 公開版に更新しました。再起動します');
      restart();
    }
    if (r.startsWith('skipped:')) console.error('saboro: 自動更新しません（' + r.slice(8) + '）');
    return r;
  } catch (e) {
    console.error('saboro: 自動更新を確認できません', String(e.message).split('\n')[0]);
    return 'error';
  }
}
// 起動した直後は何も処理していない。前回が処理の途中で終わった（終了・更新での入れ替えなど）と state.json に「処理中」が残り、画面が「同期中…」のままになるので消す
if (state.running) state.running = null;
delete state.progress;
state.runtime = platform.version ? 'desktop' : 'cli';
state.os = platform.name;
if (platform.version) state.version = platform.version;
else
  try {
    state.version = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo}).toString().trim();
  } catch {}
await lms.trashDuplicates().catch(e => console.error('saboro: 複製の整理に失敗', String(e.message)));
await checkAi();
await save().catch(() => {});
setInterval(tick, 5000);
setInterval(() => checkChatImport().catch(() => {}), 15000);
setInterval(autoUpdate, 10 * 60 * 1000);
await tick();
await autoUpdate();
