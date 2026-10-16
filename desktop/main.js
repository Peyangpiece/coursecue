// saboro デスクトップ：Mac と Windows で、ターミナルなしに同期・生成を動かす常駐アプリ。
// 秘密は OS の仕組み（macOS キーチェーン / Windows DPAPI）で暗号化し、設定は画面の 3 手順だけ
import {app, BrowserWindow, Tray, Menu, shell, dialog, safeStorage, nativeImage, net} from 'electron';
import {join, dirname, basename} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  statSync,
  unlinkSync,
  createWriteStream,
  accessSync,
  constants as fsConstants
} from 'node:fs';
import {spawn, execFileSync, execFile} from 'node:child_process';
import {readdir, rename, rm} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';
import {cleanupInstallers} from './installer-cleanup.js';
import {
  downloadInstaller,
  installerDigest,
  macInstallerName,
  appBundle,
  canReplace,
  replaceScript
} from './mac-update.js';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {randomBytes, createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
const here = dirname(fileURLToPath(import.meta.url)),
  repo = dirname(here);
const userData = app.getPath('userData'),
  docs = app.getPath('documents');
const root = join(docs, 'saboro'),
  work = join(userData, 'work'),
  browsers = join(userData, 'pw-browsers');
const apiBase = process.env.COURSECUE_API || 'https://coursecue.hrk-6888.workers.dev';
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
let win = null,
  tray = null,
  status = '起動中…',
  ready = false,
  newer = null,
  prepared = null,
  downloading = null;
// 暗号化した秘密の保存（safeStorage：macOS はキーチェーン、Windows は DPAPI）
const secretsFile = join(userData, 'secrets.json');
function loadSecrets() {
  try {
    return JSON.parse(readFileSync(secretsFile, 'utf8'));
  } catch {
    return {};
  }
}
const secrets = {
  get(name) {
    const all = loadSecrets();
    if (!all[name]) return null;
    try {
      return safeStorage.decryptString(Buffer.from(all[name], 'base64'));
    } catch {
      return null;
    }
  },
  set(name, value) {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const all = loadSecrets();
    all[name] = safeStorage.encryptString(String(value)).toString('base64');
    mkdirSync(userData, {recursive: true});
    writeFileSync(secretsFile, JSON.stringify(all), {mode: 0o600});
    return '';
  }
};
// 接続キーと Mac/PC の鍵を作ってクラウドに登録する（初回だけ）
async function register() {
  const next = {owner: randomBytes(32).toString('hex'), device: randomBytes(32).toString('hex')};
  const r = await fetch(apiBase + '/api/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(next)
  });
  if (!r.ok) throw Error(`クラウドへの登録に失敗しました（${r.status}）`);
  if (secrets.set('owner', next.owner) === null || secrets.set('device', next.device) === null)
    throw Error('秘密を保存できません');
  return next;
}
async function pickFolder(current) {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '資料のダウンロード先のフォルダ',
    defaultPath: current || root,
    properties: ['openDirectory', 'createDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
}
globalThis.saboroPlatform = {
  name: process.platform,
  secrets,
  openPath: f => shell.openPath(f),
  trash: async f => {
    await shell.trashItem(f);
    return 'trash';
  },
  pickFolder,
  register,
  restart: () => {
    app.relaunch();
    app.exit(0);
  },
  version: app.getVersion()
};
// 画面：まず設定（Mac/PC 内のサービスが出す画面）。「saboroを接続」で saboro 本体へ移る
function page(html) {
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(
      `<!doctype html><html lang="ja"><meta charset="utf-8"><style>body{font:15px -apple-system,"Segoe UI",sans-serif;color:#233b32;background:#f7f8f5;margin:60px auto;max-width:460px;padding:20px;line-height:1.8}</style>${html}`
    )
  );
}
// 開く画面：サービスの起動前は状況、設定前は「はじめの設定」、設定後は接続キー付きで saboro 本体（/pair が #connect= を付けて移す）
// 接続キーなしで saboro 本体を開くと「個人用」の画面（アプリのダウンロードの案内）になってしまう
function home() {
  return !ready
    ? page(`<h1>saboro</h1><p>${status}</p>`)
    : secrets.get('manabo')
      ? 'http://127.0.0.1:8766/pair'
      : 'http://127.0.0.1:8766/setup';
}
// 開いている画面は差し替えずに前に出す（起動時の activate で起動中の画面や設定の画面を上書きしない）
function focusWindow() {
  if (!app.isReady()) return;
  if (Date.now() - lastCheck > 10 * 60 * 1000) checkUpdate();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else openWindow(home());
}
function openWindow(url) {
  if (win && !win.isDestroyed()) {
    win.loadURL(url);
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    title: 'saboro',
    autoHideMenuBar: true,
    webPreferences: {contextIsolation: true, sandbox: true}
  });
  if (process.platform !== 'darwin') win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(openLink);
  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);
  win.webContents.on('did-fail-load', loadFailed);
  win.loadURL(url);
  win.on('closed', () => {
    win = null;
  });
}
// この画面で開くのは saboro 本体（クラウド）と PC 内のサービスの画面だけ。ほかのサイトへの移動（リンク・転送）は止めて既定のブラウザで開く（画面の中に別のサイトを出さない）
const ownPage = url =>
  url.startsWith(apiBase + '/') ||
  url === apiBase ||
  url.startsWith('http://127.0.0.1:8766/') ||
  url.startsWith('data:');
