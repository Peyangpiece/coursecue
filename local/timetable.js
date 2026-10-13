// 時間割・出席の記録と、ガイダンス資料から読み取った授業情報の検証
const MODES=['対面','オンライン','オンデマンド','休講'],MARKS=['出席','遅刻','欠席','公欠'],WEEKDAYS=['月','火','水','木','金','土'];
const norm=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'');
// 引用が資料の本文に実在するか（空白・全角半角の違いは無視）。見つかった資料のファイル名を返す
export function quoteSource(evidence,materials){const q=norm(evidence);if(q.length<4)return null;return materials.find(m=>norm(m.text).includes(q))?.file||null}
// AI の出力から、資料に根拠がある値だけを残す
export function verifyCourseInfo(raw,materials){const out={};for(const [k,{value,evidence}] of Object.entries(raw||{})){if(typeof value!=='string'||!value.trim())continue;const file=quoteSource(evidence,materials);if(!file)continue;let v=value.trim();if(k==='mode'&&!MODES.slice(0,3).includes(v))continue;if(k==='absenceLimit'){const n=Number(v.normalize('NFKC'));if(!Number.isInteger(n)||n<0||n>15)continue;v=n}if(typeof v==='string')v=v.slice(0,200);out[k]={value:v,evidence:evidence.trim().slice(0,300),file}}return out}
// 回ごとの授業形式：引用が資料に実在し、引用の中に回番号と形式（の言い方）が書かれているものだけを残す
const modeWords={'対面':/対面|教室/,'オンライン':/オンライン|zoom|teams|webex|同時双方向|リアルタイム|ライブ/i,'オンデマンド':/オンデマンド|録画|動画/};
const hasNumber=(text,n)=>new RegExp(`(^|[^0-9])0?${n}([^0-9]|$)`).test(text);
// 資料のファイル名の「第N回」（なければ 0）
export const fileRound=name=>Number(String(name||'').normalize('NFKC').match(/第\s*0?(\d+)\s*回/)?.[1]||0);
// 第N回の資料の「次回は…」「本日は…」は、回番号が書かれていなくても N+1 回・N 回のこととして扱う
const impliedRound=(q,file,from,to)=>{const n=fileRound(file);return n>0&&from===to&&((from===n+1&&/次回/.test(q))||(from===n&&/今回|本日|今日/.test(q)))};
// 引用元の順番：シラバス・お知らせ → 第1回までの資料 → 第2回以降の資料（回の順）。画面は後のものを優先するので、新しい資料の記載が勝つ
const sourceOrder=file=>file==='シラバス'||file==='お知らせ'?-1:fileRound(file);
export function verifySessions(list,materials){const out=[];for(const r of Array.isArray(list)?list:[]){const {from,to,mode,evidence}=r||{};if(!Number.isInteger(from)||!Number.isInteger(to)||from<1||to>30||from>to)continue;if(!MODES.slice(0,3).includes(mode)||typeof evidence!=='string')continue;const file=quoteSource(evidence,materials);if(!file)continue;const q=evidence.normalize('NFKC');if(!modeWords[mode].test(q))continue;if(!(hasNumber(q,from)&&(to===from||hasNumber(q,to)))&&!impliedRound(q,file,from,to))continue;out.push({from,to,mode,evidence:evidence.trim().slice(0,300),file})}return out.map((x,i)=>[x,i]).sort(([a,i],[b,j])=>sourceOrder(a.file)-sourceOrder(b.file)||i-j).map(([x])=>x)}
// 第2回以降の資料からは、授業形式・休講・補講・次回の案内に触れた行（と前後の行）だけを抜き出す（全文だと長すぎるため。引用の確認はこの抜き出しに対して行う）
const modeLine=/オンデマンド|録画|動画|オンライン|zoom|teams|webex|同時双方向|リアルタイム|対面|教室|休講|補講|次回/i;
export function modeExcerpt(text,max=1500){const lines=String(text||'').split(/\r?\n/),keep=new Set();lines.forEach((l,i)=>{if(modeLine.test(l.normalize('NFKC')))for(const k of [i-1,i,i+1])if(k>=0&&k<lines.length)keep.add(k)});return [...keep].sort((a,b)=>a-b).map(k=>lines[k]).join('\n').slice(0,max)}
// 画面からの変更（job.kind==='timetable'）を検証して state に反映する。dist/timetable.js の applyTimetable と同じ規則
const courseKeys={weekday:v=>v===''||WEEKDAYS.includes(v),period:v=>v===null||(Number.isInteger(v)&&v>=1&&v<=7),room:v=>typeof v==='string'&&v.length<=50,mode:v=>v===''||MODES.slice(0,3).includes(v),limit:v=>v===null||(Number.isInteger(v)&&v>=0&&v<=15),ai:v=>v===''||v==='禁止'||v==='許可'};
const sessionKeys={mode:v=>v===''||MODES.includes(v),room:v=>typeof v==='string'&&v.length<=50,attendance:v=>v===''||MARKS.includes(v),note:v=>typeof v==='string'&&v.length<=200};
export function applyTimetablePatch(state,patch,courses){const {course,round,values}=patch||{};if(!courses.includes(course))throw Error('授業が見つかりません');if(round!==undefined&&!(Number.isInteger(round)&&round>=1&&round<=30))throw Error('回数が不正です');const rules=round===undefined?courseKeys:sessionKeys;if(!values||typeof values!=='object')throw Error('内容が不正です');for(const [k,v] of Object.entries(values))if(!rules[k]||!rules[k](v))throw Error(`${k} が不正です`);const set=(obj)=>{const cur={...obj};for(const [k,v] of Object.entries(values)){if(v===''||v===null)delete cur[k];else cur[k]=v}return cur};if(round===undefined){state.timetable={...state.timetable,[course]:set(state.timetable?.[course])}}else{const all={...state.sessions?.[course]},cur=set(all[round]);if(Object.keys(cur).length)all[round]=cur;else delete all[round];state.sessions={...state.sessions,[course]:all}}}
