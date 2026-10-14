// SaBoRo の AI：こちらの Anthropic の API キー（Worker の秘密 SABORO_ANTHROPIC_API_KEY）で回答を作る。利用者の PC にはキーを渡さない
// 使える人：全員（プランで分けない。支払いが必要なら定期支払いが有効な人）。本人の PC の Codex・Claude Code が使えるときはそちらを先に使う（アプリ側）。月の「課題生成」は無料分（既定 60 回）まで定額、
// それを超えた後の回は使用量（トークン）に応じて実費×上乗せ率（既定 1.5 倍）を円で請求する（毎日まとめて Stripe の請求項目にし、次の月額の請求に加算）
// 急ぐ依頼（本人が画面で頼んだもの・締切まで 24 時間以内）は通常の API、それ以外は Batch（半額。通常 1 時間以内、最大 24 時間）
import Anthropic from '@anthropic-ai/sdk';
import {billingOf,ACTIVE} from './billing.js';
import {currentMonth,DEFAULT_SETTINGS} from './admin.js';
export const MODEL='claude-sonnet-5-5',MAX_TOKENS=64000,DAILY_LIMIT=200,LABELS=['課題生成','授業情報の読み取り'];
// 1M トークンあたりのドル（通常料金）。キャッシュの書き込みは 5 分のキャッシュ（入力の 1.25 倍）。Batch はすべて半額
export const PRICES={'claude-sonnet-5-5':{input:2,output:10,cacheRead:0.2,cacheWrite:2.5}};
// 知らないモデル名（将来の変更など）は高めの料金で見積もる（安く見積もって損をしないように）
const FALLBACK_PRICE={input:4,output:20,cacheRead:0.2,cacheWrite:5};
export function costUsd(usage={},{model=MODEL,batch=false}={}){const p=PRICES[model]||FALLBACK_PRICE,n=k=>Number(usage[k])||0;const usd=(n('input_tokens')*p.input+n('output_tokens')*p.output+n('cache_read_input_tokens')*p.cacheRead+n('cache_creation_input_tokens')*p.cacheWrite)/1e6;return batch?usd/2:usd}
// 請求額（100 万分の 1 円単位の整数）：実費×為替×上乗せ率
export const chargeMicro=(usd,{usdJpy,markup})=>Math.round(usd*usdJpy*markup*1e6);
export const aiSettings=s=>{const x={...DEFAULT_SETTINGS,...s};return {included:Number.isInteger(x.aiIncluded)?x.aiIncluded:60,markup:typeof x.aiMarkup==='number'?x.aiMarkup:1.5,usdJpy:x.usdJpy}};
const jstDay=(now=new Date())=>new Date(now.getTime()+9*3600e3).toISOString().slice(0,10),dayStart=now=>new Date(`${jstDay(now)}T00:00:00+09:00`).toISOString();
// テストで Anthropic・Stripe を差し替える
let makeClient=key=>new Anthropic({apiKey:key,maxRetries:2});let stripeFetch=(...a)=>fetch(...a);
export function setAiTestHooks({client,fetch:f}={}){if(client)makeClient=client;if(f)stripeFetch=f}
const params=(text,schema)=>({model:MODEL,max_tokens:MAX_TOKENS,output_config:{effort:'high',format:{type:'json_schema',schema}},messages:[{role:'user',content:text}]});
// 出力の本文（構造化出力の JSON 文字列）。拒否・途中で切れた場合は理由を返す
function outcome(message){if(message?.stop_reason==='refusal')return {reason:'回答を拒否されました'};if(message?.stop_reason==='max_tokens')return {reason:'出力が上限で途切れました'};const text=message?.content?.find?.(b=>b.type==='text')?.text;return text?{text}:{reason:'出力なし'}}
// 今月の状態：無料分の残り・超過分の金額・使えるか（使えなければ理由）
export async function aiStatus(store,env,account,now=new Date()){const month=currentMonth(now);const [settings,plan,subs,stats,today]=await Promise.all([store.getAdminSettings(),store.planOf(account),store.subscriptionsOf(account),store.aiMonthStats(account,month),store.aiDayCalls(account,dayStart(now))]);const s=aiSettings(settings),billing=billingOf({account,settings,plan,subs});
 const subscribed=subs.some(x=>ACTIVE.includes(x.status)),overage=subscribed&&!!env.STRIPE_API_KEY,base={month,included:s.included,used:stats.count,overageYen:Math.round(stats.chargeMicro/1e6),overage};
 const reason=!env.SABORO_ANTHROPIC_API_KEY?'not_configured':!billing.allowed?'payment_required':today>=DAILY_LIMIT?'daily_limit':stats.count>=s.included&&!overage?'limit':'';return {...base,available:!reason,reason}}
