// OS ごとの処理をまとめる。デスクトップアプリ（Electron）から使うときは globalThis.saboroPlatform で差し替える
import {execFile, execFileSync, spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join, dirname, basename} from 'node:path';
import {mkdir, rename, access, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === 'win32';
// PowerShell を引数で安全に呼ぶ（パスは引数として渡し、スクリプトに埋め込まない）
const ps = (script, args = [], opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script, ...args],
      {windowsHide: true, ...opts},
      (e, out, err) => (e ? reject(Error(String(err || e.message).trim())) : resolve(String(out).trim()))
    )
  );
// 秘密の保存：macOS はキーチェーン補助、Windows は DPAPI（同じ利用者だけが復号できる）で暗号化したファイル
const macSecrets = {
  get(name) {
    try {
      return execFileSync(join(repo, 'local/keychain'), [], {
        input: JSON.stringify({op: 'get', name}),
        stdio: ['pipe', 'pipe', 'pipe']
      }).toString();
    } catch {
      return null;
    }
  },
  set(name, value) {
    try {
      execFileSync(join(repo, 'local/keychain'), [], {
        input: JSON.stringify({op: 'set', name, value}),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return '';
    } catch {
      return null;
    }
  }
};
function winSecrets(dir = join(process.env.APPDATA || homedir(), 'saboro')) {
  const file = name => join(dir, 'secret-' + name.replace(/[^a-z0-9-]/gi, '_') + '.bin');
  return {
    get(name) {
      try {
        const data = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes($args[0]); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))',
            file(name)
          ],
          {windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']}
        ).toString();
        return data.replace(/\r?\n$/, '') || null;
      } catch {
        return null;
      }
    },
    set(name, value) {
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Add-Type -AssemblyName System.Security; New-Item -ItemType Directory -Force -Path (Split-Path $args[0]) | Out-Null; $p=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($args[1]),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllBytes($args[0],$p)',
            file(name),
            value
          ],
          {windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']}
        );
        return '';
      } catch {
        return null;
      }
    }
  };
}
// ファイルを既定のアプリで開く
function openPath(file) {
  if (win)
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start', '""', file], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true
    }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], {stdio: 'ignore', detached: true}).unref();
}
// ダウンロードしたファイルに「インターネットから来たもの」の印を付ける（macOS は検疫属性、Windows は Zone.Identifier）。ブラウザで落としたときと同じく、開くときに OS が確かめる
async function quarantine(file) {
  if (win) {
    try {
      await writeFile(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n');
    } catch {}
    return;
  }
  if (process.platform !== 'darwin') return;
  await new Promise(r =>
    execFile(
      '/usr/bin/xattr',
      ['-w', 'com.apple.quarantine', `0083;${Math.floor(Date.now() / 1000).toString(16)};saboro;`, file],
      () => r()
    )
  );
}
// ゴミ箱へ移す：macOS は ~/.Trash、Windows はごみ箱（できなければ ~/saboro-trash）
async function trash(file, {home = homedir()} = {}) {
  if (win) {
    try {
      await ps(
        'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($args[0],"OnlyErrorDialogs","SendToRecycleBin")',
        [file]
      );
      return 'recycle-bin';
    } catch {
      return moveAside(file, join(home, 'saboro-trash'));
    }
  }
  return moveAside(file, join(home, '.Trash'));
}
async function moveAside(file, dir) {
  await mkdir(dir, {recursive: true});
  const name = basename(file),
    ext = name.match(/\.[^.]+$/)?.[0] || '',
    stem = name.slice(0, name.length - ext.length);
  let target = join(dir, name),
    n = 2;
  while (true) {
    try {
      await access(target);
      target = join(dir, `${stem} ${n++}${ext}`);
    } catch {
      break;
    }
  }
  await rename(file, target);
  return target;
}
// フォルダを選ぶ画面：Windows は FolderBrowserDialog。macOS は download-dir.js の pickFolder（osascript）
async function pickFolderWin(current) {
  const out = await ps(
    'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description="saboro：資料のダウンロード先のフォルダを選んでください"; if($args[0]){$d.SelectedPath=$args[0]}; if($d.ShowDialog() -eq "OK"){$d.SelectedPath}',
    [current || homedir()],
    {timeout: 300000}
  );
  return out || null;
}
// OS の通知（授業開始の同期で資料を保存したとき・出席コードの入力が出たとき）。Mac は osascript の display notification。文言は引数で渡し、スクリプトに埋め込まない
export function notifyMac(title, body, run = execFile) {
  return new Promise(resolve => {
    run(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        String(title).slice(0, 100),
        String(body).slice(0, 200)
      ],
      {timeout: 10000},
      () => resolve()
    );
  });
}
export function defaultPlatform() {
  return {
    name: process.platform,
    secrets: win ? winSecrets() : macSecrets,
    openPath,
    trash,
    quarantine,
    pickFolder: win ? pickFolderWin : null,
    notify: process.platform === 'darwin' ? notifyMac : null,
    restart: null,
    version: process.env.COURSECUE_VERSION || ''
  };
}
// デスクトップアプリは自分の組（globalThis.saboroPlatform）で上書きする。そこにないもの（quarantine など）は既定の処理を使う
export const platform = globalThis.saboroPlatform
  ? {...defaultPlatform(), ...globalThis.saboroPlatform}
  : defaultPlatform();
