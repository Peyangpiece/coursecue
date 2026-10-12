import { createHash } from 'node:crypto';
export const LMS='https://manabo.cnc.chukyo-u.ac.jp';
export const COURSES=[['人材マネジメントⅡ','103578'],['コーポレートファイナンスⅡ','103901'],['国際ビジネス戦略','103576'],['サービス・マーケティング','103573'],['意思決定論','103889'],['管理会計Ⅱ','103904'],['マーケティング戦略','103572'],['ボランティア','103736'],['経営科学Ⅱ','103887'],['経済言論Ⅱ','103914'],['言葉と文化','104493'],['ゼミナールⅣ','']];
// manabo の授業 ID が未設定（''）の授業は、同期のときに manabo の授業一覧から名前で探して state.courseIds に記録する
export const courseIdOf=(i,state)=>COURSES[i]?.[1]||state?.courseIds?.[COURSES[i]?.[0]]||'';
// 授業の既定の曜日・時限・教室（本人が時間割で設定していないときだけ入れる）
export const COURSE_DEFAULTS={'ゼミナールⅣ':{weekday:'月',period:4,room:'521'}};
// 授業一覧のリンクの文字から授業を探す（全角半角・ローマ数字・空白の違いは無視）
const nameKey=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'').replace(/II/g,'Ⅱ').replace(/IV/g,'Ⅳ').replace(/III/g,'Ⅲ');
export function findClassLinks(links,names){const out={};for(const name of names){const k=nameKey(name);const hit=links.filter(l=>nameKey(l.text).includes(k)).map(l=>String(l.href||'').match(/\/class\/(\d+)/)?.[1]).filter(Boolean);if(new Set(hit).size===1)out[name]=hit[0]}return out}
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const validLms=v=>{const u=new URL(v,LMS);if(u.origin!==LMS)throw Error('許可されていないURL');return u.href};
// 漢数字の回（第二回・第十二回）を算用数字に直す（1〜19）
const KANJI='〇一二三四五六七八九';export const kanjiToNumber=s=>{const t=String(s||'');if(/^\d+$/.test(t))return Number(t);if(!/^[〇一二三四五六七八九十]+$/.test(t))return 0;if(t==='十')return 10;const [a,b]=t.split('十');if(b===undefined)return t.length===1?KANJI.indexOf(t):0;return (a?KANJI.indexOf(a):1)*10+(b?KANJI.indexOf(b):0)};
export const normalizeRounds=s=>String(s||'').normalize('NFKC').replace(/第\s*([〇一二三四五六七八九十]+)\s*([回講])/g,(m,k,u)=>{const n=kanjiToNumber(k);return n?`第${n}${u}`:m}).replace(/([〇一二三四五六七八九十]+)\s*回目/g,(m,k)=>{const n=kanjiToNumber(k);return n?`${n}回目`:m});
export const roundOf=s=>{const t=normalizeRounds(s);const m=t.match(/第\s*(\d+)\s*[回講]/)||t.match(/(\d+)\s*回目/);return Number(m?.[1]||0)};
// 「第3回」を manabo の表記ゆれ（全角・漢数字）ごと探す正規表現の元
const FULL=d=>String(d).replace(/\d/g,x=>String.fromCharCode(0xff10+Number(x)));const KAN=n=>n<10?KANJI[n]:n===10?'十':n<20?'十'+KANJI[n-10]:String(n);
export const roundPattern=n=>`第\\s*(?:${n}|${FULL(n)}|${KAN(n)})\\s*回`;
export const contentType=url=>/\/quiz\//.test(url)?'クイズ':/\/board\//.test(url)?'掲示板':'レポート';
export const attendance=s=>/出席.{0,12}(コード|番号|確認)|attendance.{0,12}code/i.test(s);
export function lectureDate(title,schedule,round){const m=title.match(/(?:(20\d{2})[年/.-])?(\d{1,2})[月/.-](\d{1,2})日?/);if(m){const year=Number(m[1]||2026)+(Number(m[2])<4&&!m[1]?1:0);return `${year}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`}return schedule?.[round]||null}
export const inWindow=(date,now=new Date())=>{if(!date)return false;const today=new Date(now).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});return Math.abs(new Date(date+'T00:00:00Z')-new Date(today+'T00:00:00Z'))<=7*86400000};
// 締切：「受講期間: ～ 10月13日(火) 00:00」のように範囲の終わりを優先し、「10月13日 00:00 ～」のような開始だけの日時は締切にしない
// 「10月19日 24:00」「10月19日(月)24時」「10/19 23時59分」の形。24時は翌日 0 時として扱う
export function deadline(raw){const text=String(raw||'').normalize('NFKC');const all=[...text.matchAll(/(?:(20\d{2})[年/])?(\d{1,2})[月/](\d{1,2})日?[^\d]{0,8}(\d{1,2})(?::(\d{2})|時(?![限間点代])(?:(\d{1,2})分)?)/g)].map(m=>{m[5]=m[5]||m[6]||'00';return m});if(!all.length)return null;const tilde=/[～〜~\-－−―—–ー‐]/;const ends=all.filter(m=>tilde.test(text.slice(Math.max(0,m.index-12),m.index)));const starts=all.filter(m=>tilde.test(text.slice(m.index+m[0].length,m.index+m[0].length+6)));const m=ends.length?ends.at(-1):starts.length===all.length?null:all.filter(x=>!starts.includes(x)).at(-1);if(!m)return null;let y=Number(m[1]||2026)+(Number(m[2])<4&&!m[1]?1:0),h=Number(m[4]);return new Date(Date.UTC(y,Number(m[2])-1,Number(m[3]),h-9,Number(m[5]))).toISOString()}
// 資料・課題ページ・注意点の本文から「提出期限」「締切」「まで」の行を集めて締切を読む。見つかれば {dueAt,line}
export function deadlineFromText(raw){const lines=String(raw||'').split('\n').map(x=>x.trim()).filter(x=>/期限|締切|〆切|まで|期間/.test(x)&&/\d/.test(x));if(!lines.length)return null;const dueAt=deadline(lines.join('\n'));return dueAt?{dueAt,line:lines.find(l=>deadline(l)===dueAt)||lines[0]}:null}
export function deadlineFromMaterials(source){for(const m of source||[]){const d=deadlineFromText(m.text);if(d)return {...d,file:m.file}}return null}
export function submissionGate(task,generation,questions){if(task.status==='done')return 'already_submitted';if(task.submissionIntent)return 'result_unknown';if(questions.some(q=>attendance(q.text)))return 'attendance';if(!generation||!generation.grounded||generation.needsUser.length)return 'needs_user';if(task.dueAt&&new Date(task.dueAt)<new Date())return 'expired';for(const q of questions.filter(q=>q.type!=='hidden')){const a=generation.answers.find(a=>a.name===q.name);if(!a||!a.evidence.trim())return 'missing_answer';if(q.type==='radio'&&!q.options.some(o=>o.value===a.value))return 'invalid_answer';if(q.type==='checkbox'&&a.values.some(v=>!q.options.some(o=>o.value===v)))return 'invalid_answer'}return 'ok'}
