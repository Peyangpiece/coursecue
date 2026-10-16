import test from 'node:test';
import assert from 'node:assert/strict';
import {calendar, scheduleFor, weekdayOf} from '../local/calendar.js';
const days = {日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6};
test('学年暦の授業日は曜日ごとに15回・昇順・正しい曜日', () => {
  for (const [w, dates] of Object.entries(calendar.rounds)) {
    assert.equal(dates.length, 15, w);
    assert.deepEqual([...dates].sort(), dates, w);
    for (const d of dates) assert.equal(new Date(d + 'T00:00:00Z').getUTCDay(), days[w], `${w} ${d}`);
  }
});
test('休講日を除き、授業を行う祝日（10/12）は含む', () => {
  const all = Object.values(calendar.rounds).flat();
  for (const d of ['2026-10-30', '2026-11-03', '2026-11-23', '2027-01-11', '2026-12-28', '2027-01-01'])
    assert(!all.includes(d), d);
  assert(calendar.rounds['月'].includes('2026-10-12'));
});
test('授業名の表記から曜日を読み取る', () => {
  assert.equal(weekdayOf('経済原論Ⅱ（金曜／2限）'), '金');
  assert.equal(weekdayOf('国際ビジネス戦略 (火曜/3限)'), '火');
  assert.equal(weekdayOf('トップページ'), null);
  assert.equal(scheduleFor('火')['1'], '2026-09-29');
  assert.equal(scheduleFor('日'), null);
});
test('学年暦：期間が終わったら（学期が変わったら）だけ公開中の学年暦を確かめ（1 日 1 回）、新しい学年暦を取り込んで作業フォルダに残す。古い・壊れた学年暦や取れないときは今のものを使う', async t => {
  const {refreshCalendar, calendarEnd, validCalendar} = await import('../local/calendar.js');
  const {mkdtemp, rm, readFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'coursecue-cal-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const cache = join(dir, 'academic-calendar.json'),
    end = calendarEnd();
  let calls = 0;
  const res = body => async () => {
    calls++;
    return {ok: true, json: async () => body};
  };
  const next = {term: '2027 春学期', rounds: {月: ['2027-04-12', '2027-07-19'], 火: ['2027-04-13']}};
  await refreshCalendar({cache, url: 'u', fetchFn: res(next), today: end});
  assert.equal(calls, 0, '期間中は確かめない');
  assert.equal(calendarEnd(), end);
  const after = ['2027-02-01', '2027-02-02', '2027-02-03', '2027-02-04'];
  const old = {term: '古い学期', rounds: {月: ['2020-04-06']}};
  await refreshCalendar({cache, url: 'u', fetchFn: res(old), today: after[0]});
  assert.equal(calendarEnd(), end, '古い学期には戻さない');
  await refreshCalendar({cache, url: 'u', fetchFn: res(next), today: after[0]});
  assert.equal(calls, 1, '同じ日は 1 回だけ確かめる');
  await refreshCalendar({cache, url: 'u', fetchFn: res({term: 'x', rounds: {日: ['2099-01-01']}}), today: after[1]});
  assert.equal(calendarEnd(), end, '形の違う学年暦は使わない');
  await refreshCalendar({
    cache,
    url: 'u',
    fetchFn: async () => {
      throw Error('offline');
    },
    today: after[2]
  });
  assert.equal(calendarEnd(), end, '取れなくても続ける');
  const c = await refreshCalendar({cache, url: 'u', fetchFn: res(next), today: after[3]});
  assert.equal(c.term, '2027 春学期');
  assert.equal(calendarEnd(), '2027-07-19');
  assert.deepEqual(scheduleFor('月'), {1: '2027-04-12', 2: '2027-07-19'}, '取り込んだ学年暦で授業日を決める');
  assert.deepEqual(JSON.parse(await readFile(cache, 'utf8')), next, '次の起動のために残す');
  assert.equal(validCalendar(old), true);
});