// 1 回分の使用量を記録する。月の「課題生成」が無料分に達した後なら請求の対象
async function record(store,{account,label,mode,message,settings,now=new Date()}){const month=currentMonth(now),s=aiSettings(settings),usage=message?.usage||{},model=message?.model||MODEL,usd=costUsd(usage,{model,batch:mode==='batch'});const stats=await store.aiMonthStats(account,month),billable=stats.count>=s.included;
 await store.addAiUsage({id:crypto.randomUUID(),account,month,label,mode,model,input:Number(usage.input_tokens)||0,output:Number(usage.output_tokens)||0,cache_read:Number(usage.cache_read_input_tokens)||0,cache_write:Number(usage.cache_creation_input_tokens)||0,cost_usd:usd,billable:billable?1:0,charge_micro:billable?chargeMicro(usd,s):0,created:now.toISOString()})}
// Batch の状態を確かめ、終わっていれば結果を保存して使用量を記録する（何度呼んでも記録は 1 回）
async function settle(store,env,row,now=new Date()){if(row.status!=='pending')return row;const client=makeClient(env.SABORO_ANTHROPIC_API_KEY);const batch=await client.messages.batches.retrieve(row.batch_id);if(batch.processing_status!=='ended')return row;
 let message=null,reason='結果を取得できません';for await(const r of await client.messages.batches.results(row.batch_id)){if(r.result?.type==='succeeded')message=r.result.message;else reason=r.result?.type==='expired'?'24時間以内に作成できませんでした':r.result?.type==='canceled'?'取り消されました':'作成に失敗しました'}
 const out=message?outcome(message):{reason},status=out.text?'done':'failed',updated=now.toISOString();if(!(await store.finishAiRequest(row.id,{status,result:out.text||null,reason:out.reason||null,updated})))return store.getAiRequest(row.account,row.key);
 if(message)await record(store,{account:row.account,label:row.label,mode:'batch',message,settings:await store.getAdminSettings(),now}).catch(()=>{});return {...row,status,result:out.text||null,reason:out.reason||null}}
