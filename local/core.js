import { createHash } from 'node:crypto';
export const LMS='https://manabo.cnc.chukyo-u.ac.jp';
// 最初の利用者（2026 秋学期）の授業。新しい利用者は manabo の授業一覧から自動で取る（state.courses）
export const LEGACY_COURSES=[['人材マネジメントⅡ','103578'],['コーポレートファイナンスⅡ','103901'],['国際ビジネス戦略','103576'],['サービス・マーケティング','103573'],['意思決定論','103889'],['管理会計Ⅱ','103904'],['マーケティング戦略','103572'],['ボランティア','103736'],['経営科学Ⅱ','103887'],['経済言論Ⅱ','103914'],['言葉と文化','104493'],['ゼミナールⅣ','']];
// manabo の授業 ID が未設定（''）の授業は、同期のときに manabo の授業一覧から名前で探して state.courseIds に記録する
// 利用者の授業一覧（[{name,id}]）。state.courses がなければ最初の利用者の固定一覧。t.course はこの並びの番号なので、並びは追加だけで変えない
export const courseList=state=>state?.courses??LEGACY_COURSES.map(([name,id])=>({name,id}));
export const courseNames=state=>courseList(state).map(c=>c.name);
export const courseIdOf=(i,state)=>courseList(state)[i]?.id||state?.courseIds?.[courseList(state)[i]?.name]||'';
// manabo の授業一覧のリンクの文字から授業名を取り出す（「（月曜／3限）」などの付記を除く）
export const courseNameOf=text=>String(text||'').replace(/\s+/g,' ').trim().replace(/[（(][^（()）]*[曜限時][^（()）]*[)）]\s*$/,'').trim();
// 授業の既定の曜日・時限・教室（本人が時間割で設定していないときだけ入れる）
export const COURSE_DEFAULTS={'ゼミナールⅣ':{weekday:'月',period:4,room:'521'}};
// 授業一覧のリンクの文字から授業を探す（全角半角・ローマ数字・空白の違いは無視）
const nameKey=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'').replace(/II/g,'Ⅱ').replace(/IV/g,'Ⅳ').replace(/III/g,'Ⅲ');
// 授業一覧のリンクから授業を更新する：ID が同じものは既存、名前が同じで ID のないものには ID を入れ、それ以外は末尾に足す。消えた授業は残す（課題が番号で参照しているため）
export function mergeCourses(courses,links){const out=courses.map(c=>({...c}));for(const l of links){const id=String(l.href||'').match(/\/class\/(\d+)/)?.[1],name=courseNameOf(l.text);if(!id||!name)continue;if(out.some(c=>c.id===id))continue;const same=out.find(c=>!c.id&&nameKey(c.name)===nameKey(name));if(same){same.id=id;continue}out.push({name,id})}return out}
// 授業の削除：一覧の並び（t.course の番号）は変えずに removed を付け、以後の同期では読まない。課題と資料の記録は removedCourseData に移し、元に戻すときに戻す（ダウンロード済みのファイルは消さない）
export function removeCourse(state,name){if(!state.courses)state.courses=courseList(state).map(c=>({...c}));const i=state.courses.findIndex(c=>c.name===name);if(i<0)throw Error('授業がありません');const c=state.courses[i];if(c.removed)return {tasks:0};c.removed=true;c.removedAt=new Date().toISOString();const tasks=(state.tasks||[]).filter(t=>t.course===i),materials=(state.materials||[]).filter(m=>m.course===name);state.tasks=(state.tasks||[]).filter(t=>t.course!==i);state.materials=(state.materials||[]).filter(m=>m.course!==name);state.removedCourseData={...state.removedCourseData,[name]:{tasks,materials}};return {tasks:tasks.length}}
export function restoreCourse(state,name){const c=(state.courses||[]).find(c=>c.name===name);if(!c)throw Error('授業がありません');if(!c.removed)return;delete c.removed;delete c.removedAt;const kept=state.removedCourseData?.[name];if(kept){state.tasks=[...(state.tasks||[]),...kept.tasks];state.materials=[...(state.materials||[]),...kept.materials];const {[name]:_,...rest}=state.removedCourseData;state.removedCourseData=rest}}
// 課題の AI 利用の方針。その回の授業資料と課題の説明に「生成AIの使用を禁止」などの記載があれば禁止とする（AI がない端末でも判断できるよう文の照合で行う）
// 禁止の回の課題でも回答は参考として作るが、saboro から manabo への提出はしない（レポート・掲示板は入力もしない。クイズは回答の入力まで行い、提出は本人）。記載のない回はこれまでどおり
const AI_WORD='(?:生成\\s*AI|生成系\\s*AI|対話型\\s*AI|ChatGPT|Chat\\s*GPT|Copilot|Gemini|Claude|AI\\s*ツール|人工知能|(?<![A-Za-z])AI(?![A-Za-z]))';
const AI_FORBID=new RegExp(`${AI_WORD}[^。\\n]{0,40}(?:禁止|不可|認めない|認められない|認めません|(?:使用|利用|使)(?:わ|し)?ないこと|(?:使用|利用)(?:は|を)?(?:しない|できない|できません)|用いないこと|用いてはいけない|使ってはいけない)|(?:禁止|不可)[^。\\n]{0,20}${AI_WORD}`);
const AI_ALLOWED=/禁止(?:し|では|は)?(?:ない|ありません|しません)|不可ではない|(?:使用|利用|使)して(?:も)?(?:よい|良い|構わない|かまわない|可)|許可|認め(?:る|ます)(?!ん)|活用してください|使ってください/;
export function aiPolicyFrom(sources){for(const m of sources||[]){for(const line of String(m.text||'').split(/\n|。/)){const l=line.replace(/\s+/g,' ').trim();if(l&&AI_FORBID.test(l)&&!AI_ALLOWED.test(l))return {forbidden:true,evidence:l.slice(0,200),file:m.file}}}return null}
// 自分の設定（授業の設定の「AI の利用」）があればそれを、なければその回の資料から判断した結果（t.aiPolicy）を使う
export function aiForbidden(state,t,name){const own=state?.timetable?.[name]?.ai;if(own==='禁止')return true;if(own==='許可')return false;return !!t?.aiPolicy?.forbidden}
export const AI_FORBIDDEN_ACTION='この回は AI の利用が禁止されています。この回答は参考です。自分で書いて manabo で提出してください（saboro からは提出しません）';
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