function guardNavigation(e, url) {
  if (ownPage(url)) return;
  e.preventDefault();
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
}
// saboro 本体（クラウド）や Mac/PC 内のサービスの画面を開けなかったとき：真っ白のままにせず理由を出し、15 秒ごとに開き直す
// -3（ERR_ABORTED）は別の画面へ移っただけなので扱わない。インターネットにつながっていないと、接続後の saboro 本体が開けない
let retryTimer = null;
function loadFailed(_e, code, desc, url, isMainFrame) {
  if (!isMainFrame || code === -3 || !/^https?:/.test(url)) return;
  const cloud = !url.startsWith('http://127.0.0.1');
  win.loadURL(
    page(
      `<h1>saboro</h1><p>${cloud ? 'saboro の画面を開けませんでした。インターネットに接続しているか確認してください。' : 'サービスの画面を開けませんでした。'}</p><p style="color:#6b7b74;font-size:13px">${String(desc).replace(/[<>&]/g, '')}（${code}）。15 秒ごとに開き直します。</p>`
    )
  );
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && win.webContents.getURL().startsWith('data:')) win.loadURL(ready ? home() : url);
  }, 15000);
}
// 開いた直後は読み込みが終わる前で getURL() が空になる。空のときも状況の画面とみなして書き換える（書き換えないと「起動中…」のまま止まって見える）
function showStatus(text) {
  status = text;
  const shown = win && !win.isDestroyed() ? win.webContents.getURL() : null;
  if (shown !== null && (shown === '' || shown.startsWith('data:'))) win.loadURL(page(`<h1>saboro</h1><p>${text}</p>`));
  refreshTray();
}
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {label: 'saboro を開く', click: () => openWindow(home())},
      {label: '設定', click: () => openWindow('http://127.0.0.1:8766/setup')},
      {label: '資料のフォルダを開く', click: () => shell.openPath(root)},
      {type: 'separator'},
      prepared
        ? {label: `再起動して ${prepared} に更新`, click: () => installNow()}
        : downloading
          ? {
              label: `新しい版 ${downloading.version} をダウンロード中…${downloading.pct == null ? '' : ` ${downloading.pct}%`}`,
              enabled: false
            }
          : newer
            ? {label: `新しい版 ${newer} に更新`, click: () => downloadMacUpdate(newer)}
            : {label: '新しい版を確認', click: () => checkUpdate(true)},
      {label: '更新の記録を開く', click: () => shell.openPath(updateLogFile)},
      {
        label: 'AI の使用量の記録を開く',
        click: () => {
          const f = join(work, 'usage.jsonl');
          existsSync(f) ? shell.showItemInFolder(f) : shell.openPath(work);
        }
      },
      {type: 'separator'},
      {label: status, enabled: false},
      {label: `版 ${app.getVersion()}`, enabled: false},
      {type: 'separator'},
      {label: '終了', click: () => app.quit()}
    ])
  );
  tray.setToolTip('saboro：' + status);
}
// 新しいウィンドウで開くリンク：「はじめの設定」はこの画面で開き、それ以外（ダウンロード・manabo・「ブラウザで開く」など）は既定のブラウザで開く
function openLink({url}) {
  if (url === 'http://127.0.0.1:8766/setup') openWindow(url);
  else if (/^https?:\/\//.test(url)) shell.openExternal(url);
  return {action: 'deny'};
}
// 以前に入れた Mac サービス（launchd の jp.coursecue.bridge）や手で動かしたサービス（npm start）が同じポート（8766）を使っていると起動できないため、確認してから止める
// 設定ファイルを消しただけでは launchd に読み込まれたまま動き続けるので、読み込み状態とポートを使っているプロセスも見る
const agentLabel = 'jp.coursecue.bridge',
  agentFile = join(homedir(), 'Library/LaunchAgents', agentLabel + '.plist');
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  } catch {
    return '';
  }
};
const portPids = () => run('/usr/sbin/lsof', ['-nP', '-t', '-iTCP:8766', '-sTCP:LISTEN']).split('\n').filter(Boolean);
const command = pid => run('/bin/ps', ['-o', 'command=', '-p', pid]);
async function stopOldAgent() {
  if (process.platform !== 'darwin') return;
  const domain = `gui/${process.getuid()}/${agentLabel}`,
    loaded = existsSync(agentFile) || run('/bin/launchctl', ['print', domain]) !== '',
    pids = portPids().filter(pid => /local\/bridge\.js/.test(command(pid)));
  if (!loaded && !pids.length) return;
  const r = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['止めて続ける', '終了'],
    defaultId: 0,
    cancelId: 1,
    message: '以前に入れた saboro の Mac サービスが動いています',
    detail:
      'アプリと同時には動かせないため、Mac サービスを止めてアプリに切り替えます。manabo の ID とパスワードは「はじめの設定」で入れ直してください。'
  });
  if (r.response !== 0) {
    app.exit(0);
    return;
  }
  run('/bin/launchctl', ['bootout', domain]);
  if (existsSync(agentFile)) await shell.trashItem(agentFile).catch(() => {});
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {}
  }
}
function portFree() {
  return new Promise(resolve => {
    const s = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => s.close(() => resolve(true)))
      .listen(8766, '127.0.0.1');
  });
}
async function waitPort() {
  for (let i = 0; i < 20; i++) {
    if (await portFree()) return;
    await new Promise(r => setTimeout(r, 250));
  }
  const who = process.platform === 'darwin' ? portPids().map(command).filter(Boolean).join('、').slice(0, 160) : '';
  throw Error(
    'ポート 8766 を別のアプリが使っています' +
      (who ? `（${who}）` : '') +
      '。そのアプリを終了してから開き直してください。'
  );
}
// manabo 用のブラウザ（Chromium）を初回だけ取り込む
// 準備済みの印には Playwright の版を書く。アプリの更新で Playwright の版が変わると必要な Chromium も変わるため、版が違えば取り込み直す（印だけ見ていると更新後に起動できず、同期が止まる）
const playwrightVersion = () => {
  try {
    return (
      JSON.parse(
        readFileSync(
          join(repo.replace(/app\.asar$/, 'app.asar.unpacked'), 'node_modules/playwright-core/package.json'),
          'utf8'
        )
      ).version || ''
    );
  } catch {
    return '';
  }
};
const browserReady = (marker, version) => {
  try {
    return !!version && readFileSync(marker, 'utf8').trim() === version;
  } catch {
    return false;
  }
};
function ensureBrowser() {
  return new Promise((resolve, reject) => {
    const marker = join(browsers, '.ready'),
      version = playwrightVersion();
    if (browserReady(marker, version) || (!version && existsSync(marker))) return resolve();
    showStatus('manabo 用のブラウザを準備しています（初回とアプリの更新後だけ、数分かかります）…');
    const cli = join(repo.replace(/app\.asar$/, 'app.asar.unpacked'), 'node_modules/playwright/cli.js');
    const p = spawn(process.execPath, [cli, 'install', 'chromium'], {
      env: {...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: browsers},
      stdio: 'ignore',
      windowsHide: true
    });
    p.on('error', reject);
    p.on('exit', c => {
      if (c === 0) {
        mkdirSync(browsers, {recursive: true});
        writeFileSync(marker, version || new Date().toISOString());
        resolve();
      } else reject(Error('ブラウザの準備に失敗しました（' + c + '）'));
    });
  });
}
// Mac のアプリのメニュー（画面左上）：既定のままだと内部の名前（package.json の name＝coursecue）で「About coursecue」「Quit coursecue」と出るため、saboro の名前で作る。
// app.name は変えない（設定の保存場所 userData とキーチェーンの「coursecue Safe Storage」がこの名前にひも付いていて、変えると保存した秘密を読めなくなる）。コピー・貼り付けなどの編集の操作は残す
function macAppMenu() {
  if (process.platform !== 'darwin') return;
  app.setAboutPanelOptions({applicationName: 'saboro', applicationVersion: app.getVersion(), version: ''});
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'saboro',
        submenu: [
          {role: 'about', label: 'saboro について'},
          {type: 'separator'},
          {role: 'services', label: 'サービス'},
          {type: 'separator'},
          {role: 'hide', label: 'saboro を隠す'},
          {role: 'hideOthers', label: 'ほかを隠す'},
          {role: 'unhide', label: 'すべてを表示'},
          {type: 'separator'},
          {role: 'quit', label: 'saboro を終了'}
        ]
      },
      {
        label: '編集',
        submenu: [
          {role: 'undo', label: '取り消す'},
          {role: 'redo', label: 'やり直す'},
          {type: 'separator'},
          {role: 'cut', label: 'カット'},
          {role: 'copy', label: 'コピー'},
          {role: 'paste', label: 'ペースト'},
          {role: 'selectAll', label: 'すべてを選択'}
        ]
      },
      {
        label: '表示',
        submenu: [
          {role: 'reload', label: '再読み込み'},
          {type: 'separator'},
          {role: 'resetZoom', label: '実際のサイズ'},
          {role: 'zoomIn', label: '拡大'},
          {role: 'zoomOut', label: '縮小'},
          {type: 'separator'},
          {role: 'togglefullscreen', label: 'フルスクリーンにする'}
        ]
      },
      {
        label: 'ウインドウ',
        submenu: [
          {role: 'minimize', label: 'しまう'},
          {role: 'close', label: '閉じる'}
        ]
      }
    ])
  );
}
async function start() {
  macAppMenu();
  tray = new Tray(nativeImage.createFromPath(join(repo, 'dist/icon-512.png')).resize({width: 18, height: 18}));
  refreshTray();
  checkExpectedUpdate();
  if (process.platform === 'darwin') setTimeout(cleanupMacInstallers, 5000);
  openWindow(page('<h1>saboro</h1><p>起動中…</p>'));
  Object.assign(process.env, {
    COURSECUE_ROOT: root,
    COURSECUE_WORK: work,
    COURSECUE_AUTO_UPDATE: '0',
    COURSECUE_VERSION: app.getVersion(),
    PLAYWRIGHT_BROWSERS_PATH: browsers,
    COURSECUE_API: apiBase
  });
  // Windows の import() は C:\ で始まるパスを受け付けないので file:// の URL にして読み込む。フォルダの作成もここで行い、失敗したら理由を出す
  try {
    mkdirSync(root, {recursive: true});
    mkdirSync(work, {recursive: true});
    await stopOldAgent();
    await ensureBrowser();
    showStatus('サービスを起動しています…');
    await waitPort();
    await import(pathToFileURL(join(repo, 'local/bridge.js')).href);
    ready = true;
    showStatus('動作中');
    app.setLoginItemSettings({openAtLogin: true});
    openWindow(home());
  } catch (e) {
    showStatus('起動に失敗：' + String(e.message).slice(0, 120));
    dialog.showErrorBox('saboro を起動できません', String(e.message));
  }
  // 新しい版の確認（起動時・1 時間ごと・画面を前に出したとき（前の確認から 10 分以上たっていれば）・メニューの「新しい版を確認」）。
  // Windows は裏でダウンロードし、終わったら再起動して更新するかを聞く。Mac は Apple の署名がないと入れ替えられないので、ダウンロードはせず知らせるだけにする
  try {
    const {default: updater} = await import('electron-updater'),
      u = updater.autoUpdater;
    u.logger = {
      info: m => updateLog('INFO', m),
      warn: m => updateLog('WARN', m),
      error: m => updateLog('ERROR', m),
      debug: () => {}
    };
    u.on('error', e => updateLog('ERROR', e?.message || e));
    if (process.platform === 'darwin') u.autoDownload = false;
    else {
      u.on('update-downloaded', i => offerInstall(i.version));
      installNow = () => {
        expectUpdate(prepared);
        u.quitAndInstall(false, true);
      };
    }
    checkUpdate = async (manual = false) => {
      lastCheck = Date.now();
      try {
        const r = await u.checkForUpdates(),
          v = r?.updateInfo?.version;
        r?.downloadPromise?.catch(() => {});
        if (v && isNewer(v, app.getVersion())) {
          updateFiles[v] = r.updateInfo.files;
          if (process.platform === 'darwin') await announce(v, manual);
          else if (manual && prepared === v) await offerInstall(v, true);
          else if (manual)
            dialog.showMessageBox({
              type: 'info',
              message: `新しい版 ${v} をダウンロードしています`,
              detail: 'ダウンロードが終わったら、再起動して更新するかをお聞きします。'
            });
        } else if (manual)
          dialog.showMessageBox({
            type: 'info',
            message: 'saboro は最新の版です',
            detail: `いまの版は ${app.getVersion()} です。`
          });
      } catch (e) {
        console.error('saboro: 新しい版を確認できません', e.message);
        if (manual)
          dialog.showMessageBox({
            type: 'warning',
            message: '新しい版を確認できませんでした',
            detail: String(e.message || e)
              .split('\n')[0]
              .slice(0, 200)
          });
      }
    };
    checkUpdate();
    setInterval(() => checkUpdate(), 3600 * 1000);
  } catch {}
}
let checkUpdate = async () => {},
  installNow = () => {},
  lastCheck = 0;
