import test from 'node:test';
import assert from 'node:assert/strict';
import {PERIOD_START, CAMPUSES, periodStart, courseSlot, sessionsOn, dueClassSyncs} from '../local/schedule.js';
import {src, rx} from './source.js';
// 授業の開始時刻に、その授業だけを自動で同期する（授業ごとの開始時刻はキャンパスで異なる）
const cal = {
  term: '2026 秋学期',
  rounds: {火: ['2026-10-06', '2026-10-13', '2026-10-20'], 水: ['2026-10-07', '2026-10-14']}
};
const state = () => ({
  settings: {},
  courses: [
    {name: '管理会計Ⅱ', id: '1'},
    {name: '経営科学Ⅱ', id: '2'},
    {name: '意思決定論', id: '3'},
    {name: '古い授業', id: '4', removed: true}
  ],
  timetable: {管理会計Ⅱ: {weekday: '火', period: 2}},
  cubics: {courses: {経営科学Ⅱ: {weekday: '火', period: 3}, 古い授業: {weekday: '火', period: 4}}, events: []},
  weekdays: {3: '水'},
  periods: {3: '1'}
});
const at = (date, hm) => new Date(`${date}T${hm}:00+09:00`);
test('授業の開始時刻：中京大学の授業時間（名古屋 1限 9:00〜、豊田 1限 9:30〜）', () => {
  assert.deepEqual(CAMPUSES, ['名古屋', '豊田']);
  assert.deepEqual(Object.values(PERIOD_START['名古屋']), ['09:00', '10:45', '13:10', '14:55', '16:40']);
  assert.deepEqual(Object.values(PERIOD_START['豊田']), ['09:30', '11:10', '13:30', '15:10', '16:50']);
  assert.equal(periodStart(2), '10:45');
  assert.equal(periodStart('2', '豊田'), '11:10');
  assert.equal(periodStart(2, '不明'), '10:45', '知らないキャンパスは名古屋');
  assert.equal(periodStart(6), '');
});
test('曜日・時限は 自分の設定 → CUBICS → manabo の表記 の順で決め、その日の授業を開始時刻つきで出す', () => {
  const s = state();
  assert.deepEqual(courseSlot(s, 0), {weekday: '火', period: 2});
  assert.deepEqual(courseSlot(s, 1), {weekday: '火', period: 3});
  assert.deepEqual(courseSlot(s, 2), {weekday: '水', period: 1});
  assert.deepEqual(
    sessionsOn(s, '2026-10-13', cal).map(x => [x.name, x.start]),
    [
      ['管理会計Ⅱ', '10:45'],
      ['経営科学Ⅱ', '13:10']
    ],
    '削除した授業は出さない'
  );
  assert.deepEqual(
    sessionsOn(s, '2026-10-14', cal).map(x => [x.name, x.start]),
    [['意思決定論', '09:00']]
  );
  s.settings.campus = '豊田';
  assert.deepEqual(
    sessionsOn(s, '2026-10-14', cal).map(x => x.start),
    ['09:30']
  );
  s.cubics.events.push({course: '経営科学Ⅱ', date: '2026-10-13', status: '休講'});
  assert.deepEqual(
    sessionsOn(s, '2026-10-13', cal).map(x => x.name),
    ['管理会計Ⅱ'],
    'CUBICS で休講の回は出さない'
  );
  s.schedules = {1: {5: '2026-10-17'}};
  assert.deepEqual(
    sessionsOn(s, '2026-10-17', cal).map(x => x.name),
    ['管理会計Ⅱ'],
    '自分で設定した授業日も数える'
  );
});
test('開始時刻を過ぎた授業を、その日にまだ同期していなければ同期の対象にする（開始から 2 時間まで）', () => {
  const s = state();
  const names = d => dueClassSyncs(s, d, cal).map(x => x.name);
  assert.deepEqual(names(at('2026-10-13', '10:44')), []);
  assert.deepEqual(names(at('2026-10-13', '10:45')), ['管理会計Ⅱ']);
  assert.deepEqual(names(at('2026-10-13', '12:45')), ['管理会計Ⅱ']);
  assert.deepEqual(names(at('2026-10-13', '12:46')), [], '2 時間を過ぎたら（止まっていた間の分は）同期しない');
  assert.deepEqual(names(at('2026-10-13', '13:20')), ['経営科学Ⅱ']);
  s.classSynced = {'2026-10-13': {経営科学Ⅱ: '2026-10-13T04:10:00.000Z'}};
  assert.deepEqual(names(at('2026-10-13', '13:20')), [], 'その日に同期した授業はもう同期しない');
  assert.deepEqual(names(at('2026-10-20', '13:20')), ['経営科学Ⅱ'], '別の日ならまた同期する');
  assert.deepEqual(names(at('2026-10-12', '13:20')), [], '授業日でない日は何もしない');
});
test('PC：授業の開始時刻になったらその授業だけ同期し、同じ日に二度は同期しない。設定で止められる。キャンパスは設定で選ぶ', () => {
  const bridge = src('local/bridge.js');
  assert.match(
    bridge,
    rx('const due=!state.billingBlocked&&state.settings?.classSync!==false?dueClassSyncs(state,now):[];')
  );
  assert.match(
    bridge,
    rx(
      'else if(due.length){const s=due[0];state.classSynced={[day]:{...(state.classSynced?.[day]||{}),[s.name]:new Date().toISOString()}};',
      /[\s\S]{0,80}?/,
      "run({kind:'sync',payload:{course:s.name}})"
    )
  );
  assert.match(bridge, rx('...(CAMPUSES.includes(campus)?{campus}:{})'));
  assert.match(bridge, rx("...(typeof classSync==='boolean'?{classSync}:{})"));
  const app = src('dist/app.js');
  assert.match(app, /id="classsync"/);
  assert.match(app, /id="campus"/);
  assert.match(app, rx("classSync:!!document.getElementById('classsync')?.checked"));
});
