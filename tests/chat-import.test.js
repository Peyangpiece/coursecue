import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import {mkdtemp, rm, writeFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {findExportZip, readExport, selectStudy} from '../local/chat-import.js';
import {rx} from './source.js';
// ChatGPT・Claude の書き出しの zip：ダウンロードフォルダから見つけ、本人のメッセージのうち学業に関係するものだけを選ぶ
const chatgpt = [
  {
    title: 'レポートの相談',
    update_time: 1760000000,
    mapping: {
      a: {message: {author: {role: 'system'}, content: {parts: ['system']}}},
      b: {
        message: {
          author: {role: 'user'},
          create_time: 1760000000,
          content: {content_type: 'text', parts: ['経営学部3年です。マーケティングのレポートの構成を考えたい']}
        }
      },
      c: {message: {author: {role: 'assistant'}, content: {parts: ['AIの答え']}}}
    }
  },
  {
    title: '夕飯',
    update_time: 1750000000,
    mapping: {d: {message: {author: {role: 'user'}, content: {parts: ['今日の夕飯の献立']}}}}
  }
];
const claude = [
  {
    name: 'ゼミの発表',
    updated_at: '2026-10-01T00:00:00Z',
    chat_messages: [
      {
        sender: 'human',
        text: 'ゼミで地域活性化を研究している',
        content: [{type: 'text', text: 'ゼミで地域活性化を研究している'}]
      },
      {sender: 'assistant', text: 'AIの答え'}
    ]
  }
];
async function zip(dir, name, files) {
  const z = new AdmZip();
  for (const [n, v] of Object.entries(files)) z.addFile(n, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
  const path = join(dir, name);
  z.writeZip(path);
  return path;
}
test('ChatGPT の書き出し：本人のメッセージだけを取り出し、学業に関係する会話だけを選ぶ', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'saboro-chat-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const path = await zip(dir, 'abc.zip', {'conversations.json': chatgpt, 'chat.html': '<html>', 'user.json': {}});
  const r = readExport(path);
  assert.equal(r.source, 'ChatGPT');
  assert.equal(r.conversations.length, 2);
  assert.deepEqual(
    r.conversations[0].messages.map(m => m.text),
    ['経営学部3年です。マーケティングのレポートの構成を考えたい'],
    'AI と system の発言は入れない'
  );
  const s = selectStudy(r.conversations);
  assert.equal(s.length, 1, '夕飯の会話は送らない');
  assert.equal(s[0].title, 'レポートの相談');
});
test('Claude の書き出しと、分かれた・入れ子の置き場所（conversations-000.json・personal/conversations/）も読む', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'saboro-chat-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const a = readExport(await zip(dir, 'data.zip', {'conversations.json': claude, 'users.json': [{}]}));
  assert.equal(a.source, 'Claude');
  assert.deepEqual(
    a.conversations[0].messages.map(m => m.text),
    ['ゼミで地域活性化を研究している']
  );
  const b = readExport(
    await zip(dir, 'x.zip', {
      'conversations-000.json': chatgpt.slice(0, 1),
      'personal/conversations/conversations-001.json': claude
    })
  );
  assert.equal(b.conversations.length, 2);
});
test('ダウンロードフォルダ：押した後にでき、10 秒以上変わっていない書き出しの zip だけを見つける', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'saboro-chat-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const now = Date.now(),
    since = now - 60000;
  const old = await zip(dir, 'old.zip', {'conversations.json': chatgpt});
  await utimes(old, new Date(now - 3600e3) / 1000, new Date(now - 3600e3) / 1000);
  const other = await zip(dir, 'photos.zip', {'a.jpg': 'x'});
  await utimes(other, (now - 30000) / 1000, (now - 30000) / 1000);
  await writeFile(join(dir, 'notzip.json'), '[]');
  assert.equal(await findExportZip(dir, since, now), null, '押す前の zip と書き出しでない zip は読まない');
  const fresh = await zip(dir, 'new.zip', {'conversations.json': chatgpt});
  assert.equal(await findExportZip(dir, since, now), null, 'できたばかり（ダウンロード中かもしれない）なら待つ');
  await utimes(fresh, (now - 20000) / 1000, (now - 20000) / 1000);
  assert.equal(await findExportZip(dir, since, now), fresh);
  assert.equal(await findExportZip(join(dir, 'none'), since, now), null);
});
test('選ぶ量に上限があり（全体 3 万字・1 件 500 字）、新しい会話から選ぶ', () => {
  const conv = n => ({title: '授業' + n, at: n, messages: [{text: 'レポート' + 'あ'.repeat(800)}]});
  const s = selectStudy([conv(1), conv(3), conv(2)], 1200);
  assert.deepEqual(
    s.map(c => c.title),
    ['授業3', '授業2']
  );
  assert(s.every(c => c.messages.every(m => m.length <= 500)));
});
test('アプリ：取り込みは本人が押してから 3 時間だけ待ち、失敗したら同じ zip で繰り返さない。候補は本人が確かめて足す', () => {
  const src = readFileSync('local/bridge.js', 'utf8');
  assert.match(src, rx('CHAT_WAIT=3*3600e3'));
  assert.match(src, rx("job.status==='failed')return"));
  assert.match(src, rx('state.profileSuggestion={source,text:r.profile'));
  assert.match(src, rx('setInterval(()=>checkChatImport().catch(()=>{}),15000)'));
  assert.match(src, /https:\/\/chatgpt\.com\//);
  assert.match(src, /https:\/\/claude\.ai\//);
});
