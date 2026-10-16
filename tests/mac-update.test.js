import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  macInstallerName,
  macInstallerUrl,
  installerDigest,
  downloadInstaller,
  appBundle,
  canReplace,
  replaceScript
} from '../desktop/mac-update.js';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {usedInstaller} from '../desktop/installer-cleanup.js';
// Mac：「ダウンロード」を押したらアプリ自身が新しい版の .dmg を落とす。名前は配布物と同じにして、入れ替えたあとの片付けの対象にする
// 落としたものは Release の版の情報（latest-mac.yml）の sha512 で確かめる。確かめられない .dmg は使わない
const sha = s => createHash('sha512').update(s).digest('base64');
const body = chunks =>
  new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
      c.close();
    }
  });
function fakeFs(existing = []) {
  const files = new Map(existing.map(f => (Array.isArray(f) ? f : [f, 'old']))),
    calls = [];
  return {
    files,
    calls,
    fs: {
      exists: async f => files.has(f),
      hash: async f => sha(files.get(f)),
      write: async (f, stream, onChunk) => {
        calls.push('write ' + f);
        let s = '';
        for await (const c of stream) {
          onChunk(c.length);
          s += new TextDecoder().decode(c);
        }
        files.set(f, s);
      },
      rename: async (a, b) => {
        calls.push(`rename ${a} → ${b}`);
        files.set(b, files.get(a));
        files.delete(a);
      },
      remove: async f => {
        calls.push('remove ' + f);
        files.delete(f);
      }
    }
  };
}
const res = (chunks, {status = 200, length} = {}) => ({
  ok: status < 300,
  status,
  headers: new Headers(
    length === undefined
      ? {'content-length': String(chunks.join('').length)}
      : length
        ? {'content-length': String(length)}
        : {}
  ),
  body: body(chunks)
});
test('名前と URL は配布物と同じ（Apple シリコンは arm64、それ以外は x64）。落としたものは入れ替えたあと片付けの対象になる', () => {
  assert.equal(macInstallerName('1.0.30', 'arm64'), 'saboro-1.0.30-mac-arm64.dmg');
  assert.equal(macInstallerName('1.0.30', 'x64'), 'saboro-1.0.30-mac-x64.dmg');
  assert.equal(
    macInstallerUrl('1.0.30', 'arm64'),
    'https://github.com/Peyangpiece/SaBoRo/releases/download/v1.0.30/saboro-1.0.30-mac-arm64.dmg'
  );
  assert.equal(usedInstaller(macInstallerName('1.0.30', 'arm64'), '1.0.30'), true);
  assert.equal(
    usedInstaller(macInstallerName('1.0.30', 'arm64') + '.download', '1.0.30'),
    false,
    '途中のものは片付けない'
  );
});
test('版の情報（latest-mac.yml の files）から、この .dmg の sha512 を取り出す。名前だけでも URL でもよく、形が違う値や該当なしは null', () => {
  const d = sha('x');
  assert.equal(
    installerDigest(
      [
        {url: 'saboro-1.0.30-mac.zip', sha512: sha('z')},
        {url: 'saboro-1.0.30-mac-arm64.dmg', sha512: d}
      ],
      'saboro-1.0.30-mac-arm64.dmg'
    ),
    d
  );
  assert.equal(
    installerDigest(
      [{url: 'https://github.com/Peyangpiece/SaBoRo/releases/download/v1.0.30/saboro-1.0.30-mac-x64.dmg', sha512: d}],
      'saboro-1.0.30-mac-x64.dmg'
    ),
    d
  );
  assert.equal(
    installerDigest([{url: 'saboro-1.0.30-mac-x64.dmg', sha512: d}], 'saboro-1.0.30-mac-arm64.dmg'),
    null,
    '別の CPU の値は使わない'
  );
  assert.equal(
    installerDigest([{url: 'saboro-1.0.30-mac-arm64.dmg', sha512: 'abc'}], 'saboro-1.0.30-mac-arm64.dmg'),
    null,
    'sha512 の形でなければ使わない'
  );
  assert.equal(installerDigest(undefined, 'saboro-1.0.30-mac-arm64.dmg'), null);
});
test('「ダウンロード」フォルダに .download の名前で落とし、sha512 を確かめてから .dmg にする。進み具合を 0〜1 で知らせる', async () => {
  const {files, calls, fs} = fakeFs(),
    progress = [],
    urls = [];
  const file = await downloadInstaller({
    version: '1.0.30',
    arch: 'arm64',
    downloads: '/Users/me/Downloads',
    sha512: sha('abcdef'),
    fs,
    fetch: async u => {
      urls.push(u);
      return res(['abc', 'def']);
    },
    onProgress: p => progress.push(p)
  });
  assert.equal(file, '/Users/me/Downloads/saboro-1.0.30-mac-arm64.dmg');
  assert.deepEqual(urls, [macInstallerUrl('1.0.30', 'arm64')]);
  assert.equal(files.get(file), 'abcdef');
  assert.deepEqual(calls, [
    'write /Users/me/Downloads/saboro-1.0.30-mac-arm64.dmg.download',
    'rename /Users/me/Downloads/saboro-1.0.30-mac-arm64.dmg.download → /Users/me/Downloads/saboro-1.0.30-mac-arm64.dmg'
  ]);
  assert.deepEqual(progress, [0, 0.5, 1]);
});
test('すでに落としてあるものは、sha512 が合うときだけそのまま使う。合わなければ消して落とし直す（「ダウンロード」フォルダはほかのアプリも書ける）。大きさが分からなければ進み具合は null', async () => {
  let {fs, calls} = fakeFs([['/d/saboro-1.0.30-mac-x64.dmg', 'good']]);
  let fetched = 0;
  assert.equal(
    await downloadInstaller({
      version: '1.0.30',
      arch: 'x64',
      downloads: '/d',
      sha512: sha('good'),
      fs,
      fetch: async () => {
        fetched++;
      }
    }),
    '/d/saboro-1.0.30-mac-x64.dmg'
  );
  assert.equal(fetched, 0);
  assert.deepEqual(calls, []);
  ({fs, calls} = fakeFs([['/d/saboro-1.0.30-mac-x64.dmg', 'tampered']]));
  const files = fs;
  assert.equal(
    await downloadInstaller({
      version: '1.0.30',
      arch: 'x64',
      downloads: '/d',
      sha512: sha('ab'),
      fs,
      fetch: async () => res(['ab'])
    }),
    '/d/saboro-1.0.30-mac-x64.dmg'
  );
  assert.equal(calls[0], 'remove /d/saboro-1.0.30-mac-x64.dmg', '合わないものは先に消す');
  assert.equal(await files.hash('/d/saboro-1.0.30-mac-x64.dmg'), sha('ab'));
  ({fs} = fakeFs());
  const progress = [];
  await downloadInstaller({
    version: '1.0.30',
    arch: 'x64',
    downloads: '/d',
    sha512: sha('ab'),
    fs,
    fetch: async () => res(['ab'], {length: 0}),
    onProgress: p => progress.push(p)
  });
  assert.deepEqual(progress, [null, null]);
});
test('失敗（見つからない・途中で切れた・sha512 が合わない・sha512 がない）は理由を投げ、途中のファイルは消す（.dmg は作らない）', async () => {
  let {files, fs} = fakeFs();
  await assert.rejects(
    downloadInstaller({
      version: '9.9.9',
      arch: 'arm64',
      downloads: '/d',
      sha512: sha('x'),
      fs,
      fetch: async () => res([], {status: 404})
    }),
    /ダウンロードできませんでした（404）/
  );
  assert.equal(files.size, 0);
  ({files, fs} = fakeFs());
  await assert.rejects(
    downloadInstaller({
      version: '1.0.30',
      arch: 'arm64',
      downloads: '/d',
      sha512: sha('abc'),
      fs,
      fetch: async () => res(['abc'], {length: 10})
    }),
    /途中で切れました/
  );
  assert.equal(files.size, 0);
  ({files, fs} = fakeFs());
  await assert.rejects(
    downloadInstaller({
      version: '1.0.30',
      arch: 'arm64',
      downloads: '/d',
      sha512: sha('abc'),
      fs,
      fetch: async () => res(['abd'])
    }),
    /配布物と一致しません/
  );
  assert.equal(files.size, 0, '合わないものは .dmg にしない');
  ({files, fs} = fakeFs());
  let fetched = 0;
  await assert.rejects(
    downloadInstaller({
      version: '1.0.30',
      arch: 'arm64',
      downloads: '/d',
      sha512: null,
      fs,
      fetch: async () => {
        fetched++;
      }
    }),
    /sha512/
  );
  assert.equal(fetched, 0, '確かめられないものは落とさない');
});
test('アプリ：新しい版の案内とメニューバーの「更新」は、その場でダウンロードし、書き込める場所なら終了して自動で入れ替える（できなければ .dmg を開いて案内）。版の情報の sha512 を落とすときと入れ替えのスクリプトに渡す', () => {
  const main = readFileSync('desktop/main.js', 'utf8');
  assert.match(main, /buttons:\['今すぐ更新','あとで'\][^\n]*if\(r\.response===0\)downloadMacUpdate\(version\)/);
  assert.match(main, /label:`新しい版 \$\{newer\} に更新`,click:\(\)=>downloadMacUpdate\(newer\)/);
  assert.match(main, /updateFiles\[v\]=r\.updateInfo\.files/, '確認した版の配布物の情報を覚える');
  assert.match(
    main,
    /const sha512=installerDigest\(updateFiles\[version\],macInstallerName\(version,process\.arch\)\)/
  );
  assert.match(main, /downloadInstaller\(\{version,arch:process\.arch,downloads:app\.getPath\('downloads'\),sha512,/);
  assert.match(main, /hash:async f=>\{const h=createHash\('sha512'\)/, '落としたファイルの sha512 を出す');
  assert.match(main, /ダウンロード中…/, 'ダウンロード中はメニューバーに進み具合を出す');
  assert.match(
    main,
    /if\(canReplace\(bundle,writable\)\)\{expectUpdate\(version\);[^\n]*spawn\('\/bin\/sh',\['-c',replaceScript,'sh',String\(process\.pid\),file,bundle,version,updateLogFile,sha512\],\{detached:true,stdio:'ignore'\}\)\.unref\(\);app\.quit\(\)/
  );
  assert.match(main, /shell\.openPath\(file\)/, '自動で入れ替えられなければ .dmg を開く');
  assert.match(main, /macDownloadPage/, '落とせなければダウンロードのページを案内する');
  assert.match(main, /自動で入れ替えられませんでした/, '入れ替わらなかったら次の起動で手動の手順を案内する');
});
test('自動で入れ替えられる場所：「アプリケーション」など書き込める場所だけ（.dmg の中・移動せずに開いた場所・書き込めない場所は不可）', () => {
  const all = () => true;
  assert.equal(appBundle('/Applications/saboro.app/Contents/MacOS/saboro'), '/Applications/saboro.app');
  assert.equal(appBundle('/usr/bin/node'), null);
  assert.equal(canReplace('/Applications/saboro.app', all), true);
  assert.equal(canReplace('/Users/me/Applications/saboro.app', all), true);
  assert.equal(canReplace('/Volumes/saboro 1.0.30/saboro.app', all), false);
  assert.equal(canReplace('/private/var/folders/x/T/AppTranslocation/ABC/d/saboro.app', all), false);
  assert.equal(canReplace(null, all), false);
  assert.equal(
    canReplace('/Applications/saboro.app', d => d !== '/Applications'),
    false,
    '置き場所に書き込めない（管理者でない利用者など）'
  );
  assert.equal(
    canReplace('/Applications/saboro.app', d => d !== '/Applications/saboro.app'),
    false
  );
});
// 入れ替えのスクリプトを、hdiutil・PlistBuddy・ditto・open・codesign を差し替えて実際に動かす（.dmg の中身はフォルダで代用。sha512 は本物の openssl で確かめる）
// Info.plist は「キー=値」の行で代用し、PlistBuddy の代わりはそのキーの値を返す。codesign の代わりは、--verify は通し、-dvv は app の中の authority ファイル（証明書の Authority 行）を返す
const plist = (version, id = 'jp.coursecue.saboro') =>
  `CFBundleShortVersionString=${version}\nCFBundleIdentifier=${id}\n`;
function sandbox({
  dmgVersion = '1.0.30',
  dmgId = 'jp.coursecue.saboro',
  dmgData = '',
  sum = sha(''),
  authority = '',
  newAuthority = authority
} = {}) {
  const d = mkdtempSync(join(tmpdir(), 'saboro-replace-')),
    bin = join(d, 'bin'),
    calls = join(d, 'calls.txt'),
    log = join(d, 'update.log'),
    image = join(d, 'image'),
    app = join(d, 'Applications', 'saboro.app');
  for (const dir of [
    bin,
    join(image, 'saboro.app', 'Contents'),
    join(image, 'other.app', 'Contents'),
    join(app, 'Contents')
  ])
    mkdirSync(dir, {recursive: true});
  writeFileSync(join(image, 'saboro.app', 'Contents', 'Info.plist'), plist(dmgVersion, dmgId));
  writeFileSync(join(image, 'other.app', 'Contents', 'Info.plist'), plist('9.9.9', 'jp.example.other'));
  writeFileSync(join(app, 'Contents', 'Info.plist'), plist('1.0.29'));
  if (authority) writeFileSync(join(app, 'Contents', 'authority'), authority);
  if (newAuthority) writeFileSync(join(image, 'saboro.app', 'Contents', 'authority'), newAuthority);
  writeFileSync(join(d, 'saboro-1.0.30-mac-arm64.dmg'), dmgData);
  const stub = (name, body) => {
    const f = join(bin, name);
    writeFileSync(f, '#!/bin/sh\n' + body + '\n');
    chmodSync(f, 0o755);
    return f;
  };
  const env = {
    ...process.env,
    TMPDIR: d,
    WAIT: '20',
    HDIUTIL: stub(
      'hdiutil',
      `echo "hdiutil $1" >> "${calls}"; if [ "$1" = attach ]; then cp -R "${image}/." "$6"; else rm -rf "$2"/*; fi`
    ),
    PLIST: stub('plist', 'key=${2#Print :}; sed -n "s/^$key=//p" "$3"'),
    DITTO: stub('ditto', 'cp -R "$1" "$2"'),
    OPEN: stub('open', `echo "open $1" >> "${calls}"`),
    XATTR: stub('xattr', 'true'),
    CODESIGN: stub('codesign', 'if [ "$1" = --verify ]; then exit 0; fi; cat "$2/Contents/authority" 2>/dev/null; true')
  };
  const run = pid =>
    execFileSync(
      '/bin/sh',
      ['-c', replaceScript, 'sh', String(pid), join(d, 'saboro-1.0.30-mac-arm64.dmg'), app, '1.0.30', log, sum],
      {env, encoding: 'utf8'}
    );
  const read = f => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return {
    d,
    app,
    run,
    calls: () => read(calls).trim().split('\n').filter(Boolean),
    log: () => read(log),
    version: () => read(join(app, 'Contents', 'Info.plist')).match(/CFBundleShortVersionString=(.*)/)[1]
  };
}
const untouched = s => {
  assert.equal(s.version(), '1.0.29');
  assert.deepEqual(readdirSync(join(s.d, 'Applications')), ['saboro.app']);
  assert.equal(
    readdirSync(s.d).some(f => f.startsWith('saboro-update.')),
    false,
    '作業用のものは残さない'
  );
};
test('入れ替えのスクリプト：saboro の終了を待ってから、.dmg の sha512 を確かめ、同じ CFBundleIdentifier の saboro を新しい版に入れ替えて開き直す（作業用のものは残さない）', () => {
  const s = sandbox();
  const pid = execFileSync('/bin/sh', ['-c', 'sleep 1 >/dev/null 2>&1 & echo $!'], {encoding: 'utf8'}).trim();
  const t = Date.now();
  s.run(pid);
  assert.ok(Date.now() - t >= 500, '終了を待つ');
  assert.equal(s.version(), '1.0.30');
  assert.deepEqual(s.calls(), ['hdiutil attach', 'hdiutil detach', `open ${s.app}`]);
  assert.match(s.log(), /INFO\t1\.0\.30 に入れ替えました/);
  assert.deepEqual(readdirSync(join(s.d, 'Applications')), ['saboro.app'], '.new・.old は残さない');
  assert.equal(
    readdirSync(s.d).some(f => f.startsWith('saboro-update.')),
    false,
    'つないだ場所も片付ける'
  );
});
test('入れ替えのスクリプト：.dmg の中身が別の版なら入れ替えず、元の saboro を開き直して理由を記録する', () => {
  const s = sandbox({dmgVersion: '1.0.28'});
  assert.throws(() => s.run(999999));
  untouched(s);
  assert.deepEqual(s.calls(), ['hdiutil attach', 'hdiutil detach', `open ${s.app}`]);
  assert.match(s.log(), /ERROR\t書き出した版が 1\.0\.30 ではありません（1\.0\.28）/);
});
test('入れ替えのスクリプト：.dmg の sha512 が配布物と合わなければ、つなぐ前に止めて元の saboro を開き直す（値がないときも同じ）', () => {
  let s = sandbox({dmgData: 'tampered'});
  assert.throws(() => s.run(999999));
  untouched(s);
  assert.deepEqual(s.calls(), [`open ${s.app}`], '.dmg をつながない');
  assert.match(s.log(), /ERROR\t\.dmg が配布物と一致しません/);
  s = sandbox({sum: ''});
  assert.throws(() => s.run(999999));
  untouched(s);
  assert.deepEqual(s.calls(), [`open ${s.app}`]);
  assert.match(s.log(), /ERROR\t\.dmg を確かめるための値がありません/);
});
test('入れ替えのスクリプト：.dmg の中に同じ CFBundleIdentifier の saboro がなければ入れ替えない（最初に見つかった .app を使わない）', () => {
  const s = sandbox({dmgId: 'jp.example.fake'});
  assert.throws(() => s.run(999999));
  untouched(s);
  assert.match(s.log(), /ERROR\t\.dmg の中に saboro（jp\.coursecue\.saboro）が見つかりません/);
});
test('入れ替えのスクリプト：いまの saboro が証明書で署名されていれば、別の証明書の新しい版には入れ替えない。同じ証明書なら入れ替える。ad-hoc どうしも入れ替える', () => {
  const a = 'Authority=saboro sign\nAuthority=saboro root';
  let s = sandbox({authority: a, newAuthority: 'Authority=someone else'});
  assert.throws(() => s.run(999999));
  untouched(s);
  assert.match(s.log(), /ERROR\t新しい版の署名（証明書）がいまの saboro と違います/);
  s = sandbox({authority: a, newAuthority: ''});
  assert.throws(() => s.run(999999));
  untouched(s);
  assert.match(s.log(), /いまの saboro と違います/, '証明書 → ad-hoc も不可');
  s = sandbox({authority: a});
  s.run(999999);
  assert.equal(s.version(), '1.0.30');
  s = sandbox({authority: '', newAuthority: a});
  s.run(999999);
  assert.equal(s.version(), '1.0.30', 'ad-hoc → 証明書は可');
});
test('Mac の新しい版の案内：版ごとに 1 回出す（前の版の案内から 24 時間待たない）。saboro を前面に出してから出す（ほかのアプリの裏に隠れないように）', () => {
  const main = readFileSync('desktop/main.js', 'utf8'),
    fn = main.slice(main.indexOf('async function announce('));
  assert.match(fn, /if\(!manual&&seen\.version===version\)return;/);
  assert.doesNotMatch(
    fn.slice(0, fn.indexOf('\n')),
    /24\*3600/,
    '別の版の案内のあと 24 時間は出さない、という制限はしない'
  );
  assert.match(fn, /app\.focus\(\{steal:true\}\);const r=await dialog\.showMessageBox/);
});
