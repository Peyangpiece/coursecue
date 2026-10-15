import {readFileSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
// 大学の学年暦（dist/academic-calendar.json）から、曜日ごとの第1〜15回の授業日を返す
// 同梱の学年暦は版を出したときのもの。今の学年暦の期間が終わったら（学期が変わったら）、同期のときに公開中の学年暦（管理者画面で更新したもの。/api/academic-calendar）を確かめて取り込み、作業フォルダに残して次の起動からも使う（新しい学期の分を配布し直さずに届ける）。確かめるのは 1 日 1 回まで
export let calendar=JSON.parse(readFileSync(new URL('../dist/academic-calendar.json',import.meta.url),'utf8'));
const WEEKDAYS=['月','火','水','木','金','土'],DATE=/^\d{4}-\d{2}-\d{2}$/;
export const validCalendar=c=>!!c&&typeof c.term==='string'&&!!c.rounds&&typeof c.rounds==='object'&&Object.keys(c.rounds).length>0&&Object.entries(c.rounds).every(([k,v])=>WEEKDAYS.includes(k)&&Array.isArray(v)&&v.length<=30&&v.every(d=>typeof d==='string'&&DATE.test(d)));
// 学年暦の最後の授業日（期間が終わったかの判定に使う）
export const calendarEnd=(c=calendar)=>Object.values(c.rounds).flat().sort().at(-1)||'';
// 期間が同じか後で、中身が違えば新しい学年暦とみなす（同じ学期の訂正も届く）
const later=(a,b)=>calendarEnd(a)>=calendarEnd(b)&&JSON.stringify(a)!==JSON.stringify(b);
// cache：作業フォルダの学年暦。url：公開中の学年暦。古い学期には戻さない。取れなくても同梱・前回の分で続ける
let checkedOn='';
export async function refreshCalendar({cache,url,fetchFn=fetch,today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})}={}){try{const saved=JSON.parse(await readFile(cache,'utf8'));if(validCalendar(saved)&&later(saved,calendar))calendar=saved}catch{}
 if(!url||calendarEnd()>=today||checkedOn===today)return calendar;checkedOn=today;try{const r=await fetchFn(url,{signal:AbortSignal.timeout?.(10000)});if(r.ok){const c=await r.json();if(validCalendar(c)&&later(c,calendar)){calendar=c;await writeFile(cache,JSON.stringify(c),{mode:0o600}).catch(()=>{})}}}catch{}return calendar}
export const weekdayOf=text=>String(text||'').normalize('NFKC').match(/[(（]\s*([月火水木金土])曜/)?.[1]||null;
export const periodOf=text=>{const n=Number(String(text||'').normalize('NFKC').match(/[(（]\s*[月火水木金土]曜\s*[/・]?\s*(\d)\s*限/)?.[1]);return n>=1&&n<=7?n:null};
export function scheduleFor(weekday){const dates=calendar.rounds[weekday];return dates?Object.fromEntries(dates.map((d,i)=>[String(i+1),d])):null}
