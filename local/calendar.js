import {readFileSync} from 'node:fs';
// 大学の学年暦（dist/academic-calendar.json）から、曜日ごとの第1〜15回の授業日を返す
export const calendar=JSON.parse(readFileSync(new URL('../dist/academic-calendar.json',import.meta.url),'utf8'));
export const weekdayOf=text=>String(text||'').normalize('NFKC').match(/[(（]\s*([月火水木金土])曜/)?.[1]||null;
export function scheduleFor(weekday){const dates=calendar.rounds[weekday];return dates?Object.fromEntries(dates.map((d,i)=>[String(i+1),d])):null}