// 版ごとの配布物の情報（latest-mac.yml の files：名前と sha512）。Mac は落とした .dmg をこれで確かめる
const updateFiles = {};
// 更新の記録（userData/updater.log）。入れ替えに失敗したとき、どこで止まったかを後から確かめられるようにする（1 MB を超えたら最初から）
const updateLogFile = join(userData, 'updater.log');
function updateLog(level, ...parts) {
  try {
    if (existsSync(updateLogFile) && statSync(updateLogFile).size > 1e6) writeFileSync(updateLogFile, '');
    appendFileSync(updateLogFile, `${new Date().toISOString()} ${level} ${parts.map(String).join(' ')}\n`);
  } catch {}
}
// Windows：再起動して入れ替える前に、入れ替え先の版を記録する。次に起動したとき版が変わっていなければ、失敗を知らせて手動の入れ替えを案内する
// （入れ替えは画面つきで行う。閉じられないファイルがあるなどで失敗したとき、インストーラーの案内が見えるように）
const expectFile = join(userData, 'update-expected.json');
function expectUpdate(version) {
  updateLog('INFO', `再起動して ${version} に入れ替えます（いまの版 ${app.getVersion()}）`);
  try {
    writeFileSync(expectFile, JSON.stringify({from: app.getVersion(), to: version, at: new Date().toISOString()}));
  } catch {}
}
async function checkExpectedUpdate() {
  let e = null;
  try {
    e = JSON.parse(readFileSync(expectFile, 'utf8'));
  } catch {
    return;
  }
  try {
    unlinkSync(expectFile);
  } catch {}
  if (!e?.to || !isNewer(e.to, app.getVersion())) {
    updateLog('INFO', `${app.getVersion()} に入れ替わりました`);
    return;
  }
  updateLog('ERROR', `${e.to} に入れ替わっていません（いまの版 ${app.getVersion()}）`);
  if (process.platform === 'darwin') {
    const dmg = join(app.getPath('downloads'), macInstallerName(e.to, process.arch)),
      has = existsSync(dmg);
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: [has ? '.dmg を開く' : 'ダウンロードのページを開く', '更新の記録を開く', '閉じる'],
      defaultId: 0,
      cancelId: 2,
      message: `新しい版 ${e.to} に自動で入れ替えられませんでした`,
      detail: `いまの版は ${app.getVersion()} のままです。${has ? '「.dmg を開く」を押し' : 'ダウンロードのページから新しい版の .dmg を落として開き'}、メニューバーの saboro から「終了」を選んでから、開いたウインドウで saboro を「アプリケーション」にドラッグして入れ替えてください。設定や資料はそのまま残ります。`
    });
    if (r.response === 0) has ? shell.openPath(dmg) : shell.openExternal(macDownloadPage);
    else if (r.response === 1) shell.openPath(updateLogFile);
    return;
  }
  const r = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['ダウンロードのページを開く', '更新の記録を開く', '閉じる'],
    defaultId: 0,
    cancelId: 2,
    message: `新しい版 ${e.to} に入れ替えられませんでした`,
    detail: `いまの版は ${app.getVersion()} のままです。画面右下の saboro のアイコンを右クリックして「終了」を選んでから、ダウンロードのページの saboro-${e.to}-win-x64.exe を実行してください。設定や資料はそのまま残ります。`
  });
  if (r.response === 0) shell.openExternal(releasePage);
  else if (r.response === 1) shell.openPath(updateLogFile);
}
const releasePage = 'https://github.com/Peyangpiece/SaBoRo/releases/latest',
  macDownloadPage = 'https://saboro-site.hrk-6888.workers.dev/download/mac';
