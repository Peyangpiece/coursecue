// ChatGPT・Claude の書き出し（zip）の取り込み。本人が書き出しを押してダウンロードした zip を「ダウンロード」フォルダから見つけ、
// 本人が書いたメッセージのうち学業に関係するものだけを取り出す（パソコンの中で行う。AI に送るのは選んだ部分だけ）
// 書き出しの形は版によって違う（conversations.json・conversations-000.json・personal/conversations/conversations.json など）ので、特定の形に頼らず、
// 会話のデータの中から「本人が書いたメッセージ」（ChatGPT は author.role が user、Claude は sender が human）を拾う
import AdmZip from 'adm-zip';import {readdir,stat} from 'node:fs/promises';import {join} from 'node:path';
const ZIP_MAX=300e6,ENTRY=/(^|\/)conversations[^/]*\.json$/i;
// 学業に関係する会話（題名か本人のメッセージにこれらの言葉がある）
export const STUDY=/授業|講義|レポート|課題|大学|ゼミ|卒論|卒業論文|学部|学科|履修|単位|期末|試験|テスト|発表|論文|研究|シラバス|サークル|部活|アルバイト|バイト|就活|インターン|資格|留学|将来|進路/;
// 「ダウンロード」フォルダで、since 以降にできた書き出しの zip を探す（ダウンロード中のものを読まないよう、10 秒以上変わっていないものだけ）
export async function findExportZip(dir,since,now=Date.now()){let names=[];try{names=await readdir(dir)}catch{return null}const found=[];for(const name of names){if(!/\.zip$/i.test(name))continue;const path=join(dir,name);let st;try{st=await stat(path)}catch{continue}if(st.mtimeMs<since||now-st.mtimeMs<10000||st.size>ZIP_MAX)continue;try{if(new AdmZip(path).getEntries().some(e=>ENTRY.test(e.entryName)))found.push({path,at:st.mtimeMs})}catch{}}return found.sort((a,b)=>b.at-a.at)[0]?.path||null}
const textOf=v=>typeof v==='string'?v:Array.isArray(v)?v.map(textOf).filter(Boolean).join('\n'):v&&typeof v==='object'?textOf(v.text??v.parts??v.content??''):'';
const mine=o=>o?.author?.role==='user'||o?.sender==='human'||o?.sender==='user'||o?.role==='user';
const timeOf=v=>{const n=typeof v==='number'?(v<1e12?v*1000:v):Date.parse(v);return Number.isFinite(n)?n:0};
// 1 つの会話から、題名・時刻・本人のメッセージを取り出す（ChatGPT は mapping の中、Claude は chat_messages の中。どちらでもなければ中をたどる）
function conversation(c){const messages=[],seen=new WeakSet();const walk=o=>{if(!o||typeof o!=='object'||seen.has(o))return;seen.add(o);if(Array.isArray(o)){o.forEach(walk);return}const m=o.message&&typeof o.message==='object'?o.message:o;if(mine(m)){const t=textOf(m.content??m.text??'').trim()||textOf(m.text).trim();if(t)messages.push({text:t,at:timeOf(m.create_time??m.created_at)});return}for(const v of Object.values(o))if(v&&typeof v==='object')walk(v)};walk(c.mapping??c.chat_messages??c.messages??c);return {title:String(c.title??c.name??'').slice(0,100),at:timeOf(c.update_time??c.updated_at??c.create_time??c.created_at),messages}}
// zip の中の会話をすべて読む。source：ChatGPT か Claude か（分からなければ「AI のチャット」）
export function readExport(path){const zip=new AdmZip(path),entries=zip.getEntries(),names=entries.map(e=>e.entryName);const source=names.some(n=>/chat\.html$|message_feedback\.json$|model_comparisons\.json$/i.test(n))?'ChatGPT':names.some(n=>/users\.json$|projects\.json$/i.test(n))?'Claude':'AI のチャット';const conversations=[];for(const e of entries){if(!ENTRY.test(e.entryName))continue;let data;try{data=JSON.parse(e.getData().toString('utf8'))}catch{continue}const list=Array.isArray(data)?data:Array.isArray(data?.conversations)?data.conversations:[data];for(const c of list)if(c&&typeof c==='object')conversations.push(conversation(c))}return {source,conversations:conversations.filter(c=>c.messages.length)}}
// 学業に関係する会話から、本人のメッセージを新しい順に選ぶ（1 件 500 字、全体で max 字まで）
export function selectStudy(conversations,max=30000){const out=[];let size=0;const related=conversations.filter(c=>STUDY.test(c.title)||c.messages.some(m=>STUDY.test(m.text))).sort((a,b)=>b.at-a.at);for(const c of related){const msgs=c.messages.filter(m=>STUDY.test(m.text)||STUDY.test(c.title)).map(m=>m.text.replace(/\s+/g,' ').slice(0,500));if(!msgs.length)continue;const item={title:c.title,messages:[]};for(const t of msgs){if(size+t.length>max)break;item.messages.push(t);size+=t.length}if(item.messages.length)out.push(item);if(size>=max)break}return out}
