// SaBoRo の AI：こちらの Anthropic の API キー（Worker の秘密 SABORO_ANTHROPIC_API_KEY）で回答を作る。利用者の PC にはキーを渡さない
// 使える人：定期支払いが有効な人と、管理画面で登録した利用者（停止中を除く）。登録しただけのアカウントは使えない（誰でも作れるため）。支払いが必要なら定期支払いが有効な人だけ。本人の PC の Codex・Claude Code が使えるときはそちらを先に使う（アプリ側）。月の「課題生成」は無料分（既定 60 回）まで定額、
// それを超えた後の回は使用量（トークン）に応じて実費×上乗せ率（既定 1.5 倍）を円で請求する（毎日まとめて Stripe の請求項目にし、次の月額の請求に加算）
// 急ぐ依頼（本人が画面で頼んだもの・締切まで 24 時間以内）は通常の API、それ以外は Batch（半額。通常 1 時間以内、最大 24 時間）
import Anthropic from '@anthropic-ai/sdk';
import {billingOf,ACTIVE} from './billing.js';
import {currentMonth,DEFAULT_SETTINGS} from './admin.js';
// 1 回の費用の上限：出力は MAX_TOKENS まで、依頼の大きさ（資料込み）は MAX_BODY 文字まで。同時に作るのは MAX_INFLIGHT 件まで（同期は授業を最大 5 つ並行に読む）
export const MODEL='claude-sonnet-5-5',MAX_TOKENS=32000,MAX_BODY=300000,DAILY_LIMIT=200,MAX_INFLIGHT=5,LABELS=['課題生成','授業情報の読み取り'];
// 高度な生成：出力が上限で途切れた課題を、本人が選んだときだけ出力の上限を広げて作り直す（月 ADVANCED_LIMIT 回まで。使用量の mode は advanced）
export const ADVANCED_TOKENS=64000,ADVANCED_LIMIT=3,TRUNCATED='出力が上限で途切れました';
// 1M トークンあたりのドル（通常料金）。キャッシュの書き込みは 5 分のキャッシュ（入力の 1.25 倍）。Batch はすべて半額
export const PRICES={'claude-sonnet-5-5':{input:2,output:10,cacheRead:0.2,cacheWrite:2.5}};
// 知らないモデル名（将来の変更など）は高めの料金で費用を見積もる（運営者の費用の目安。料金表にないモデルの分は利用者に請求しない）
const FALLBACK_PRICE={input:4,output:20,cacheRead:0.2,cacheWrite:5};
export function costUsd(usage={},{model=MODEL,batch=false}={}){const p=PRICES[model]||FALLBACK_PRICE,n=k=>Number(usage[k])||0;const usd=(n('input_tokens')*p.input+n('output_tokens')*p.output+n('cache_read_input_tokens')*p.cacheRead+n('cache_creation_input_tokens')*p.cacheWrite)/1e6;return batch?usd/2:usd}
// 請求額（100 万分の 1 円単位の整数）：実費×為替×上乗せ率
export const chargeMicro=(usd,{usdJpy,markup})=>Math.round(usd*usdJpy*markup*1e6);
// 料金の条件（特定商取引法に基づく表記と同じ値。site/public/tokushoho.html と必ず同時に変える。tests/site.test.js で照らす）
// included：月額に含む課題生成の回数、markup：超えた分の請求＝実費×この倍率、usdJpy：請求に使う為替（管理画面の為替は利益の計算だけに使う）
export let TERMS={included:60,markup:1.5,usdJpy:150};
// freeCapUsd：月額に含む分（無料分）で使える実費の上限（ドル。0 なら上限なし）。回数だけでは 1 回の大きさ・授業情報の読み取りの費用を抑えられないため
export const aiSettings=s=>{const x={...DEFAULT_SETTINGS,...s};return {...TERMS,freeCapUsd:typeof x.aiFreeCapUsd==='number'?x.aiFreeCapUsd:15}};
const jstDay=(now=new Date())=>new Date(now.getTime()+9*3600e3).toISOString().slice(0,10),dayStart=now=>new Date(`${jstDay(now)}T00:00:00+09:00`).toISOString();
// テストで Anthropic・Stripe を差し替える
let makeClient=key=>new Anthropic({apiKey:key,maxRetries:2});let stripeFetch=(...a)=>fetch(...a);
export function setAiTestHooks({client,fetch:f,terms}={}){if(client)makeClient=client;if(f)stripeFetch=f;if(terms)TERMS={...TERMS,...terms}}
const params=(text,schema,maxTokens=MAX_TOKENS)=>({model:MODEL,max_tokens:maxTokens,output_config:{effort:'high',format:{type:'json_schema',schema}},messages:[{role:'user',content:text}]});
// 出力の本文（構造化出力の JSON 文字列）。拒否・途中で切れた場合は理由を返す
function outcome(message){if(message?.stop_reason==='refusal')return {reason:'回答を拒否されました'};if(message?.stop_reason==='max_tokens')return {reason:TRUNCATED,truncated:true};const text=message?.content?.find?.(b=>b.type==='text')?.text;return text?{text}:{reason:'出力なし'}}
// 今月の状態：無料分の残り・超過分の金額・使えるか（使えなければ理由）
export async function aiStatus(store,env,account,now=new Date()){const month=currentMonth(now);const [settings,plan,subs,stats,today,registered]=await Promise.all([store.getAdminSettings(),store.planOf(account),store.subscriptionsOf(account),store.aiMonthStats(account,month),store.aiDayCalls(account,dayStart(now)),store.adminStatusOf(account)]);const s=aiSettings(settings),billing=billingOf({account,settings,plan,subs});
 const subscribed=subs.some(x=>ACTIVE.includes(x.status)),overage=subscribed&&!!env.STRIPE_API_KEY,base={month,included:s.included,used:stats.count,overageYen:Math.round(stats.chargeMicro/1e6),overage,advanced:{used:stats.advanced||0,limit:ADVANCED_LIMIT}};
 // 無料分は「課題生成の回数が無料分に達するまで、かつ実費が上限に達するまで」。回数に達した後は超過分として請求できる人だけ続けて使える
 const entitled=subscribed||(!!registered&&registered!=='stopped'),freeOver=stats.count<s.included&&s.freeCapUsd>0&&(stats.freeCostUsd||0)>=s.freeCapUsd;
 const reason=!env.SABORO_ANTHROPIC_API_KEY?'not_configured':!billing.allowed||!entitled?'payment_required':today>=DAILY_LIMIT?'daily_limit':(stats.count>=s.included&&!overage)||freeOver?'limit':'';return {...base,available:!reason,reason}}