const isNewer = (a, b) => {
  const x = String(a).split('.').map(Number),
    y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
};
// 新しい版を知らせる：メニューバーに「新しい版 <版> に更新」を出し、案内の画面は版ごとに 1 回出す（続けて新しい版が出たら、その版の案内も出す）。
// 常駐アプリは前面にないため、そのまま出すと案内の画面がほかのアプリの裏に隠れることがある。saboro を前面に出してから出す
// Mac：入れ終わった saboro の .dmg を取り出してゴミ箱に入れる（いまの版より新しいものは残す。結果は更新の記録へ）
function cleanupMacInstallers() {
  const exec = promisify(execFile);
  cleanupInstallers({
    current: app.getVersion(),
    downloads: app.getPath('downloads'),
    appPath: app.getAppPath(),
    run: async (cmd, args) => (await exec(cmd, args)).stdout,
    list: readdir,
    trash: f => shell.trashItem(f),
    log: updateLog
  }).catch(e => updateLog('WARN', 'インストーラーを片付けられません', e?.message || e));
}
async function announce(version, manual = false) {
  newer = version;
  refreshTray();
  const file = join(userData, 'update-notified.json');
  let seen = {};
  try {
    seen = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  if (!manual && seen.version === version) return;
  try {
    writeFileSync(file, JSON.stringify({version, at: new Date().toISOString()}));
  } catch {}
  app.focus({steal: true});
  const r = await dialog.showMessageBox({
    type: 'info',
    buttons: ['今すぐ更新', 'あとで'],
    defaultId: 0,
    cancelId: 1,
    message: `saboro の新しい版 ${version} があります`,
    detail: `いまの版は ${app.getVersion()} です。「今すぐ更新」を押すと、新しい版をダウンロードし、saboro をいったん終了して入れ替えてから、自動で開き直します（ダウンロードに数分かかることがあります）。設定や資料はそのまま残ります。あとで更新するときは、メニューバーの saboro から「新しい版 ${version} に更新」を選べます。`
  });
  if (r.response === 0) downloadMacUpdate(version);
}
// Mac：「更新」を押したらすぐ、新しい版の .dmg を「ダウンロード」フォルダに落とし（進み具合はメニューバーに出す）、saboro を終了して自動で入れ替え、開き直す（mac-update.js）。
// 「アプリケーション」以外の書き込めない場所で動いているときは、.dmg を開いて手動の入れ替えを案内する。落とせなければダウンロードのページを案内する
const macFs = {
  exists: async f => existsSync(f),
  write: (f, body, onChunk) =>
    pipeline(
      Readable.fromWeb(body),
      async function* (src) {
        for await (const c of src) {
          onChunk(c.length);
          yield c;
        }
      },
      createWriteStream(f)
    ),
  rename: (a, b) => rename(a, b),
  remove: f => rm(f, {force: true}),
  hash: async f => {
    const h = createHash('sha512');
    for await (const c of createReadStream(f)) h.update(c);
    return h.digest('base64');
  }
};
async function downloadMacUpdate(version) {
  if (downloading) return;
  downloading = {version, pct: null};
  refreshTray();
  let file;
  const sha512 = installerDigest(updateFiles[version], macInstallerName(version, process.arch));
  try {
    file = await downloadInstaller({
      version,
      arch: process.arch,
      downloads: app.getPath('downloads'),
      sha512,
      fetch: u => net.fetch(u),
      fs: macFs,
      onProgress: p => {
        const pct = p == null ? null : Math.floor(p * 100);
        if (downloading && pct !== downloading.pct) {
          downloading.pct = pct;
          refreshTray();
        }
      }
    });
    updateLog('INFO', `${basename(file)} をダウンロードしました`);
  } catch (e) {
    updateLog('ERROR', '新しい版をダウンロードできません', e?.message || e);
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['ダウンロードのページを開く', '閉じる'],
      defaultId: 0,
      cancelId: 1,
      message: `新しい版 ${version} をダウンロードできませんでした`,
      detail:
        'インターネットへの接続を確かめて、メニューバーの saboro から「新しい版をダウンロード」をもう一度お試しください。ダウンロードのページから入れることもできます。'
    });
    if (r.response === 0) shell.openExternal(macDownloadPage);
    return;
  } finally {
    downloading = null;
    refreshTray();
  }
  const bundle = appBundle(app.getPath('exe')),
    writable = d => {
      try {
        accessSync(d, fsConstants.W_OK);
        return true;
      } catch {
        return false;
      }
    };
  if (canReplace(bundle, writable)) {
    expectUpdate(version);
    try {
      spawn('/bin/sh', ['-c', replaceScript, 'sh', String(process.pid), file, bundle, version, updateLogFile, sha512], {
        detached: true,
        stdio: 'ignore'
      }).unref();
      app.quit();
      return;
    } catch (e) {
      updateLog('ERROR', '自動で入れ替えられません', e?.message || e);
      try {
        unlinkSync(expectFile);
      } catch {}
    }
  } else
    updateLog('INFO', `${bundle || app.getPath('exe')} は自動で入れ替えられない場所のため、手動の手順を案内します`);
  const opened = await shell.openPath(file);
  if (opened) updateLog('WARN', `${basename(file)} を開けません`, opened);
  const r = await dialog.showMessageBox({
    type: 'info',
    buttons: ['saboro を終了する', 'あとで'],
    defaultId: 0,
    cancelId: 1,
    message: `新しい版 ${version} をダウンロードしました`,
    detail: `開いたウインドウで、saboro のアイコンを「Applications（アプリケーション）」にドラッグして入れ替えてください。入れ替えるには、先に saboro を終了します。設定や資料はそのまま残ります。ウインドウを閉じてしまったときは、「ダウンロード」フォルダの ${basename(file)} を開き直してください。`
  });
  if (r.response === 0) app.quit();
}
// Windows：新しい版のダウンロードが終わったら、メニューに「再起動して更新」を出し、今すぐ入れ替えるかを版ごとに 1 回だけ聞く
// 「あとで」でも、終了するとき（メニューの「終了」）に入れ替わる。1 時間ごとの確認でもダウンロード済みとして届くので、2 回目からは聞かない
async function offerInstall(version, manual = false) {
  if (!isNewer(version, app.getVersion())) return;
  prepared = version;
  refreshTray();
  const file = join(userData, 'update-ready.json');
  let seen = '';
  try {
    seen = JSON.parse(readFileSync(file, 'utf8')).version;
  } catch {}
  if (seen === version && !manual) return;
  try {
    writeFileSync(file, JSON.stringify({version}));
  } catch {}
  const r = await dialog.showMessageBox({
    type: 'info',
    buttons: ['今すぐ再起動して更新', 'あとで'],
    defaultId: 0,
    cancelId: 1,
    message: `新しい版 ${version} の準備ができました。今すぐ再起動して更新しますか？`,
    detail: `いまの版は ${app.getVersion()} です。更新すると saboro がいったん閉じて、数秒後に自動で開き直します。設定や資料はそのまま残ります。あとで更新するときは、画面右下の saboro のアイコンを右クリックして「再起動して ${version} に更新」を選ぶか、「終了」を選んでください。`
  });
  if (r.response === 0) installNow();
}
// 2 つ目に起動したときは、1 つ目の画面を前に出すだけで終わる（app.quit() はすぐには終わらないため、その間に start が動くと、1 つ目が使っているポートで「起動に失敗」と出る）
if (single) {
  app.on('second-instance', focusWindow);
  app.on('window-all-closed', () => {});
  app.on('activate', focusWindow);
  app.whenReady().then(start);
}