// 依頼：mode now（すぐ）／batch（急がない。同じ key は 1 件にまとめ、結果が出るまで pending を返す）
// 返す形：{status:'done',text}／{status:'pending'}／{status:'failed',reason}／{error}（使えない）
export async function handleAi(req,u,env,store,account,{json,origin,ctx}){const now=new Date();
 if(u.pathname==='/api/agent/ai'&&req.method==='GET')return json(await aiStatus(store,env,account,now),200,origin);
 if(u.pathname==='/api/agent/ai/ready'&&req.method==='POST'){const d=await req.json().catch(()=>({}));const keys=Array.isArray(d.keys)?d.keys.filter(k=>typeof k==='string'&&k.length<=128).slice(0,50):[];const ready=[];for(const key of keys){let row=await store.getAiRequest(account,key);if(!row)continue;try{row=await settle(store,env,row,now)}catch{continue}if(row.status!=='pending')ready.push(key)}return json({ready},200,origin)}
 if(u.pathname!=='/api/agent/ai'||req.method!=='POST')return json({error:'not_found'},404,origin);
 // 依頼の大きさの上限（資料込みで 100 万文字。無料分の 1 回で大きな費用がかからないように）
 const body=await req.text();if(body.length>1000000)return json({error:'too_large'},413,origin);let d;try{d=JSON.parse(body)}catch{return json({error:'invalid'},400,origin)}
 if(!['now','batch'].includes(d.mode)||!LABELS.includes(d.label)||typeof d.text!=='string'||!d.text||!d.schema||typeof d.schema!=='object'||(d.mode==='batch'&&!(typeof d.key==='string'&&/^[\w-]{8,128}$/.test(d.key))))return json({error:'invalid'},400,origin);
 // 出来上がった Batch の結果は、使える状態かどうかにかかわらず渡す（支払い済みの分）
 if(d.mode==='batch'){let row=await store.getAiRequest(account,d.key);if(row){row=await settle(store,env,row,now);if(row.status==='done')return json({status:'done',text:row.result},200,origin);if(row.status==='failed'){await store.deleteAiRequest(row.id);return json({status:'failed',reason:row.reason||'作成に失敗しました'},200,origin)}return json({status:'pending'},200,origin)}}
 const status=await aiStatus(store,env,account,now);if(!status.available)return json({error:status.reason},403,origin);const settings=await store.getAdminSettings(),client=makeClient(env.SABORO_ANTHROPIC_API_KEY);
 if(d.mode==='batch'){const batch=await client.messages.batches.create({requests:[{custom_id:'saboro',params:params(d.text,d.schema)}]});const created=await store.insertAiRequest({id:crypto.randomUUID(),account,key:d.key,label:d.label,batch_id:batch.id,created:now.toISOString(),updated:now.toISOString()});if(!created)await client.messages.batches.cancel(batch.id).catch(()=>{});return json({status:'pending'},200,origin)}
 // すぐ：生成に数分かかることがあるので、待つ間は空白を送り続けて接続を保ち、最後に結果の JSON を送る（JSON は先頭の空白を無視する）
 const encoder=new TextEncoder(),{readable,writable}=new TransformStream(),writer=writable.getWriter();const keep=setInterval(()=>writer.write(encoder.encode(' ')).catch(()=>{}),10000);
 const work=(async()=>{let out;try{const message=await client.messages.stream(params(d.text,d.schema)).finalMessage();await record(store,{account,label:d.label,mode:'now',message,settings,now}).catch(()=>{});const o=outcome(message);out=o.text?{status:'done',text:o.text}:{status:'failed',reason:o.reason}}catch(e){out={status:'failed',reason:e instanceof Anthropic.RateLimitError?'混み合っています':e instanceof Anthropic.APIError?`SaBoRo課題サポートの処理に失敗（${e.status??'接続'}）`:'SaBoRo課題サポートの処理に失敗'}}finally{clearInterval(keep)}await writer.write(encoder.encode(JSON.stringify(out)));await writer.close()})();
 ctx?.waitUntil?.(work);return new Response(readable,{status:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}
// Stripe の API（請求項目・請求書）。STRIPE_API_KEY は制限付きキー（請求項目・請求書の書き込みだけ）
async function stripe(env,path,fields,idempotency){const body=new URLSearchParams(Object.entries(fields).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,String(v)]));const r=await stripeFetch('https://api.stripe.com/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+env.STRIPE_API_KEY,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':idempotency},body});if(!r.ok)throw Error(`Stripe ${path} ${r.status}`);return r.json()}
// 毎日の定期実行：①終わった Batch の結果を受け取る（渡す前でも使用量は記録する）②超過分を Stripe の請求項目にする ③古い依頼を消す
export async function runAiDaily(env,store,now=new Date()){const log=[];
 for(const row of await store.listPendingAiRequests()){try{await settle(store,env,row,now)}catch(e){log.push(`batch ${row.id}: ${e.message}`)}}
 if(env.STRIPE_API_KEY){const day=jstDay(now),cutoff=now.toISOString();for(const g of await store.unbilledAiCharges(cutoff)){const yen=Math.round(g.charge_micro/1e6);if(yen<1)continue;// 1 円未満はたまるまで持ち越す
  try{const subs=await store.subscriptionsOf(g.account),sub=subs.find(s=>ACTIVE.includes(s.status));const customer=sub?.customer||subs[0]?.customer;if(!customer){log.push(`charge ${g.account}: 顧客なし`);continue}
   const description=`SaBoRo課題サポート 使用料（無料分を超えた分・${day} まで）`,key=`saboro-ai-${g.account}-${day}`;await stripe(env,'invoiceitems',{customer,amount:yen,currency:'jpy',description,subscription:sub?.subscription},key);
   // 定期支払いが終わっていれば、その場で請求書を作って請求する（次の月額の請求がないため）
   if(!sub)await stripe(env,'invoices',{customer,auto_advance:'true',collection_method:'charge_automatically',pending_invoice_items_behavior:'include',description},key+'-invoice');
   await store.markAiBilled(g.account,cutoff,day)}catch(e){log.push(`charge ${g.account}: ${e.message}`)}}}
 await store.cleanupAiRequests(new Date(now.getTime()-3*86400e3).toISOString(),new Date(now.getTime()-30*86400e3).toISOString());return log}
