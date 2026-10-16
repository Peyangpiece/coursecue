import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import '../dist/profile-form.js';
// 「自分について」のアンケート：選ぶだけで答えられ、答えを文にまとめて回答の作成に使う
const P = globalThis.ProfileForm;
test('答えを「学部：経営学部」のような文にまとめ、知らない選択肢は捨てる', () => {
  assert.equal(
    P.composeProfile({
      faculty: '経営学部',
      year: '3年',
      job: ['飲食', '知らない'],
      club: '運動系',
      clubNote: 'テニス',
      future: 'その他',
      futureNote: '起業も考えている' + 'あ'.repeat(50)
    }),
    '学部：経営学部\n学年：3年\nアルバイト：飲食\n部活・サークル：運動系（テニス）\n将来の希望：その他（起業も考えている' +
      'あ'.repeat(32) +
      '）'
  );
  assert.equal(P.composeProfile({faculty: '医学部'}), '', 'ない学部は使わない');
  assert.equal(P.composeProfile(null), '');
  assert(P.PROFILE_FIELDS.find(f => f.key === 'faculty').options.includes('経営学部'));
});
test('質問は 10 問以内で、1 つ選ぶ質問と、いくつでも選べる質問がある', () => {
  assert(P.PROFILE_FIELDS.length <= 10);
  assert(P.PROFILE_FIELDS.every(f => ['one', 'many'].includes(f.type) && f.options.length >= 2));
});
test('アプリ：回答の作成にはアンケートをまとめた文と自由記述を合わせて渡し、設定の保存ではアンケートの答えを整えて残す。デスクトップ版にも入れる', () => {
  const m = readFileSync('local/manabo.js', 'utf8');
  assert(m.startsWith("import '../dist/profile-form.js';"));
  assert.match(
    m,
    /let profile=\[globalThis\.ProfileForm\.composeProfile\(this\.state\.settings\?\.profileForm\),profileNote\(\)\]/
  );
  const b = readFileSync('local/bridge.js', 'utf8');
  assert.match(b, /profileForm:globalThis\.ProfileForm\.cleanProfileForm\(profileForm\)/);
  assert.match(b, /profileForm:globalThis\.ProfileForm\.cleanProfileForm\(d\.profileForm\)/);
  assert.match(b, /req\.url==='\/profile-form\.js'/);
  assert(JSON.parse(readFileSync('package.json', 'utf8')).build.files.includes('dist/profile-form.js'));
  assert.match(
    readFileSync('dist/index.html', 'utf8'),
    /<script src="\.\/profile-form\.js\?v=sp-22"><\/script><script src="\.\/app\.js/
  );
});
