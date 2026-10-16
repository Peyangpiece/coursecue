import {basename} from 'node:path';
// Mac：使い終わった saboro のインストーラー（.dmg）を片付ける。起動時に、いまの版以下の saboro-<版>-mac-<CPU>.dmg を
// 取り出して（マウントを外して）から「ダウンロード」フォルダのものをゴミ箱に入れる。いまの版より新しいもの（まだ入れていないもの）は残す
// 名前は配布物の形（ブラウザーが重ねて保存したときの「 (1)」付きも含む）だけを対象にし、ほかのファイルには触れない
const pattern = /^saboro-(\d+\.\d+\.\d+)-mac-(?:arm64|x64)(?: \(\d+\))?\.dmg$/;
const older = (a, b) => {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return true;
};
export function usedInstaller(name, current) {
  const m = pattern.exec(name);
  return !!m && older(m[1], current);
}
// hdiutil info の出力から、マウント中のイメージのファイル・ディスク・マウント先を読む
export function mountedImages(info) {
  return String(info)
    .split(/^=+$/m)
    .map(block => {
      const image = /^image-path\s*:\s*(.+)$/m.exec(block)?.[1].trim(),
        disk = /^(\/dev\/disk\d+)\s/m.exec(block)?.[1],
        mounts = [...block.matchAll(/^\/dev\/disk\d+s?\d*\t[^\t]*\t(\/.+)$/gm)].map(m => m[1].trim());
      return image && disk ? {image, disk, mounts} : null;
    })
    .filter(Boolean);
}
// run：コマンドを実行して出力を返す。list：フォルダのファイル名。trash：ゴミ箱に入れる。appPath：動いているアプリの場所（.dmg から直接開いているときはそのイメージに触れない）
export async function cleanupInstallers({current, downloads, appPath, run, list, trash, log = () => {}}) {
  const inUse = new Set();
  for (const m of mountedImages(await run('/usr/bin/hdiutil', ['info']).catch(() => ''))) {
    if (!usedInstaller(basename(m.image), current)) continue;
    if (m.mounts.some(p => appPath.startsWith(p + '/'))) {
      inUse.add(m.image);
      continue;
    }
    try {
      await run('/usr/bin/hdiutil', ['detach', m.disk, '-quiet']);
      log('INFO', `${basename(m.image)} を取り出しました`);
    } catch (e) {
      inUse.add(m.image);
      log('WARN', `${basename(m.image)} を取り出せません`, e?.message || e);
    }
  }
  let names = [];
  try {
    names = await list(downloads);
  } catch {
    return;
  }
  for (const name of names) {
    const file = `${downloads}/${name}`;
    if (!usedInstaller(name, current) || inUse.has(file)) continue;
    try {
      await trash(file);
      log('INFO', `${name} をゴミ箱に入れました`);
    } catch (e) {
      log('WARN', `${name} をゴミ箱に入れられません`, e?.message || e);
    }
  }
}
