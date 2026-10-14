import {appendFile,mkdir} from 'node:fs/promises';import {dirname} from 'node:path';
// AI の使用量の記録：生成 1 回ごとに手段・トークン数・時間を usage.jsonl に 1 行ずつ追記し、月ごとの集計を state.usage に持つ（画面に出す）
// 料金を決めるための実測用。Claude API・Claude Code は実際のトークン数、Codex は今の呼び出し方ではトークン数が分からないので回数と文字数だけ
// 目安の料金は「こちらの API（Claude Sonnet 5.5）で同じ量を通常料金で作った場合」。1M トークンあたり 入力 $2・出力 $10・キャッシュ読み $0.20・キャッシュ書き $2.50。Batch はこの半額
export const SONNET_PRICE={input:2,output:10,cacheRead:0.2,cacheWrite:2.5};
export const estimateUsd=u=>u&&Number.isFinite(u.input)&&Number.isFinite(u.output)?((u.input*SONNET_PRICE.input)+(u.output*SONNET_PRICE.output)+((u.cacheRead||0)*SONNET_PRICE.cacheRead)+((u.cacheWrite||0)*SONNET_PRICE.cacheWrite))/1e6:null;
// 月は端末の時刻で区切る（日本時間の月初で切り替わる）
export const monthOf=(d=new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
const KEEP=3,num=v=>Number.isFinite(v)?v:0;
// 月ごとの集計に 1 件を足す（元の値は変えずに新しい値を返す）。直近 3 か月分だけ残す
export function addUsage(usage,e,now=new Date()){const months={...(usage?.months||{})},key=monthOf(now),m=structuredClone(months[key]||{calls:0,failed:0,tokens:{calls:0,input:0,output:0,cacheRead:0,cacheWrite:0},costUsd:0,estimateUsd:0,byProvider:{},byLabel:{}});
 m.calls++;if(!e.ok)m.failed++;const p=m.byProvider[e.provider]||={calls:0,failed:0,chars:0};p.calls++;if(!e.ok)p.failed++;p.chars+=num(e.chars);if(e.ok)m.byLabel[e.label]=(m.byLabel[e.label]||0)+1;
 if(Number.isFinite(e.input)&&Number.isFinite(e.output)){const t=m.tokens;t.calls++;t.input+=e.input;t.output+=e.output;t.cacheRead+=num(e.cacheRead);t.cacheWrite+=num(e.cacheWrite);m.estimateUsd+=estimateUsd(e)||0}
 if(Number.isFinite(e.costUsd))m.costUsd+=e.costUsd;months[key]=m;return {months:Object.fromEntries(Object.entries(months).sort(([a],[b])=>b.localeCompare(a)).slice(0,KEEP))}}
// 1 件ずつ JSON の行で追記する（失敗しても生成は止めない）
export function usageLog(file){return {file,async record(e){await mkdir(dirname(file),{recursive:true});await appendFile(file,JSON.stringify(e)+'\n',{mode:0o600})}}}
