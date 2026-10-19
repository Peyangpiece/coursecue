import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readdir, readFile, unlink, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {Manabo} from '../local/manabo.js';
import {checkDownloadDir, pickFolder, fileType, fileTypeOf} from '../local/download-dir.js';
test('ダウンロード先はホームフォルダ内の通常のフォルダだけ指定できる', () => {
  const home = '/Users/u';
  assert.equal(checkDownloadDir('', home), '');
  assert.equal(checkDownloadDir('~/Documents/授業資料', home), '/Users/u/Documents/授業資料');
  assert.equal(checkDownloadDir('/Users/u/Desktop/2026秋学期/', home), '/Users/u/Desktop/2026秋学期');
  for (const bad of ['/etc', '~/../other', '/Users/u/.ssh', '~/Library/LaunchAgents', 'Documents', '~/Desktop/../../x'])
    assert.throws(() => checkDownloadDir(bad, home), undefined, bad);
});
// manabo のファイル取得を模擬する（URLごとに中身が変わる）
function fakeManabo(root, state) {
  let gets = 0;
  const m = new Manabo({
    root,
    work: root,
    state,
    save: async () => {},
    credentials: async () => null,
    ai: async () => {}
  });
  m.page = async () => null;
  m.ctx = {
    request: {
      get: async url => {
        gets++;
        const n = url.match(/file\/(\d+)/)[1];
        return {
          ok: () => true,
          headers: () => ({
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`第${n}回_資料.pdf`)}`
          }),
          body: async () => Buffer.from('pdf ' + n)
        };
      }
    }
  };
  return {m, gets: () => gets};
}
const entry = n => ({url: `https://manabo.cnc.chukyo-u.ac.jp/file/${n}/`, text: `第${n}回 資料`});
test('まだダウンロードしていない資料だけを授業ごとのフォルダに保存し、フォルダを変えたら新しいフォルダに保存する', async t => {
  const base = await mkdtemp(join(tmpdir(), 'coursecue-dl-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const state = {tasks: [], materials: [], settings: {}};
  const {m, gets} = fakeManabo(join(base, '既定'), state);
  await m.download(entry(1), '管理会計Ⅱ');
  assert.deepEqual(await readdir(join(base, '既定', '管理会計Ⅱ')), ['第1回_資料.pdf'], '授業フォルダがなければ作る');
  await m.download(entry(1), '管理会計Ⅱ');
  assert.equal(gets(), 1, 'ダウンロード済みは取りに行かない');
  await unlink(join(base, '既定', '管理会計Ⅱ', '第1回_資料.pdf'));
  await m.download(entry(1), '管理会計Ⅱ');
  assert.equal(gets(), 1, '自分で消した資料はダウンロードし直さない');
  await m.download(entry(2), '管理会計Ⅱ');
  assert.deepEqual(await readdir(join(base, '既定', '管理会計Ⅱ')), ['第2回_資料.pdf']);
  state.settings.downloadDir = join(base, '新しい場所');
  await m.download(entry(2), '管理会計Ⅱ');
  assert.equal(await readFile(join(base, '新しい場所', '管理会計Ⅱ', '第2回_資料.pdf'), 'utf8'), 'pdf 2');
  assert.equal(state.materials.filter(x => x.url === entry(2).url).length, 1, '記録は新しい場所の1件だけ');
  await m.download(entry(2), '管理会計Ⅱ');
  assert.equal(gets(), 3);
});
// 授業ページの模擬：第1回（期間外）と第2回にファイルがある
const page = `<a id="button-logout">ログアウト</a><div class="breadcrumb">管理会計Ⅱ</div><div id="div-class-directories"><table><tr><td>第1回 イントロダクション</td></tr><tr><td><a class="a-open-contents" directory_id="d1" href="#">開く</a></td></tr><tr><td>第2回 原価企画</td></tr><tr><td><a class="a-open-contents" directory_id="d2" href="#">開く</a></td></tr></table></div><div id="div-class-contents"></div><script>for(const n of [1,2])document.querySelector('[directory_id=d'+n+']').onclick=e=>{e.preventDefault();document.getElementById('div-class-contents').innerHTML='<h3>第'+n+'回</h3><table><tr><td><a href="/file/'+n+'/">第'+n+'回 資料</a></td></tr></table>'}</script>`;
test('期間外の回の資料も、そのフォルダで初めての同期のときに一度だけ確認してダウンロードする', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  await ctx.route('**/*', r => r.fulfill({contentType: 'text/html; charset=utf-8', body: page}));
  const p = await ctx.newPage();
  const state = {
    tasks: [],
    materials: [],
    settings: {autoGenerate: false},
    schedules: {},
    courses: [{name: '管理会計Ⅱ', id: '103904'}]
  };
  const m = new Manabo({
    root: '/nonexistent',
    work: '/tmp',
    state,
    save: async () => {},
    credentials: async () => null,
    ai: async () => {}
  });
  m.ctx = ctx;
  m.page = async () => (m.p = p);
  m.cubics = async () => {};
  const got = [];
  m.download = async (e, course) => {
    got.push(course + ':' + e.url.match(/file\/(\d+)/)[1]);
  };
  await m.sync();
  assert(got.includes('管理会計Ⅱ:1') && got.includes('管理会計Ⅱ:2'), '初回は全回のファイルを確認');
  got.length = 0;
  await m.sync();
  assert.deepEqual(got, [], '2回目以降は期間外の回を開かない');
  state.settings.downloadDir = '/nonexistent2';
  await m.sync();
  assert(got.includes('管理会計Ⅱ:1'), 'フォルダを変えたらもう一度全回を確認');
});
test('Mac の「フォルダを選択」画面：選んだパスを返し、取り消しなら null。パスはスクリプトに埋め込まず引数で渡す', async () => {
  let args;
  const ok = (f, a, o, cb) => {
    args = a;
    cb(null, '/Users/u/Documents/授業資料/\n');
  };
  assert.equal(
    await pickFolder('/nonexistent"; do shell script "x', {run: ok, home: '/Users/u'}),
    '/Users/u/Documents/授業資料'
  );
  assert.equal(args.at(-1), '/Users/u', '存在しないフォルダならホームから開く');
  assert(!args.slice(0, -1).some(a => a.includes('/Users/u')), 'パスはスクリプトに含めない');
  const cancel = (f, a, o, cb) => {
    const e = Error('execution error: User canceled. (-128)');
    cb(e, '');
  };
  assert.equal(await pickFolder('', {run: cancel, home: '/Users/u'}), null);
});
test('Finder に選択画面を出させ、許可されなければ osascript 自身で出す', async () => {
  const calls = [];
  const run = (f, a, o, cb) => {
    calls.push(a.join('\n'));
    if (calls.length === 1) {
      const e = Error('Not authorized to send Apple events to Finder. (-1743)');
      return cb(e, '');
    }
    cb(null, '/Users/u/x/\n');
  };
  assert.equal(await pickFolder('', {run, home: '/Users/u'}), '/Users/u/x');
  assert(calls[0].includes('tell application "Finder"'));
  assert(!calls[1].includes('Finder'));
  assert.equal(calls.length, 2);
});
test('取り消したときは、もう一度画面を出さない', async () => {
  let n = 0;
  const run = (f, a, o, cb) => {
    n++;
    cb(Error('User canceled. (-128)'), '');
  };
  assert.equal(await pickFolder('', {run, home: '/Users/u'}), null);
  assert.equal(n, 1);
});
test('画面から開ける資料は、記録済みでダウンロード先の中にあるファイルだけ', async t => {
  const base = await mkdtemp(join(tmpdir(), 'coursecue-open-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const {openableMaterial} = await import('../local/download-dir.js');
  const state = {tasks: [], materials: [], settings: {}};
  const {m} = fakeManabo(join(base, '既定'), state);
  await m.download(entry(1), '管理会計Ⅱ');
  const id = state.materials[0].sha256;
  assert.equal(openableMaterial(state.materials, id, join(base, '既定')), state.materials[0].path);
  assert.equal(openableMaterial(state.materials, id, join(base, '別')), null, 'ダウンロード先の外は開かない');
  assert.equal(openableMaterial(state.materials, 'x'.repeat(64), join(base, '既定')), null);
  assert.equal(openableMaterial(state.materials, '../etc/passwd', join(base, '既定')), null);
  await unlink(state.materials[0].path);
  assert.equal(openableMaterial(state.materials, id, join(base, '既定')), null, '消したファイルは開かない');
});
test('保存した資料を本人が編集しても、同期で同じファイルをダウンロードし直さない', async t => {
  const base = await mkdtemp(join(tmpdir(), 'coursecue-edit-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const state = {tasks: [], materials: [], settings: {}};
  const {m, gets} = fakeManabo(join(base, '既定'), state);
  await m.download(entry(1), '管理会計Ⅱ');
  const file = join(base, '既定', '管理会計Ⅱ', '第1回_資料.pdf');
  await writeFile(file, 'pdf 1 本人のメモ');
  await m.download(entry(1), '管理会計Ⅱ');
  await m.download({...entry(1), text: '第1回 資料（改訂）'}, '管理会計Ⅱ');
  assert.equal(gets(), 1, '編集後も manabo の表記が変わっても取りに行かない');
  assert.deepEqual(await readdir(join(base, '既定', '管理会計Ⅱ')), ['第1回_資料.pdf'], '「(2)」の複製を作らない');
  assert.equal(await readFile(file, 'utf8'), 'pdf 1 本人のメモ', '編集した内容を上書きしない');
  // seed で取り込んだ記録（textHash なし）でも同じ
  state.materials = [
    {
      course: '管理会計Ⅱ',
      url: entry(2).url,
      name: '第2回_資料.pdf',
      path: join(base, '既定', '管理会計Ⅱ', '第2回_資料.pdf'),
      sha256: '0'.repeat(64)
    }
  ];
  await writeFile(state.materials[0].path, '編集済み');
  await m.download(entry(2), '管理会計Ⅱ');
  assert.equal(gets(), 1, '取り込んだ記録でも取りに行かない');
  assert.equal(await readFile(state.materials[0].path, 'utf8'), '編集済み');
});
test('以前に作ってしまった「(2)」の複製はゴミ箱へ移し、本人が編集した元のファイルや編集した複製には触れない', async t => {
  const base = await mkdtemp(join(tmpdir(), 'coursecue-dup-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const root = join(base, '既定'),
    state = {tasks: [], materials: [], settings: {}},
    trashed = [];
  const {m} = fakeManabo(root, state);
  m.trash = async f => {
    trashed.push(f);
    await unlink(f);
  };
  // 1：元を編集した後、旧ロジックが「(2)」を作った状態を再現
  await m.download(entry(1), '管理会計Ⅱ');
  const dir = join(root, '管理会計Ⅱ'),
    orig = join(dir, '第1回_資料.pdf'),
    dup = join(dir, '第1回_資料 (2).pdf');
  await writeFile(orig, 'pdf 1 本人のメモ');
  await writeFile(dup, 'pdf 1');
  state.materials.push({
    course: '管理会計Ⅱ',
    url: entry(1).url,
    name: '第1回_資料 (2).pdf',
    path: dup,
    sha256: state.materials[0].sha256
  });
  // 2：複製の方を本人が編集した（中身が記録と違う）→ 触れない
  await writeFile(join(dir, '第2回_資料.pdf'), 'pdf 2');
  await writeFile(join(dir, '第2回_資料 (2).pdf'), '編集した複製');
  state.materials.push({
    course: '管理会計Ⅱ',
    url: entry(2).url,
    name: '第2回_資料 (2).pdf',
    path: join(dir, '第2回_資料 (2).pdf'),
    sha256: '0'.repeat(64)
  });
  // 3：元のファイルがない「(2)」→ 触れない
  await writeFile(join(dir, '第3回_資料 (2).pdf'), 'pdf 3');
  state.materials.push({
    course: '管理会計Ⅱ',
    url: entry(3).url,
    name: '第3回_資料 (2).pdf',
    path: join(dir, '第3回_資料 (2).pdf'),
    sha256: (await import('../local/core.js')).hash(Buffer.from('pdf 3'))
  });
  const moved = await m.trashDuplicates();
  assert.deepEqual(moved, ['第1回_資料 (2).pdf']);
  assert.deepEqual(trashed, [dup]);
  assert.equal(await readFile(orig, 'utf8'), 'pdf 1 本人のメモ', '元のファイルは残す');
  assert.deepEqual((await readdir(dir)).sort(), [
    '第1回_資料.pdf',
    '第2回_資料 (2).pdf',
    '第2回_資料.pdf',
    '第3回_資料 (2).pdf'
  ]);
  assert.equal(state.materials.filter(x => x.url === entry(1).url).length, 1, '記録は元の1件だけ');
  assert.equal(state.materials.find(x => x.url === entry(1).url).path, orig);
  assert.equal(state.trashed.length, 1);
  assert.deepEqual(await m.trashDuplicates(), [], '2回目は何もしない');
});
test('ゴミ箱へ移すときは同名があっても上書きしない', async t => {
  const base = await mkdtemp(join(tmpdir(), 'coursecue-trash-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const {trashFile} = await import('../local/download-dir.js');
  await writeFile(join(base, 'a.pdf'), '1');
  const t1 = await trashFile(join(base, 'a.pdf'), {home: base});
  await writeFile(join(base, 'a.pdf'), '2');
  const t2 = await trashFile(join(base, 'a.pdf'), {home: base});
  assert.equal(t1, join(base, '.Trash', 'a.pdf'));
  assert.equal(t2, join(base, '.Trash', 'a 2.pdf'));
  assert.equal(await readFile(t1, 'utf8'), '1');
  assert.equal(await readFile(t2, 'utf8'), '2');
});
test('同じ資料の 4up・2up があれば 1up（印なし）だけをダウンロードし、1up がない組はそのまま', async () => {
  const {layoutOf, layoutBase, preferLayout} = await import('../local/download-dir.js');
  assert.equal(layoutOf('第3回ケース 対面（4up）.pdf'), 4);
  assert.equal(layoutOf('第3回 4in1.pdf'), 4);
  assert.equal(layoutOf('第12回 ４アップ.pdf'), 4);
  assert.equal(layoutOf('第3回ケース 対面.pptx'), 1);
  assert.equal(layoutOf('第3回 1up.pdf'), 1);
  assert.equal(layoutOf('第4回 upload.pdf'), 1, 'up で始まる語は印ではない');
  assert.equal(layoutOf('第2回 コーポレートファイナンスⅡ（資金調達①）_配布用（2分割バージョン）.pdf'), 2);
  assert.equal(layoutOf('第2回 コーポレートファイナンスⅡ（資金調達①）_配布用（4分割バージョン）.pdf'), 4);
  assert.equal(layoutOf('第2回 コーポレートファイナンスⅡ（資金調達①）_配布用（分割なしバージョン）.pdf'), 1);
  assert.equal(
    layoutBase('第2回 コーポレートファイナンスⅡ（資金調達①）_配布用（分割なしバージョン）.pdf'),
    layoutBase('第2回 コーポレートファイナンスⅡ（資金調達①）_配布用（4分割バージョン）.pdf'),
    '分割なし・2分割・4分割は同じ資料の形式違い'
  );
  assert.deepEqual(
    preferLayout([
      {name: '第2回 配布用（4分割バージョン）.pdf'},
      {name: '第2回 配布用（分割なしバージョン）.pdf'},
      {name: '第2回 配布用（2分割バージョン）.pdf'},
      {name: '第3回 配布用（2分割）.pdf'}
    ]).map(e => e.name),
    ['第2回 配布用（分割なしバージョン）.pdf', '第3回 配布用（2分割）.pdf'],
    '分割なしだけを保存し、分割なしがない組はそのまま'
  );
  assert.equal(layoutBase('第3回ケース 対面（4up）.pdf'), layoutBase('第3回ケース 対面.pptx'));
  const es = [
    {name: '第3回 4up.pdf'},
    {name: '第3回 2up.pdf'},
    {name: '第3回.pdf'},
    {name: '第4回 4up.pdf'},
    {name: '第5回 2up.pdf'},
    {name: '第5回 1up.pdf'}
  ];
  assert.deepEqual(
    preferLayout(es).map(e => e.name),
    ['第3回.pdf', '第4回 4up.pdf', '第5回 1up.pdf']
  );
});
test('同期では 1up だけを保存し、以前に保存した未編集の 4up はゴミ箱へ移す', async t => {
  const base = await mkdtemp(join(tmpdir(), 'coursecue-layout-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const root = join(base, '既定'),
    state = {tasks: [], materials: [], settings: {}},
    trashed = [];
  const {m, gets} = fakeManabo(root, state);
  m.trash = async f => {
    trashed.push(f);
    await unlink(f);
  };
  const files = [
    {url: 'https://manabo.cnc.chukyo-u.ac.jp/file/1/', name: '第1回 資料（4up）', text: ''},
    {url: 'https://manabo.cnc.chukyo-u.ac.jp/file/2/', name: '第1回 資料', text: ''},
    {url: 'https://manabo.cnc.chukyo-u.ac.jp/content/9/report/x/', name: '第1回 課題', text: ''}
  ];
  assert.deepEqual(
    m.wantedFiles(files).map(e => e.url),
    [files[1].url],
    '課題は含めず、4up は飛ばす'
  );
  // 以前の同期で 4up と 1up の両方を保存していた状態：未編集の 4up だけゴミ箱へ
  const dir = join(root, '管理会計Ⅱ');
  await mkdir(dir, {recursive: true});
  const {hash} = await import('../local/core.js');
  const four = join(dir, '第1回_資料 (4up).pdf'),
    one = join(dir, '第1回_資料.pdf'),
    edited = join(dir, '第2回_資料 2up.pdf'),
    only = join(dir, '第3回_資料 4up.pdf');
  await writeFile(four, '4up');
  await writeFile(one, '1up');
  await writeFile(edited, '編集した');
  await writeFile(only, '4up only');
  state.materials.push(
    {course: '管理会計Ⅱ', url: 'u1', name: '第1回_資料 (4up).pdf', path: four, sha256: hash(Buffer.from('4up'))},
    {course: '管理会計Ⅱ', url: 'u2', name: '第1回_資料.pdf', path: one, sha256: hash(Buffer.from('1up'))},
    {course: '管理会計Ⅱ', url: 'u3', name: '第2回_資料 2up.pdf', path: edited, sha256: hash(Buffer.from('元の2up'))},
    {course: '管理会計Ⅱ', url: 'u4', name: '第2回_資料.pdf', path: join(dir, '第2回_資料.pdf'), sha256: '0'.repeat(64)},
    {course: '管理会計Ⅱ', url: 'u5', name: '第3回_資料 4up.pdf', path: only, sha256: hash(Buffer.from('4up only'))}
  );
  assert.deepEqual(await m.trashDuplicates(), ['第1回_資料 (4up).pdf']);
  assert.deepEqual(trashed, [four]);
  assert.deepEqual((await readdir(dir)).sort(), ['第1回_資料.pdf', '第2回_資料 2up.pdf', '第3回_資料 4up.pdf']);
  assert(!state.materials.some(x => x.url === 'u1'), '記録も消す');
  assert.equal(gets(), 0);
});

// 画面の「資料」で開くのは書類・画像・音声・動画だけ。実行できるもの・書庫は開かない（manabo のリンクから開く）
test('「資料」で開けるのは書類・画像・音声・動画だけ。.command・.app・.exe・.sh・.zip などは開かない', async () => {
  const {openableMaterial, OPENABLE} = await import('../local/download-dir.js');
  const {mkdtemp, writeFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'saboro-open-'));
  try {
    const id = c => c.repeat(64),
      materials = [];
    for (const [n, c] of [
      ['資料.pdf', 'a'],
      ['資料.pptx', 'b'],
      ['配布.command', 'c'],
      ['ツール.exe', 'd'],
      ['run.sh', 'e'],
      ['資料.zip', 'f'],
      ['memo', '0'],
      ['写真.JPG', '1']
    ]) {
      const path = join(dir, n);
      await writeFile(path, 'x');
      materials.push({sha256: id(c), path});
    }
    assert.equal(openableMaterial(materials, id('a'), dir), join(dir, '資料.pdf'));
    assert.equal(openableMaterial(materials, id('b'), dir), join(dir, '資料.pptx'));
    assert.equal(openableMaterial(materials, id('1'), dir), join(dir, '写真.JPG'), '大文字の拡張子も');
    for (const c of ['c', 'd', 'e', 'f', '0'])
      assert.equal(openableMaterial(materials, id(c), dir), null, materials.find(m => m.sha256 === id(c)).path);
    assert.doesNotMatch('x.app', OPENABLE);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
test('ダウンロード先の既定：デスクトップの「<西暦>_<学期名>」（学年暦の学期から）。アプリはデスクトップの場所を COURSECUE_DESKTOP で渡す', async () => {
  const {termFolder, desktopDir, defaultDownloadRoot} = await import('../local/download-dir.js');
  assert.equal(termFolder('2026 秋学期'), '2026_秋学期');
  assert.equal(termFolder('2027春学期'), '2027_春学期');
  assert.equal(termFolder(''), 'saboro', '学期が分からなければ saboro');
  assert.equal(termFolder('2026 秋/学期'), '2026_秋_学期', 'フォルダ名に使えない文字は置き換える');
  assert.equal(desktopDir('/Users/u'), join('/Users/u', 'Desktop'));
  assert.equal(
    defaultDownloadRoot({desktop: '/Users/u/Desktop', term: '2026 秋学期'}),
    join('/Users/u/Desktop', '2026_秋学期')
  );
  const prev = process.env.COURSECUE_DESKTOP;
  process.env.COURSECUE_DESKTOP = '/Users/u/OneDrive/Desktop';
  try {
    assert.equal(desktopDir('/Users/u'), '/Users/u/OneDrive/Desktop');
    assert.equal(defaultDownloadRoot({term: '2026 秋学期'}), join('/Users/u/OneDrive/Desktop', '2026_秋学期'));
  } finally {
    if (prev === undefined) delete process.env.COURSECUE_DESKTOP;
    else process.env.COURSECUE_DESKTOP = prev;
  }
  const {src, rx} = await import('./source.js');
  assert.match(
    src('local/bridge.js'),
    rx('process.env.COURSECUE_ROOT||defaultDownloadRoot({desktop:desktopDir(),term:calendar.term})')
  );
  const main = src('desktop/main.js');
  assert.match(main, rx("COURSECUE_DESKTOP:app.getPath('desktop'),"));
  assert.match(main, rx("return defaultDownloadRoot({desktop:app.getPath('desktop'),term});"));
  assert.doesNotMatch(main, /COURSECUE_ROOT/);
});
// 授業ページのお知らせに付いているファイルも、その授業のフォルダに保存する
test('お知らせに付いているファイルも、その授業のフォルダにダウンロードする', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const body = page.replace(
    '<div id="div-class-contents">',
    '<div class="panel"><div class="panel-heading">お知らせ</div><div class="panel-body">教室が変わります。<a href="/file/9/">教室変更のお知らせ.pdf</a> <a href="/file/9/?layout=4up">教室変更のお知らせ（4up）</a> <a href="/content/5/">第5回 資料ページ</a></div></div><div id="div-class-contents">'
  );
  await ctx.route('**/*', r => r.fulfill({contentType: 'text/html; charset=utf-8', body}));
  const p = await ctx.newPage();
  const state = {
    tasks: [],
    materials: [],
    settings: {autoGenerate: false},
    schedules: {},
    courses: [{name: '管理会計Ⅱ', id: '103904'}]
  };
  const m = new Manabo({
    root: '/nonexistent',
    work: '/tmp',
    state,
    save: async () => {},
    credentials: async () => null,
    ai: async () => {}
  });
  m.ctx = ctx;
  m.page = async () => (m.p = p);
  m.cubics = async () => {};
  const got = [];
  m.download = async (e, course) => {
    got.push(course + ':' + e.url.replace('https://manabo.cnc.chukyo-u.ac.jp', ''));
  };
  await m.sync();
  assert(got.includes('管理会計Ⅱ:/file/9/'), 'お知らせのファイルを授業のフォルダに保存：' + got.join(' '));
  assert(!got.includes('管理会計Ⅱ:/file/9/?layout=4up'), '印刷形式違いは 1up だけ');
  assert(!got.some(x => x.includes('/content/5/')), 'ファイル以外のリンクは保存しない');
  assert.deepEqual(
    m.noticeFiles['103904'].map(x => x.name),
    ['教室変更のお知らせ.pdf', '教室変更のお知らせ（4up）']
  );
});

// manabo のお知らせ欄は [+] の見出しだけが出ていて、本文と付いているファイルは開くと出る。読む前に開き、ファイルを集める
const toggle =
  "var b=this.parentNode.querySelector('.body');b.style.display=b.style.display==='none'?'':'none';return false";
const noticePage = `<a id="button-logout">ログアウト</a><div id="div-class-directories"><table><tr><td>第1回 オリエンテーション</td></tr></table></div><div class="panel"><div class="panel-heading"><span class="icon"></span>お知らせ</div><div class="panel-body"><div class="news"><a href="#" class="a-open-news" onclick="${toggle}"><img src="/img/plus.gif">【第01回，09/25】配布資料 &amp; 復習用動画</a><div class="body" style="display:none">配布資料・講義で使用します <a href="https://chukyo-u-ac-jp.zoom.us/rec/share/x">https://chukyo-u-ac-jp.zoom.us/rec/share/x</a> <a href="/file/11/">第1回 コーポレートファイナンスⅡ（ガイダンス）_配布用.pdf</a></div></div><div class="news"><a href="#" class="a-open-news" onclick="${toggle}"><img src="/img/plus.gif">【第02回，10/02】配布資料 &amp; 復習用動画</a><div class="body" style="display:none">教室は 0803 です <a href="/file/12/">第2回 コーポレートファイナンスⅡ（資金調達①）_配布用（分割なしバージョン）.pdf</a> <a href="/file/13/">第2回 コーポレートファイナンスⅡ（資金調達①）_配布用（2分割バージョン）.pdf</a> <a href="/file/14/">第2回 コーポレートファイナンスⅡ（資金調達①）_配布用（4分割バージョン）.pdf</a></div></div></div></div>`;
test('お知らせ欄の折りたたまれた項目を開いてから読み、付いているファイル（分割なしだけ）を授業のフォルダに保存する', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  await ctx.route('**/*', r => r.fulfill({contentType: 'text/html; charset=utf-8', body: noticePage}));
  const p = await ctx.newPage();
  await p.goto('https://manabo.cnc.chukyo-u.ac.jp/class/103904/');
  const state = {
    tasks: [],
    materials: [],
    settings: {autoGenerate: false},
    courses: [{name: 'コーポレート・ファイナンスⅡ', id: '103904'}]
  };
  const m = new Manabo({
    root: '/nonexistent',
    work: '/tmp',
    state,
    save: async () => {},
    credentials: async () => null,
    ai: async () => {}
  });
  m.ctx = ctx;
  assert.equal(await m.expandNotices(p), 2, '見出しを一度ずつ押す（画像と見出しの両方を押して閉じ直さない）');
  assert.deepEqual(
    await p.evaluate(() => [...document.querySelectorAll('.body')].map(b => b.style.display)),
    ['', ''],
    '本文が開く'
  );
  const {classInfo} = await import('../local/manabo.js');
  const info = await p.evaluate(classInfo);
  assert.match(info.notice, /教室は 0803 です/, '開いた本文を読む');
  assert.deepEqual(
    info.noticeFiles.map(f => f.url.replace('https://manabo.cnc.chukyo-u.ac.jp', '')),
    ['/file/11/', '/file/12/', '/file/13/', '/file/14/'],
    'Zoom などファイル以外のリンクは含めない'
  );
  assert.deepEqual(
    m.wantedFiles(info.noticeFiles).map(f => f.url.replace('https://manabo.cnc.chukyo-u.ac.jp', '')),
    ['/file/11/', '/file/12/'],
    '2分割・4分割は保存せず分割なしだけ'
  );
  // 同期の流れでも、授業ページを読んだあとにお知らせのファイルを保存する
  m.page = async () => (m.p = p);
  m.cubics = async () => {};
  const got = [];
  m.download = async (e, course) => {
    got.push(course + ':' + e.url.replace('https://manabo.cnc.chukyo-u.ac.jp', ''));
  };
  await m.sync();
  assert.deepEqual(
    got.filter(x => x.includes('/file/1')),
    ['コーポレート・ファイナンスⅡ:/file/11/', 'コーポレート・ファイナンスⅡ:/file/12/']
  );
});
// manabo の本物の作り：お知らせ欄は #div-class-news に AJAX で入り、見出しのクリック処理は jQuery で document に委譲されている（class・onclick・href では見分けられない）。
// 見出しを押すと本文が AJAX で入り、そこにファイルのリンクがある
const jqPage = `<a id="button-logout">ログアウト</a><div id="div-class-directories"><table><tr><td>第1回 オリエンテーション</td></tr></table></div><div id="div-class-news"><div class="panel-heading"><span class="icon"></span>お知らせ</div><div class="news"><div class="news-head" news_id="1"><img src="/common/images/icons/plus.png">【第01回，09/25】配布資料 &amp; 復習用動画</div><div class="news-body" id="news-1"></div></div><div class="news"><div class="news-head" news_id="2"><img src="/common/images/icons/plus.png">【第02回，10/02】配布資料 &amp; 復習用動画</div><div class="news-body" id="news-2"></div></div></div><script>window.jQuery={_data:(n,k)=>n===document&&k==='events'?{click:[{selector:'.news-head'}]}:undefined};document.addEventListener('click',e=>{const t=e.target.closest('.news-head');if(!t)return;const b=document.getElementById('news-'+t.getAttribute('news_id'));if(b.innerHTML){b.style.display=b.style.display==='none'?'':'none';return}fetch('/news/'+t.getAttribute('news_id')).then(r=>r.text()).then(h=>{b.innerHTML=h})})</script>`;
const newsBody = n =>
  n === '3'
    ? '<p>10/09 の第3回は台風のため休講です。</p>'
    : `<p>配布資料・講義で使用します</p><a href="https://chukyo-u-ac-jp.zoom.us/rec/share/x${n}">https://chukyo-u-ac-jp.zoom.us/rec/share/x${n}</a><br>パスコード:fJJDl9F@ <a href="/file/${n}1/">第${n}回 配布用（分割なしバージョン）.pdf</a> <a href="/file/${n}2/">第${n}回 配布用（2分割バージョン）.pdf</a>`;
const thirdNews =
  '<div class="news"><div class="news-head" news_id="3"><img src="/common/images/icons/plus.png">【第03回，10/09】休講のお知らせ</div><div class="news-body" id="news-3"></div></div>';
test('manabo の作り（お知らせ欄は AJAX で入り、見出しの処理は jQuery で委譲）でも、見出しを押して本文を読み込んでからファイルを集める', async t => {
  const browser = await chromium.launch({headless: true});
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  let page = jqPage;
  await ctx.route('**/*', r => {
    const u = r.request().url(),
      m = u.match(/\/news\/(\d+)$/);
    return r.fulfill({contentType: 'text/html; charset=utf-8', body: m ? newsBody(m[1]) : page});
  });
  const p = await ctx.newPage();
  await p.goto('https://manabo.cnc.chukyo-u.ac.jp/class/103901/');
  const m = new Manabo({
    root: '/nonexistent',
    work: '/tmp',
    state: {tasks: [], materials: [], settings: {}, courses: [{name: 'コーポレート・ファイナンスⅡ', id: '103901'}]},
    save: async () => {},
    credentials: async () => null
  });
  m.ctx = ctx;
  assert.equal(await m.expandNotices(p), 2, 'jQuery に委譲された処理の要素を押す');
  const {classInfo} = await import('../local/manabo.js');
  const info = await p.evaluate(classInfo);
  assert.match(info.notice, /配布資料・講義で使用します/, '読み込まれた本文を読む');
  assert.deepEqual(
    m.wantedFiles(info.noticeFiles).map(f => f.url.replace('https://manabo.cnc.chukyo-u.ac.jp', '')),
    ['/file/11/', '/file/21/']
  );
  assert.deepEqual(
    info.notices.map(n => [n.title, n.files.length]),
    [
      ['【第01回，09/25】配布資料 & 復習用動画', 2],
      ['【第02回，10/02】配布資料 & 復習用動画', 2]
    ],
    '押した見出しごとに題名と付いているファイルを分ける'
  );
  assert.equal(await m.expandNotices(p), 2, '二度目も押せる（開いた項目を閉じるが、本文は残るのでファイルは集まる）');
  assert.deepEqual((await p.evaluate(classInfo)).noticeFiles.length, 4);
  // 同期：お知らせを 1 件ずつ読み（回・日付・Zoom）、初回は新着にせず見た印の基準にする。今回のまとめも残す
  const state = m.state;
  m.page = async () => (m.p = p);
  m.cubics = async () => {};
  await m.sync();
  const name = 'コーポレート・ファイナンスⅡ';
  assert.deepEqual(
    state.notices[name].map(n => [n.round, n.date, n.zoom, n.pass, n.cancelled]),
    [
      [1, '2026-09-25', 'https://chukyo-u-ac-jp.zoom.us/rec/share/x1', 'fJJDl9F@', false],
      [2, '2026-10-02', 'https://chukyo-u-ac-jp.zoom.us/rec/share/x2', 'fJJDl9F@', false]
    ]
  );
  assert.equal(state.noticeSeen[name].length, 2, '初回は全部を見た印にする');
  assert.deepEqual(state.newNotices || [], [], '初回は新着にしない');
  assert.equal(state.courseSummary[name].notices, 2);
  assert.equal(state.syncSummary.notices, 2);
  assert.equal(state.syncSummary.scope, 'all');
  // 次の同期で休講のお知らせが増えた：新着に出し、休講を時間割の予定にする
  page = jqPage.replace('</div></div></div><script>', '</div></div>' + thirdNews + '</div><script>');
  await m.sync({course: 0});
  assert.deepEqual(
    (state.newNotices || []).map(n => [n.course, n.title, n.date]),
    [[name, '【第03回，10/09】休講のお知らせ', '2026-10-09']]
  );
  assert.deepEqual(state.noticeEvents, [
    {course: name, date: '2026-10-09', status: '休講', source: 'お知らせ', title: '【第03回，10/09】休講のお知らせ'}
  ]);
  assert.equal(state.syncSummary.scope, name);
  assert.equal(state.syncSummary.newNotices, 1);
  await m.sync({course: 0});
  assert.equal((state.newNotices || []).length, 1, '同じ新着を二度は数えない');
});
// お知らせのファイルは {url, name} だけで text がない。hash(undefined) で落ちて「ファイルは保存されたのに記録がない（画面の資料欄に出ない）」になっていた
test('text のないファイル（お知らせの添付）も保存して記録し、失敗したら要対応に出す', async t => {
  const base = await mkdtemp(join(tmpdir(), 'coursecue-notice-dl-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const state = {tasks: [], materials: [], settings: {}};
  const {m} = fakeManabo(base, state);
  await m.download({url: 'https://manabo.cnc.chukyo-u.ac.jp/file/9/', name: '教室変更のお知らせ.pdf'}, '管理会計Ⅱ');
  assert.deepEqual(await readdir(join(base, '管理会計Ⅱ')), ['第9回_資料.pdf']);
  assert.equal(state.materials.length, 1, 'ファイルだけでなく記録も作る');
  assert.equal(state.materials[0].course, '管理会計Ⅱ');
  assert.match(state.materials[0].textHash, /^[0-9a-f]{64}$/);
  const {src, rx} = await import('./source.js');
  assert.match(
    src('local/manabo.js'),
    rx(
      'await this.download(e,name,roundOf.get(e.url)).catch(err=>infoIssues.push(`${name}：お知らせのファイル「${e.name||e.url}」を保存できません（'
    ),
    'お知らせの保存の失敗は握りつぶさず要対応に出す'
  );
});
test('ファイルの種類は拡張子で決め、どれにも当たらないものは「その他」', () => {
  assert.equal(fileType('第1回.PDF'), 'PDF');
  assert.equal(fileType('レジュメ.docx'), 'Word');
  assert.equal(fileType('データ.csv'), 'Excel');
  assert.equal(fileType('スライド.pptx'), 'PowerPoint');
  assert.equal(fileType('板書.jpeg'), '画像');
  assert.equal(fileType('講義.mp4'), '動画・音声');
  assert.equal(fileType('配布物.zip'), 'その他');
  assert.equal(fileTypeOf('第1回 資料'), null, '拡張子がなければ分からない');
  assert.equal(fileTypeOf('配布.pptx'), 'PowerPoint');
});
test('授業の設定で選んだ種類の資料だけ保存し、外した種類は覚えて次から取りに行かない（種類を足せば保存する）', async t => {
  const base = await mkdtemp(join(tmpdir(), 'coursecue-types-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const names = {1: '第1回_資料.pdf', 2: '第1回_スライド.pptx', 3: '第1回_板書.png'};
  const state = {tasks: [], materials: [], settings: {}, timetable: {管理会計Ⅱ: {fileTypes: ['PDF']}}};
  const {m} = fakeManabo(base, state);
  let gets = 0;
  m.ctx.request.get = async url => {
    gets++;
    const n = url.match(/file\/(\d+)/)[1];
    return {
      ok: () => true,
      headers: () => ({
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(names[n])}`
      }),
      body: async () => Buffer.from('data ' + n)
    };
  };
  for (const n of [1, 2]) await m.download(entry(n), '管理会計Ⅱ');
  await m.download({url: 'https://manabo.cnc.chukyo-u.ac.jp/file/3/', name: '第1回_板書.png'}, '管理会計Ⅱ');
  assert.deepEqual(await readdir(join(base, '管理会計Ⅱ')), ['第1回_資料.pdf']);
  assert.equal(gets, 2, '名前に拡張子がある資料は取りに行かずに決める');
  assert.deepEqual(state.skippedFiles, {[entry(2).url]: 'PowerPoint'});
  await m.download(entry(2), '管理会計Ⅱ');
  assert.equal(gets, 2, '外した種類と分かった資料は取りに行かない');
  state.timetable.管理会計Ⅱ.fileTypes = ['PDF', 'PowerPoint'];
  await m.download(entry(2), '管理会計Ⅱ');
  assert.deepEqual((await readdir(join(base, '管理会計Ⅱ'))).sort(), ['第1回_スライド.pptx', '第1回_資料.pdf']);
  const other = {tasks: [], materials: [], settings: {}, timetable: {管理会計Ⅱ: {fileTypes: []}}};
  const {m: none} = fakeManabo(join(base, 'none'), other);
  await none.download(entry(1), '管理会計Ⅱ');
  await assert.rejects(readdir(join(base, 'none', '管理会計Ⅱ')), undefined, 'すべて外したら授業フォルダも作らない');
});
