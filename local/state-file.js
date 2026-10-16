import {readFile, writeFile, rename, copyFile, unlink} from 'node:fs/promises';
// 状態ファイル（state.json）の読み書き。書き込みは一時ファイルに書いてから置き換える（書いている途中で終了しても、前の内容か新しい内容のどちらかが必ず残る）
// 以前は state.json を直接書き換えていたため、更新での入れ替えなどで書き込み中に終了すると中身が途中で切れ、次の起動で読めずに空の状態から始め直していた（削除した授業が戻るなど）
// Windows ではウイルス対策などが一瞬ファイルを開いていると置き換えに失敗するので、少し待って数回やり直す
async function replace(tmp, file) {
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file);
      return;
    } catch (e) {
      if (i >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      await new Promise(r => setTimeout(r, 50 * (i + 1)));
    }
  }
}
export function stateFile(file) {
  let writing = Promise.resolve(),
    n = 0;
  return {
    // 読めないときは壊れたファイルを残して null を返す（呼び出し側が空の状態から始める）
    async load() {
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        await copyFile(file, file.replace(/\.json$/, '') + `-broken-${Date.now()}.json`).catch(() => {});
        return null;
      }
    },
    // 書き込みは順番に行う（同時に書いて古い内容で上書きしないように）。呼ばれた時点の内容を書く
    save(value) {
      const data = JSON.stringify(value, null, 2),
        tmp = `${file}.${process.pid}.${++n}.tmp`;
      const p = writing.then(async () => {
        await writeFile(tmp, data, {mode: 0o600});
        await replace(tmp, file);
      });
      writing = p.catch(() => {});
      return p;
    }
  };
}