// 1 回分の使用量を記録する。月の「課題生成」が無料分に達した後で、作成できた回なら請求の対象
// 作成できなかった回（出力が上限で途切れた・拒否された・出力なし）は ok=0：回数に数えず請求もしない（費用は無料分の実費の上限には数える）。料金表にないモデルは請求しない（実費を正しく出せないため）
async function record(store,{account,label,mode,message,settings,now=new Date()}){const month=currentMonth(now),s=aiSettings(settings),usage=message?.usage||{},model=message?.model||MODEL,usd=costUsd(usage,{model,batch:mode==='batch'}),ok=!!outcome(message).text;const stats=await store.aiMonthStats(account,month),billable=ok&&!!PRICES[model]&&stats.count>=s.included;
 await store.addAiUsage({id:crypto.randomUUID(),account,month,label,mode,model,input:Number(usage.input_tokens)||0,output:Number(usage.output_tokens)||0,cache_read:Number(usage.cache_read_input_tokens)||0,cache_write:Number(usage.cache_creation_input_tokens)||0,cost_usd:usd,billable:billable?1:0,charge_micro:billable?chargeMicro(usd,s):0,ok:ok?1:0,created:now.toISOString()})}
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
 // 依頼の大きさの上限（資料込みで MAX_BODY 文字。1 回で大きな費用がかからないように）
 const body=await req.text();if(body.length>MAX_BODY)return json({error:'too_large'},413,origin);let d;try{d=JSON.parse(body)}catch{return json({error:'invalid'},400,origin)}
 if(!['now','batch'].includes(d.mode)||!LABELS.includes(d.label)||typeof d.text!=='string'||!d.text||!d.schema||typeof d.schema!=='object'||(d.mode==='batch'&&!(typeof d.key==='string'&&/^[\w-]{8,128}$/.test(d.key))))return json({error:'invalid'},400,origin);
 // 出来上がった Batch の結果は、使える状態かどうかにかかわらず渡す（支払い済みの分）
 if(d.mode==='batch'){let row=await store.getAiRequest(account,d.key);if(row){row=await settle(store,env,row,now);if(row.status==='done')return json({status:'done',text:row.result},200,origin);if(row.status==='failed'){await store.deleteAiRequest(row.id);return json({status:'failed',reason:row.reason||'作成に失敗しました',...(row.reason===TRUNCATED?{truncated:true,advanced:{used:(await store.aiMonthStats(account,currentMonth(now))).advanced||0,limit:ADVANCED_LIMIT}}:{})},200,origin)}return json({status:'pending'},200,origin)}}
 // すぐの依頼でも、同じ key の Batch があれば二重に作らない：出来上がっていればその結果を渡し、まだなら Batch を取り消してからすぐ作る
 // （取り消す前に出来上がっていた分は、定期実行で受け取って使用量に記録する）
 if(d.mode==='now'&&typeof d.key==='string'&&/^[\w-]{8,128}$/.test(d.key)){let row=await store.getAiRequest(account,d.key);if(row){row=await settle(store,env,row,now);if(row.status==='done')return json({status:'done',text:row.result},200,origin);if(row.status==='pending')await makeClient(env.SABORO_ANTHROPIC_API_KEY).messages.batches.cancel(row.batch_id).catch(()=>{})}}
 const advanced=d.advanced===true;if(advanced&&(d.mode!=='now'||d.label!=='課題生成'))return json({error:'invalid'},400,origin);
 const status=await aiStatus(store,env,account,now);if(!status.available)return json({error:status.reason},403,origin);if(advanced&&status.advanced.used>=ADVANCED_LIMIT)return json({error:'advanced_limit'},403,origin);const settings=await store.getAdminSettings(),client=makeClient(env.SABORO_ANTHROPIC_API_KEY);
 // 作る前に予約する（同時に送られても、同時に作る数と 1 日の回数の上限を超えない）。作り終えたら（Batch は依頼を記録したら）外す
 const slot=crypto.randomUUID();if(!await store.reserveAi({id:slot,account,created:now.toISOString(),since:dayStart(now),staleBefore:new Date(now.getTime()-30*60e3).toISOString(),dayLimit:DAILY_LIMIT,maxInflight:MAX_INFLIGHT}))return json({error:'busy'},429,origin);
 if(d.mode==='batch'){try{const batch=await client.messages.batches.create({requests:[{custom_id:'saboro',params:params(d.text,d.schema)}]});const created=await store.insertAiRequest({id:crypto.randomUUID(),account,key:d.key,label:d.label,batch_id:batch.id,created:now.toISOString(),updated:now.toISOString()});if(!created)await client.messages.batches.cancel(batch.id).catch(()=>{});return json({status:'pending'},200,origin)}finally{await store.releaseAi(slot)}}
 // すぐ：生成に数分かかることがあるので、待つ間は空白を送り続けて接続を保ち、最後に結果の JSON を送る（JSON は先頭の空白を無視する）
 const encoder=new TextEncoder(),{readable,writable}=new TransformStream(),writer=writable.getWriter();const keep=setInterval(()=>writer.write(encoder.encode(' ')).catch(()=>{}),10000);
 const work=(async()=>{let out;try{const message=await client.messages.stream(params(d.text,d.schema,advanced?ADVANCED_TOKENS:MAX_TOKENS)).finalMessage();await record(store,{account,label:d.label,mode:advanced?'advanced':'now',message,settings,now}).catch(()=>{});const o=outcome(message);out=o.text?{status:'done',text:o.text}:{status:'failed',reason:o.reason,...(o.truncated?{truncated:true,advanced:{used:status.advanced.used+(advanced?1:0),limit:ADVANCED_LIMIT}}:{})}}catch(e){out={status:'failed',reason:e instanceof Anthropic.RateLimitError?'混み合っています':e instanceof Anthropic.APIError?`SaBoRo課題サポートの処理に失敗（${e.status??'接続'}）`:'SaBoRo課題サポートの処理に失敗'}}finally{clearInterval(keep);await store.releaseAi(slot).catch(()=>{})}await writer.write(encoder.encode(JSON.stringify(out)));await writer.close()})();
 ctx?.waitUntil?.(work);return new Response(readable,{status:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}
// Stripe の API（請求項目・請求書）。STRIPE_API_KEY は制限付きキー（請求項目・請求書の書き込みだけ）
async function stripe(env,path,fields,idempotency){const body=new URLSearchParams(Object.entries(fields).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,String(v)]));const r=await stripeFetch('https://api.stripe.com/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+env.STRIPE_API_KEY,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':idempotency},body});if(!r.ok)throw Error(`Stripe ${path} ${r.status}`);return r.json()}
// 毎日の定期実行：①終わった Batch の結果を受け取る（渡す前でも使用量は記録する）②超過分を Stripe の請求項目にする ③古い依頼を消す
export async function runAiDaily(env,store,now=new Date()){const log=[];
 for(const row of await store.listPendingAiRequests()){try{await settle(store,env,row,now)}catch(e){log.push(`batch ${row.id}: ${e.message}`)}}
 if(env.STRIPE_API_KEY){const day=jstDay(now),cutoff=now.toISOString();for(const g of await store.unbilledAiCharges(cutoff)){const yen=Math.round(g.charge_micro/1e6);if(yen<1)continue;// 1 円未満はたまるまで持ち越す
  try{const subs=await store.subscriptionsOf(g.account),sub=subs.find(s=>ACTIVE.includes(s.status));const customer=sub?.customer||subs[0]?.customer;if(!customer){log.push(`charge ${g.account}: 顧客なし`);continue}
   // 次の月額の請求に加えるのは、続く定期支払いがあるときだけ。終わった・期間の終わりで解約する定期支払いには次の請求がないので、その場で請求書を作って請求する
   const recurring=!!sub&&!sub.cancel_at_period_end,description=`SaBoRo課題サポート 使用料（無料分を超えた分・${day} まで）`,key=`saboro-ai-${g.account}-${day}`;await stripe(env,'invoiceitems',{customer,amount:yen,currency:'jpy',description,subscription:recurring?sub.subscription:undefined},key);
   // 請求項目ができたらすぐ請求済みにする（この後の請求書の作成に失敗しても、翌日に同じ分の請求項目を作り直して二重に請求しない）
   await store.markAiBilled(g.account,cutoff,day);
   if(!recurring)try{await stripe(env,'invoices',{customer,auto_advance:'true',collection_method:'charge_automatically',pending_invoice_items_behavior:'include',description},key+'-invoice')}catch(e){log.push(`charge ${g.account}: 請求書を作れません（${yen} 円の請求項目は Stripe に残っています。Stripe の画面で請求してください）：${e.message}`)}}catch(e){log.push(`charge ${g.account}: ${e.message}`)}}}
 await store.cleanupAiRequests(new Date(now.getTime()-3*86400e3).toISOString(),new Date(now.getTime()-30*86400e3).toISOString());return log}
