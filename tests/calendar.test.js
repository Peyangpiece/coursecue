import test from 'node:test';import assert from 'node:assert/strict';import {calendar,scheduleFor,weekdayOf} from '../local/calendar.js';
const days={'日':0,'月':1,'火':2,'水':3,'木':4,'金':5,'土':6};
test('学年暦の授業日は曜日ごとに15回・昇順・正しい曜日',()=>{for(const [w,dates] of Object.entries(calendar.rounds)){assert.equal(dates.length,15,w);assert.deepEqual([...dates].sort(),dates,w);for(const d of dates)assert.equal(new Date(d+'T00:00:00Z').getUTCDay(),days[w],`${w} ${d}`)}});
test('休講日を除き、授業を行う祝日（10/12）は含む',()=>{const all=Object.values(calendar.rounds).flat();for(const d of ['2026-10-30','2026-11-03','2026-11-23','2027-01-11','2026-12-28','2027-01-01'])assert(!all.includes(d),d);assert(calendar.rounds['月'].includes('2026-10-12'))});
test('授業名の表記から曜日を読み取る',()=>{assert.equal(weekdayOf('経済原論Ⅱ（金曜／2限）'),'金');assert.equal(weekdayOf('国際ビジネス戦略 (火曜/3限)'),'火');assert.equal(weekdayOf('トップページ'),null);assert.equal(scheduleFor('火')['1'],'2026-09-29');assert.equal(scheduleFor('日'),null)});
