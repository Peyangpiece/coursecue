import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGenerator, providers} from '../local/generate.js';
const answer = {
  grounded: true,
  draft: '2',
  needsUser: [],
  answers: [{name: 'q1', value: 'b', values: [], evidence: '資料.txt 引用:1+1は2'}]
};
const fake = (name, result) => ({
  name,
  calls: 0,
  async generate() {
    this.calls++;
    if (result instanceof Error) throw result;
    return result;
  }
});
test('Codexで生成できればClaude系は呼ばない', async () => {
  const chain = [fake('Codex', answer), fake('Claude Code', answer), fake('Claude API', answer)];
  const r = await createGenerator({chain, log: () => {}})({}, []);
  assert.equal(r.generatedBy, 'Codex');
  assert.deepEqual(
    chain.map(p => p.calls),
    [1, 0, 0]
  );
});
test('Codexが失敗したらClaude Code、それも失敗したらClaude APIを使う', async () => {
  const chain = [
    fake('Codex', Error('利用枠超過')),
    fake('Claude Code', Error('未ログイン')),
    fake('Claude API', answer)
  ];
  const r = await createGenerator({chain, log: () => {}})({}, []);
  assert.equal(r.generatedBy, 'Claude API');
  assert.deepEqual(
    chain.map(p => p.calls),
    [1, 1, 1]
  );
});
test('形式が不正な出力は使わず次の手段へ進む', async () => {
  const chain = [fake('Codex', {draft: 'x'}), fake('Claude Code', answer)];
  const r = await createGenerator({chain, log: () => {}})({}, []);
  assert.equal(r.generatedBy, 'Claude Code');
});
test('すべて失敗した場合は理由をまとめて返す（手段の名前は出さない。同じ理由は 1 つ。試していない手段は含めない）', async () => {
  const chain = [
    fake('Codex', Error('A')),
    fake('Claude Code', Error('B')),
    fake('SaBoRo AI', Error('B')),
    fake('X', Error('未インストール'))
  ];
  await assert.rejects(createGenerator({chain, log: () => {}})({}, []), /^Error: 課題生成に失敗しました（A／B）$/);
  await assert.rejects(
    createGenerator({chain: [fake('Codex', Error('未インストール'))], log: () => {}})({}, []),
    /^Error: 課題生成に失敗しました（SaBoRo課題サポートを使えません）$/
  );
});
test('失敗の理由は短くし、AI の出力の全文や長いエラーは画面に出さない', async () => {
  const raw = '{"grounded":true,"draft":"' + 'あ'.repeat(500) + '"}';
  let parseError;
  try {
    JSON.parse(raw + 'x');
  } catch (e) {
    parseError = e;
  }
  const chain = [fake('Codex', parseError), fake('Claude Code', Error('終了コード 1')), fake('Claude API', Error(raw))];
  const logs = [];
  await assert.rejects(
    createGenerator({chain, log: m => logs.push(m)})({}, []),
    e => e.message === '課題生成に失敗しました（出力の形式が不正／終了コード 1／エラーで終了）'
  );
  assert(
    logs.some(m => m.includes('grounded')),
    '詳しい内容はログに残す'
  );
});
test('実際のCLI呼び出し：Codexが異常終了したらClaude Codeの構造化出力を使う', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coursecue-cli-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const codex = join(dir, 'codex'),
    claude = join(dir, 'claude');
  await writeFile(codex, '#!/bin/sh\ncat >/dev/null\necho "usage limit reached" >&2\nexit 1\n');
  await writeFile(
    claude,
    `#!/bin/sh\ncat >/dev/null\ncase "$*" in *--json-schema*--tools*) echo '${JSON.stringify({is_error: false, subtype: 'success', structured_output: answer})}';; *) exit 9;; esac\n`
  );
  await chmod(codex, 0o755);
  await chmod(claude, 0o755);
  const saved = {...process.env};
  t.after(() => {
    process.env = saved;
  });
  process.env.COURSECUE_CODEX = codex;
  process.env.COURSECUE_CLAUDE = claude;
  delete process.env.ANTHROPIC_API_KEY;
  const r = await createGenerator({chain: providers, apiKey: async () => null, log: () => {}})({title: '検証'}, []);
  assert.equal(r.generatedBy, 'Claude Code');
  assert.equal(r.answers[0].value, 'b');
});
test('本人の API キーで作る手段はない（Codex → Claude Code → SaBoRo の AI の順だけ）', () => {
  assert.deepEqual(
    providers.map(p => p.name),
    ['Codex', 'Claude Code', 'SaBoRo課題サポート']
  );
});
test('本文から記号・Markdown を取り除き、本人への注意は notes に分ける', async () => {
  const {cleanText, cleanAnswer, valid} = await import('../local/generate.js');
  assert.equal(
    cleanText(
      '# 見出し\n\n**強調**と*斜体*と`コード`\n- 項目1\n- 項目2\n> 引用\n"引用符"と“全角”の「かぎ括弧」は残す。\n\n\n\n＃末尾'
    ),
    '見出し\n\n強調と斜体とコード\n項目1\n項目2\n引用\n「引用符」と「全角」の「かぎ括弧」は残す。\n\n末尾'
  );
  const q = [
    {name: 'essay', type: 'textarea'},
    {name: 'pick', type: 'radio'}
  ];
  const out = cleanAnswer(
    {
      grounded: true,
      draft: '## 回答\n**本文**だ。',
      needsUser: [],
      answers: [
        {name: 'essay', value: '# 本文\n"文章"', values: [], evidence: 'x'},
        {name: 'pick', value: '**A**', values: [], evidence: 'y'}
      ]
    },
    q
  );
  assert.equal(out.draft, '回答\n本文だ。');
  assert.equal(out.answers[0].value, '本文\n「文章」');
  assert.equal(out.answers[1].value, '**A**', '選択式の value は選択肢と一致させるため触らない');
  assert.deepEqual(out.notes, []);
  assert(valid({grounded: true, draft: '', needsUser: [], notes: ['一般知識で推定'], answers: []}));
  assert(!valid({grounded: true, draft: '', needsUser: [], notes: 'x', answers: []}));
  const chain = [
    fake('Codex', {
      grounded: false,
      draft: '# タイトル\n本文',
      needsUser: [],
      notes: ['一般知識による推定を含む'],
      answers: [{name: 'essay', value: '**強調**', values: [], evidence: 'e'}]
    })
  ];
  const r = await createGenerator({chain, log: () => {}})({questions: q}, []);
  assert.equal(r.draft, 'タイトル\n本文');
  assert.equal(r.answers[0].value, '強調');
  assert.deepEqual(r.notes, ['一般知識による推定を含む']);
  assert.equal(r.generatedBy, 'Codex');
});
test('実際のCLI呼び出し：入力を読まずに即終了する手段（未ログインなど）でも落ちずに次へ進む', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coursecue-cli-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const codex = join(dir, 'codex'),
    claude = join(dir, 'claude');
  await writeFile(codex, '#!/bin/sh\necho "not logged in" >&2\nexit 1\n');
  await writeFile(
    claude,
    `#!/bin/sh\ncat >/dev/null\necho '${JSON.stringify({is_error: false, subtype: 'success', structured_output: answer})}'\n`
  );
  await chmod(codex, 0o755);
  await chmod(claude, 0o755);
  const saved = {...process.env};
  t.after(() => {
    process.env = saved;
  });
  process.env.COURSECUE_CODEX = codex;
  process.env.COURSECUE_CLAUDE = claude;
  delete process.env.ANTHROPIC_API_KEY;
  const logs = [];
  const big = [{file: 'a.txt', text: '資料 '.repeat(400000)}];
  const r = await createGenerator({chain: providers, apiKey: async () => null, log: m => logs.push(m)})(
    {title: '検証'},
    big
  );
  assert.equal(r.generatedBy, 'Claude Code');
  assert.match(logs[0], /Codex.*not logged in/);
});
// 本文は「だ・である調」。感想は「思った・わかった・考えた」などを使い分ける。敬体が残っていれば本人に知らせる（引用の中は対象外）
test('回答は「だ・である調」で、感想は「思った・わかった・考えた」などを使い分けるよう指示する', async () => {
  const {prompt} = await import('../local/generate.js');
  const p = prompt({title: '感想'}, [], '');
  assert.match(p, /すべて「だ・である調」（常体）で書く/);
  for (const w of ['〜と思った', '〜がわかった', '〜と考えた']) assert.ok(p.includes(w), w);
  assert.match(p, /同じ文末を二文続けず/);
  assert.match(p, /AIが組み立てた例です/);
});
// 文章の質：段落の組み立て・AI らしい定型の回避・人が書いたような揺らぎ・読み返しを指示し、残った言い回しは本人に知らせる
test('大学生が自分で書いたように見える本文を指示し、AI らしい言い回しが残っていれば注意点で知らせる', async () => {
  const {prompt, WRITING_RULE, stiffPhrases, stiffNote, cleanAnswer, writingStyle} = await import(
    '../local/generate.js'
  );
  const p = prompt({title: 'レポート'}, [], '');
  assert(p.includes(WRITING_RULE));
  for (const w of [
    '段落は一つの話題につき一つ',
    '「本レポートでは」「本稿では」ではなく',
    '中身のない総括',
    '反対の見方や例外に一度は触れる',
    '「〜ではないだろうか」の反語を二度以上使わない',
    '文頭の「また」「さらに」「そして」「このように」に頼らず',
    '「〜である」「〜だ」の文末を四文以上続けず',
    '十〜二十字の短い文も時々入れて',
    '考えが動いた過程',
    '断定と迷いを混ぜる',
    '書き終えたら本文を読み返し'
  ])
    assert.ok(p.includes(w), w);
  assert.match(
    p,
    /小テストの記述や一問一答は、答えを最初の一文で書く決まりのとおりにし/,
    '短い記述には段落や締めの工夫を求めない'
  );
  assert.match(writingStyle('seed-a', 't1'), /最後は.*終える。$/, '締めくくり方も利用者ごと・課題ごとに変える');
  // 一度で目立つもの・繰り返しで目立つもの・三つそろうと目立つもの。「」の中は対象外
  assert.deepEqual(stiffPhrases('以上のことから、努力が大切だと考える。'), [
    '「以上のことから」「まとめると」などの総括'
  ]);
  assert.deepEqual(stiffPhrases('本レポートでは需要について述べる。'), ['「本レポートでは」']);
  assert.deepEqual(stiffPhrases('努力することが重要である。'), []);
  assert.deepEqual(stiffPhrases('努力することが重要である。継続することが重要である。'), [
    '「〜ことが重要である」の繰り返し'
  ]);
  assert.deepEqual(stiffPhrases('まず資料を読んだ。次に考えた。最後にまとめた。'), ['「まず・次に・最後に」の並べ方']);
  assert.deepEqual(stiffPhrases('まず資料を読んだ。次に考えた。'), []);
  assert.deepEqual(stiffPhrases('先生は「以上のことから」と言った。まずは一つ。'), []);
  assert.deepEqual(stiffPhrases('需要が増えると価格は上がる。最初はそう思っていたが、資料の例は違った。'), []);
  const q = [
    {name: 'essay', type: 'textarea'},
    {name: 'pick', type: 'radio'}
  ];
  const base = {grounded: true, needsUser: [], notes: ['一般知識で推定'], answers: []};
  const out = cleanAnswer(
    {
      ...base,
      draft: '本レポートでは述べる。',
      answers: [
        {name: 'essay', value: 'まとめると楽しかった。', values: [], evidence: 'e'},
        {name: 'pick', value: '以上のことから', values: [], evidence: 'e'}
      ]
    },
    q
  );
  assert.deepEqual(out.notes, [
    '一般知識で推定',
    stiffNote(['「本レポートでは」', '「以上のことから」「まとめると」などの総括'])
  ]);
  assert.match(out.notes[1], /^AIが書いたように見えやすい言い回しが残っています（「本レポートでは」、/);
  assert.match(out.notes[1], /提出前に自分の言葉に直してください$/);
  const twice = cleanAnswer(out, q);
  assert.equal(twice.notes.length, 2, '二度整形しても重ねない');
  assert.deepEqual(cleanAnswer({...base, draft: '需要が増えると価格は上がる。'}, q).notes, ['一般知識で推定']);
});
test('記述の回答に「です・ます」が残っていれば notes で知らせ、引用の中や選択式は対象外', async () => {
  const {cleanAnswer, politeEnding, POLITE_NOTE} = await import('../local/generate.js');
  const q = [
    {name: 'essay', type: 'textarea'},
    {name: 'pick', type: 'radio'}
  ];
  const base = {
    grounded: true,
    needsUser: [],
    notes: ['一般知識で推定'],
    answers: [{name: 'pick', value: 'はい、そうです', values: [], evidence: 'e'}]
  };
  assert.deepEqual(cleanAnswer({...base, draft: '需要が増えると価格は上がる。この点が重要だと思った。'}, q).notes, [
    '一般知識で推定'
  ]);
  assert.deepEqual(cleanAnswer({...base, draft: '価格が上がることがわかりました。'}, q).notes, [
    '一般知識で推定',
    POLITE_NOTE
  ]);
  assert.deepEqual(
    cleanAnswer(
      {
        ...base,
        draft: '',
        answers: [...base.answers, {name: 'essay', value: 'とても勉強になりました', values: [], evidence: 'e'}]
      },
      q
    ).notes,
    ['一般知識で推定', POLITE_NOTE]
  );
  const twice = cleanAnswer(cleanAnswer({...base, draft: '学びました。'}, q), q);
  assert.equal(twice.notes.filter(n => n === POLITE_NOTE).length, 1, '二度整形しても重ねない');
  assert.equal(politeEnding('先生は「ここが大事です」と述べた。'), false);
  assert.equal(politeEnding('ますます重要になると考えた。'), false);
  assert.equal(politeEnding('なぜでしょうか？'), true);
});
// SaBoRo の AI：本人の手段がないときに使う。急ぐ依頼・キーのない依頼はすぐ、それ以外は Batch で、出来上がるまで AiPending
test('SaBoRo の AI：急ぐ依頼はすぐ、急がない依頼は Batch（同じキーで受け取る）。出来上がるまでは AiPending を投げ、ほかの手段を試さない', async () => {
  const {AiPending, createCourseInfoExtractor} = await import('../local/generate.js');
  const saboroProvider = providers.find(p => p.name === 'SaBoRo課題サポート');
  assert.ok(saboroProvider, '最後の手段');
  assert.equal(providers.at(-1), saboroProvider);
  const sent = [];
  let reply = {status: 'done', text: JSON.stringify(answer)};
  const saboro = async b => {
    sent.push(b);
    return reply;
  };
  const gen = createGenerator({chain: [saboroProvider], log: () => {}, saboro});
  let r = await gen({type: 'レポート'}, [], '', {key: 'abc12345', urgent: true});
  assert.equal(r.generatedBy, 'SaBoRo課題サポート');
  assert.deepEqual(
    {mode: sent[0].mode, key: sent[0].key, label: sent[0].label},
    {mode: 'now', key: 'abc12345', label: '課題生成'}
  );
  reply = {status: 'pending'};
  await assert.rejects(gen({}, [], '', {key: 'abc12345'}), e => e instanceof AiPending);
  assert.equal(sent[1].mode, 'batch');
  const after = fake('後ろの手段', answer);
  await assert.rejects(
    createGenerator({chain: [saboroProvider, after], log: () => {}, saboro})({}, [], '', {key: 'abc12345'}),
    e => e instanceof AiPending
  );
  assert.equal(after.calls, 0, '作成中なら次の手段に進まない');
  reply = {
    status: 'done',
    text: JSON.stringify({
      room: {value: '', evidence: ''},
      mode: {value: '', evidence: ''},
      absenceLimit: {value: '', evidence: ''},
      attendanceMethod: {value: '', evidence: ''},
      lateRule: {value: '', evidence: ''},
      notes: {value: '', evidence: ''},
      sessions: []
    })
  };
  await createCourseInfoExtractor({chain: [saboroProvider], log: () => {}, saboro})('授業', []);
  assert.equal(sent.at(-1).mode, 'now', '目印のない授業情報の読み取りはすぐ');
  assert.equal(sent.at(-1).label, '授業情報の読み取り');
  const info = createCourseInfoExtractor({chain: [saboroProvider], log: () => {}, saboro});
  await info('授業', [], {key: 'info-12345678', urgent: false});
  assert.deepEqual(
    {mode: sent.at(-1).mode, key: sent.at(-1).key},
    {mode: 'batch', key: 'info-12345678'},
    '急がない授業情報の読み取りは Batch'
  );
  await info('授業', [], {key: 'info-12345678', urgent: true});
  assert.equal(sent.at(-1).mode, 'now', '急ぐ授業情報の読み取りはすぐ');
});
test('SaBoRo の AI：出力が上限で途切れたら AiTruncated（今月の高度な生成の回数つき）を投げ、高度な生成はすぐ作る', async () => {
  const {AiTruncated} = await import('../local/generate.js');
  const saboroProvider = providers.find(p => p.name === 'SaBoRo課題サポート');
  const sent = [];
  let reply = {status: 'failed', reason: '出力が上限で途切れました', truncated: true, advanced: {used: 1, limit: 3}};
  const gen = createGenerator({
    chain: [saboroProvider],
    log: () => {},
    saboro: async b => {
      sent.push(b);
      return reply;
    }
  });
  await assert.rejects(
    gen({}, [], '', {key: 'abc12345'}),
    e => e instanceof AiTruncated && e.advanced.used === 1 && e.advanced.limit === 3
  );
  assert.equal(sent[0].mode, 'batch');
  assert.equal(sent[0].advanced, undefined);
  reply = {status: 'done', text: JSON.stringify(answer)};
  await gen({}, [], '', {key: 'abc12345', advanced: true});
  assert.deepEqual({mode: sent[1].mode, advanced: sent[1].advanced}, {mode: 'now', advanced: true});
  reply = {error: 'advanced_limit'};
  await assert.rejects(gen({}, [], '', {key: 'abc12345', advanced: true}), /今月の高度な生成は使い切りました/);
});
test('SaBoRo の AI：未設定なら試していない扱い（使用量に残さない）。無料分の使い切りは理由を出す', async () => {
  const saboroProvider = providers.find(p => p.name === 'SaBoRo課題サポート');
  const usage = [];
  await assert.rejects(
    createGenerator({
      chain: [saboroProvider],
      log: () => {},
      onUsage: u => usage.push(u),
      saboro: async () => ({error: 'not_configured'})
    })({}, []),
    /課題生成に失敗しました（SaBoRo課題サポートを使えません）/
  );
  assert.equal(usage.length, 0);
  await assert.rejects(
    createGenerator({chain: [saboroProvider], log: () => {}, onUsage: u => usage.push(u)})({}, []),
    /SaBoRo課題サポートを使えません/,
    'クラウドの窓口がなければ試さない'
  );
  await assert.rejects(
    createGenerator({
      chain: [saboroProvider],
      log: () => {},
      onUsage: u => usage.push(u),
      saboro: async () => ({error: 'limit'})
    })({}, []),
    /今月の無料分を使い切りました/
  );
  assert.equal(usage.length, 1);
});
test('アプリ：Batch を待つ課題は 10 分ごとに出来上がりを確かめて入力し直し、本人が頼んだ処理は急ぎにする', async () => {
  const {src, rx} = await import('./source.js');
  const bridge = src('local/bridge.js'),
    manabo = src('local/manabo.js');
  assert.match(bridge, rx("api('/api/agent/ai/ready','POST'"));
  assert.match(bridge, rx("run({kind:'generate',task:t.id,auto:true})"));
  assert.match(
    bridge,
    rx('lms.process(t,false,{urgent:!job.auto,advanced:job.payload?.advanced===true,...personalOptions(job.payload)})')
  );
  assert.match(bridge, rx('createGenerator({', /[^}]*/, 'saboro})'));
  assert.match(manabo, rx('if(!(e instanceof AiPending))throw e;t.aiPending=generationKey;t.action=AI_PENDING_ACTION'));
  assert.match(
    manabo,
    rx('if(e instanceof AiTruncated){delete t.aiPending;this.offerAdvanced(t,generationKey,e.advanced)'),
    '途切れたら自動で作り直さず、高度な生成を選べるようにする'
  );
  assert.match(manabo, rx('urgent:urgent||manualSubmit||soon'));
  assert.match(
    bridge,
    rx(
      "req.url.startsWith('/owned?')",
      /[\s\S]{0,400}?/,
      "createHash('sha256').update(owner)",
      /[\s\S]{0,200}?/,
      'timingSafeEqual'
    ),
    '接続用リンクの鍵は、鍵のハッシュを照らすだけ（鍵は返さない）'
  );
  assert.match(bridge, rx('lms.resumeCourseInfo(id.course)'), 'Batch を待つ授業情報も出来上がったら受け取る');
  assert.match(manabo, rx('this.firstSync=!this.state.lastSync'));
  assert.match(manabo, rx('this.process(t,false,{urgent:this.firstSync})'), '初回の同期の回答はすぐ作る');
});
test('自分について聞かれる設問は、本人の立場で作り、プロフィールを使い、経験がなければ設問に合う経験を組み立てて完成させる', async () => {
  const {prompt} = await import('../local/generate.js');
  const p = prompt({title: 'あなたの経験を踏まえて述べよ'}, [], '補足なし', {
    profile: '経営学部3年。飲食店のアルバイトを2年続けている'
  });
  assert.match(p, /本人のプロフィール: 経営学部3年。飲食店のアルバイトを2年続けている/);
  assert.match(p, /プロフィールにも補足にも使える経験がない場合は、設問の内容に最も適した/);
  assert.match(p, /needsUserに回したり空欄にしたりしない/);
  assert.match(p, /どの部分かを具体的に入れる/);
  assert.match(p, /結論や答えを先に書き/);
  assert.match(p, /中身のない総括/);
  assert.match(prompt({}, [], ''), /本人のプロフィール: （未登録）/, '未登録なら未登録と書く');
});
test('経験・体験を問う課題を言葉で拾い、画面と同じ判定にする', async () => {
  const {personalCandidate, PERSONAL} = await import('../local/generate.js');
  const {src, esc} = await import('./source.js');
  for (const s of [
    'あなたのアルバイト経験を踏まえて述べよ',
    '自分が取り組んだ活動を一つ挙げよ',
    '印象に残っているエピソードを書け',
    '高校時代の思い出に残る出来事'
  ])
    assert(personalCandidate({title: s}), s);
  for (const s of [
    'あなたの考えを述べよ',
    '身近な事例を5つ挙げよ',
    '前回の内容を思い出してください',
    '本日の講義の感想'
  ])
    assert(!personalCandidate({title: s}), s);
  assert(personalCandidate({title: '課題'}, [{text: 'これまでの体験を書いてください'}]), '設問文も見る');
  assert.match(
    src('dist/app.js'),
    new RegExp(`const PERSONAL\\s*=\\s*${esc(`/${PERSONAL.source}/;`)}`),
    '画面の判定と同じ'
  );
});
test('本人に聞く質問は最大 6 問・選択肢は最大 6 個にそろえ、「質問の作成」として記録する', async () => {
  const {createPersonalQuestioner} = await import('../local/generate.js');
  const used = [];
  const many = Array.from({length: 9}, (_, i) => ({
    text: ` 質問${i} `,
    choices: ['A', 'A', 'B', 'C', 'D', 'E', 'F', 'G']
  }));
  const ask = createPersonalQuestioner({
    chain: [
      {
        name: 'x',
        generate: async (text, {schema}) => {
          assert.match(text, /最大6問/);
          assert.match(text, /本人のプロフィール: 経営学部/);
          assert(schema.properties.questions);
          return {needsPersonal: true, questions: many};
        }
      }
    ],
    onUsage: u => used.push(u),
    log: () => {}
  });
  const r = await ask({title: '経験を述べよ'}, {profile: '経営学部'});
  assert.equal(r.questions.length, 6);
  assert.equal(r.questions[0].text, '質問0');
  assert.deepEqual(r.questions[0].choices, ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(used[0].label, '質問の作成');
  const none = createPersonalQuestioner({
    chain: [{name: 'x', generate: async () => ({needsPersonal: true, questions: []})}],
    log: () => {}
  });
  assert.equal((await none({title: 'x'})).needsPersonal, false, '質問がなければ不要として扱う');
});
test('質問への答えで作るときは答えを元にし、答えにない経験を足さないよう指示する', async () => {
  const {prompt} = await import('../local/generate.js');
  const p = prompt({}, [], '質問への回答:\nアルバイト：飲食', {personal: 'answers'});
  assert.match(p, /答えと矛盾する経験を作らない/);
  assert.match(p, /答えにない出来事は足さない/);
  assert.doesNotMatch(p, /AIが組み立てた例です/);
});
test('利用者どうしの回答が似ないように、利用者ごと・課題ごとに書き方を変え、目立つ例や決まり文句だけに頼らないよう指示する', async () => {
  const {writingStyle, prompt} = await import('../local/generate.js');
  const a = writingStyle('seed-a', 't1');
  assert.equal(a, writingStyle('seed-a', 't1'), '同じ人・同じ課題なら同じ');
  const others = new Set(['seed-b', 'seed-c', 'seed-d', 'seed-e', 'seed-f'].map(s => writingStyle(s, 't1')));
  assert(others.size >= 4, 'ほかの人とはほぼ違う');
  assert.notEqual(writingStyle('seed-a', 't2'), a, '課題が変われば変わる');
  assert.equal(writingStyle('', 't1'), '');
  const p = prompt({}, [], '', {style: a});
  assert.match(p, /ほかの人の回答と同じ・よく似た文章にならないよう/);
  assert.match(p, /資料の文を長くそのまま写さない/);
  assert(p.includes(`この回答の書き方（`) && p.includes(a));
  assert.doesNotMatch(prompt({}, [], ''), /この回答の書き方（/);
});
test('過去のレポートから文体と「自分について」の候補を読み取り、「文体の読み取り」として記録する。回答では本人の文体に合わせるよう指示する', async () => {
  const {createStyleLearner, prompt} = await import('../local/generate.js');
  const used = [];
  const learn = createStyleLearner({
    chain: [
      {
        name: 'x',
        generate: async (text, {schema}) => {
          assert.match(text, /まねして同じような文章を書けるように/);
          assert.match(text, /氏名・学籍番号・住所・連絡先・成績は書かない/);
          assert.match(text, /今の自分について: 経営学部/);
          assert.match(text, /レポートA/);
          assert(schema.properties.style);
          return {style: '**短い文**が多い。' + 'あ'.repeat(2000), profile: '飲食店でアルバイト'};
        }
      }
    ],
    onUsage: u => used.push(u),
    log: () => {}
  });
  const r = await learn([{file: 'a.docx', text: 'レポートA'}], {profile: '経営学部'});
  assert.equal(r.style.length, 1000);
  assert(r.style.startsWith('短い文が多い'), '記号は取り除く');
  assert.equal(r.profile, '飲食店でアルバイト');
  assert.equal(used[0].label, '文体の読み取り');
  const p = prompt({}, [], '', {ownStyle: '短い文が多い'});
  assert.match(p, /本人の文体（本人の過去のレポートから読み取ったもの。.*）：短い文が多い/);
});
test('ChatGPT・Claude の会話から「自分について」の候補を読み取り、立ち入った情報は書かないよう指示し、「会話の読み取り」として記録する', async () => {
  const {createChatProfiler} = await import('../local/generate.js');
  const used = [];
  const read = createChatProfiler({
    chain: [
      {
        name: 'x',
        generate: async text => {
          assert.match(text, /健康・家族・人間関係・お金・宗教・政治的な考え/);
          assert.match(text, /AIへの頼みごとそのもの/);
          assert.match(text, /ゼミで地域活性化/);
          return {profile: 'ゼミで地域活性化を研究'};
        }
      }
    ],
    onUsage: u => used.push(u),
    log: () => {}
  });
  assert.equal(
    (await read([{title: 'ゼミ', messages: ['ゼミで地域活性化を研究している']}])).profile,
    'ゼミで地域活性化を研究'
  );
  assert.equal(used[0].label, '会話の読み取り');
});