// 学年暦の PDF を読み取る（管理者画面から。こちらの API キーで 1 回だけ作る）。返すのは確かめる前の学年暦（server/calendar.js の checkCalendar で確かめてから保存する）
// term：どの学期を読むか（例「2027 春学期」。空なら PDF の次に始まる学期）
const CAL_DAYS=['月','火','水','木','金','土'];
export const CALENDAR_SCHEMA={type:'object',properties:{term:{type:'string'},rounds:{type:'object',properties:Object.fromEntries(CAL_DAYS.map(d=>[d,{type:'array',items:{type:'string'}}])),required:CAL_DAYS,additionalProperties:false}},required:['term','rounds'],additionalProperties:false};
export async function readCalendarPdf(env,{url,term=''}){if(!env.SABORO_ANTHROPIC_API_KEY)throw Error('SaBoRo課題サポートの API キーが設定されていません');if(!/^https:\/\/[^\s]{1,300}$/.test(url||''))throw Error('https で始まる PDF の URL を入れてください');
 const r=await fetch(url,{redirect:'follow'});if(!r.ok)throw Error(`PDF を取得できません（${r.status}）`);const buf=new Uint8Array(await r.arrayBuffer());if(buf.length>20e6)throw Error('PDF が大きすぎます（20MB まで）');if(String.fromCharCode(...buf.slice(0,5))!=='%PDF-')throw Error('PDF ではありません');
 let bin='';for(let i=0;i<buf.length;i+=0x8000)bin+=String.fromCharCode(...buf.subarray(i,i+0x8000));
 const text=`添付は日本の大学の学年暦（PDF）。${term?`「${term}」`:'これから始まる（今が学期中ならその）学期'}について、曜日ごとに第1回から最終回までの授業日を抜き出す。
- rounds の各曜日に、その曜日の授業を行う日を YYYY-MM-DD で、第1回から順に並べる（通常 15 回）。祝日でも授業を行う日は含め、休講日・休業期間は含めない
- 振替授業（例：水曜日に月曜日の授業を行う日）は、行う授業の曜日（この例では月）の一覧に、その日付で入れる
- 土曜の授業がなければ土は空の配列。学期の授業日が読み取れない曜日も空の配列にする（推測しない）
- term は「2027 春学期」のように、年度と学期の名前で書く`;
 const message=await makeClient(env.SABORO_ANTHROPIC_API_KEY).messages.create({model:MODEL,max_tokens:16000,output_config:{effort:'high',format:{type:'json_schema',schema:CALENDAR_SCHEMA}},messages:[{role:'user',content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:btoa(bin)}},{type:'text',text}]}]});
 const o=outcome(message);if(!o.text)throw Error(`読み取れませんでした（${o.reason}）`);let c;try{c=JSON.parse(o.text)}catch{throw Error('読み取った結果の形が不正です')}return {...c,source:url,usage:message.usage||{},costUsd:costUsd(message.usage||{},{model:message.model||MODEL})}}
