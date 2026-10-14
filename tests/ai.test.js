import test from 'node:test';import assert from 'node:assert/strict';import {handle,memoryStore} from '../server/worker.js';import {setAiTestHooks,runAiDaily,costUsd,chargeMicro} from '../server/ai.js';
// SaBoRo の AI：使える人の判定・すぐの依頼・Batch・月の無料分と超過分の記録・毎日の請求
const base='https://coursecue.hrk-6888.workers.dev',ADMIN='a'.repeat(40),env={OWNER_TOKEN:'o',DEVICE_TOKEN:'d',ADMIN_TOKEN:ADMIN,SABORO_ANTHROPIC_API_KEY:'sk-ant-test'};
const tok=c=>c.repeat(64),OWNER=tok('a'),DEVICE=tok('b');
const req=(path,{method='GET',token,body}={})=>new Request(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
const call=(store,path,o,e=env)=>handle(req(path,o),e,store,{waitUntil(){}});
const admin=(store,path,body)=>call(store,'/api/admin'+path,{method:'POST',token:ADMIN,body});
const schema={type:'object',properties:{draft:{type:'string'}}};
// 偽の Anthropic：すぐの依頼は usage つきの結果、Batch は ended になるまで待たせる
function fake({usage={input_tokens:100000,output_tokens:20000},text='{"draft":"ok"}',stop='end_turn'}={}){const calls={stream:0,create:0,results:0,cancel:0},batch={status:'in_progress'};
 const message={model:'claude-sonnet-5-5',stop_reason:stop,content:[{type:'text',text}],usage};
 setAiTestHooks({client:()=>({messages:{stream:()=>{calls.stream++;return {finalMessage:async()=>message}},batches:{create:async()=>{calls.create++;return {id:'msgbatch_1'}},retrieve:async()=>({processing_status:batch.status}),results:async()=>{calls.results++;return (async function*(){yield batch.fail?{custom_id:'saboro',result:{type:'expired'}}:{custom_id:'saboro',result:{type:'succeeded',message}}})()},cancel:async()=>{calls.cancel++}}}})});return {calls,batch}}
async function setup({plan='api',settings={}}={}){const store=memoryStore();const r=await call(store,'/api/register',{method:'POST',body:{owner:OWNER,device:DEVICE}});const {id}=await r.json();await admin(store,'/user',{account:id,label:'A',plan,price:2500,status:'active',started:'',note:''});await admin(store,'/settings',{feeRate:0.036,taxable:false,usdJpy:150,...settings});return {store,id}}
const ask=(store,body,e)=>call(store,'/api/agent/ai',{method:'POST',token:DEVICE,body:{label:'課題生成',schema,text:'設問',...body}},e);
const now=async(store,e)=>JSON.parse((await (await ask(store,{mode:'now'},e)).text()).trim());
const status=async(store,e)=>(await call(store,'/api/agent/ai',{token:DEVICE},e)).json();
test('料金：Sonnet 5.5 の通常料金（入力 $2・出力 $10／100 万トークン）、Batch は半額、請求は実費×為替×1.5',()=>{assert.equal(costUsd({input_tokens:1e6,output_tokens:1e6}),12);assert.equal(costUsd({cache_read_input_tokens:1e6,cache_creation_input_tokens:1e6}),2.7);assert.equal(costUsd({input_tokens:1e6,output_tokens:1e6},{batch:true}),6);assert.equal(costUsd({input_tokens:1e6},{model:'unknown'}),4,'知らないモデルは高めに見積もる');assert.equal(chargeMicro(0.4,{usdJpy:150,markup:1.5}),90e6)});
test('プランで分けず誰でも使える。キー未設定・支払いが必要なのに未払いなら使えない',async()=>{fake();let {store}=await setup({plan:'byo'});assert.equal((await status(store)).available,true,'プランに関係なく使える');assert.equal((await now(store)).status,'done');
 ({store}=await setup());assert.equal((await status(store,{...env,SABORO_ANTHROPIC_API_KEY:undefined})).reason,'not_configured');assert.deepEqual(await status(store).then(s=>[s.available,s.included,s.used]),[true,60,0]);
 await admin(store,'/settings',{feeRate:0.036,taxable:false,usdJpy:150,requirePayment:true});assert.equal((await status(store)).reason,'payment_required');
 const web=await (await call(store,'/api/state',{token:OWNER})).json();assert.equal(web.ai.reason,'payment_required','Web の画面にも状態を出す')});
test('すぐの依頼：結果を返し、使用量を記録する。無料分の 60 回までは請求なし',async()=>{const f=fake();const {store,id}=await setup();const r=await now(store);assert.deepEqual(r,{status:'done',text:'{"draft":"ok"}'});assert.equal(f.calls.stream,1);
 const [u]=store.aiUsage;assert.deepEqual({label:u.label,mode:u.mode,input:u.input,output:u.output,billable:u.billable,charge:u.charge_micro},{label:'課題生成',mode:'now',input:100000,output:20000,billable:0,charge:0});assert.equal(u.cost_usd,0.4);assert.equal(u.account,id);
 assert.equal((await status(store)).used,1);fake({stop:'refusal'});assert.deepEqual(await now(store),{status:'failed',reason:'回答を拒否されました'})});
test('61 回目からは超過分。定期支払いと Stripe のキーがなければ止め、あれば実費×1.5 を記録して使える',async()=>{fake();const {store,id}=await setup({settings:{aiIncluded:2}});await now(store);await now(store);
 assert.equal((await status(store)).reason,'limit');assert.equal((await ask(store,{mode:'now'})).status,403);
 await store.linkStripeCustomer('cus_1',id);await store.upsertSubscription({subscription:'sub_1',customer:'cus_1',status:'active',periodEnd:null,cancelAtPeriodEnd:false,eventAt:1});const e={...env,STRIPE_API_KEY:'rk_test'};
 assert.equal((await status(store,e)).available,true);assert.equal((await now(store,e)).status,'done');const last=store.aiUsage.at(-1);assert.equal(last.billable,1);assert.equal(last.charge_micro,90e6,'$0.4×150 円×1.5＝90 円');assert.equal((await status(store,e)).overageYen,90)});
test('Batch：同じ依頼は 1 件にまとめ、終わるまで pending。終わったら結果を渡し、使用量は半額で 1 回だけ記録する',async()=>{const f=fake();const {store}=await setup();
 assert.deepEqual(await (await ask(store,{mode:'batch',key:'key-00001'})).json(),{status:'pending'});assert.deepEqual(await (await ask(store,{mode:'batch',key:'key-00001'})).json(),{status:'pending'});assert.equal(f.calls.create,1,'同じキーは 1 件');
 let ready=await (await call(store,'/api/agent/ai/ready',{method:'POST',token:DEVICE,body:{keys:['key-00001','other-key-1']}})).json();assert.deepEqual(ready.ready,[]);
 f.batch.status='ended';ready=await (await call(store,'/api/agent/ai/ready',{method:'POST',token:DEVICE,body:{keys:['key-00001']}})).json();assert.deepEqual(ready.ready,['key-00001']);
 for(let i=0;i<2;i++)assert.deepEqual(await (await ask(store,{mode:'batch',key:'key-00001'})).json(),{status:'done',text:'{"draft":"ok"}'},'受け取り直しても同じ結果');
 assert.equal(store.aiUsage.length,1,'記録は 1 回');assert.equal(store.aiUsage[0].cost_usd,0.2,'Batch は半額');assert.equal(store.aiUsage[0].mode,'batch');assert.equal(f.calls.results,1)});
test('Batch が期限切れなどで失敗したら理由を返して依頼を消す（次はやり直せる）。記録はしない',async()=>{const f=fake();const {store}=await setup();await ask(store,{mode:'batch',key:'key-00002'});f.batch.status='ended';f.batch.fail=true;
 assert.deepEqual(await (await ask(store,{mode:'batch',key:'key-00002'})).json(),{status:'failed',reason:'24時間以内に作成できませんでした'});assert.equal(store.aiRequests.size,0);assert.equal(store.aiUsage.length,0);
 f.batch.fail=false;f.batch.status='in_progress';assert.deepEqual(await (await ask(store,{mode:'batch',key:'key-00002'})).json(),{status:'pending'});assert.equal(f.calls.create,2)});
test('入力の確認：知らない種類・キーのない Batch・Mac 以外の鍵は受け付けない',async()=>{fake();const {store}=await setup();assert.equal((await ask(store,{mode:'now',label:'雑談'})).status,400);assert.equal((await ask(store,{mode:'batch'})).status,400);assert.equal((await ask(store,{mode:'now',text:''})).status,400);
 assert.equal((await call(store,'/api/agent/ai',{method:'POST',token:OWNER,body:{mode:'now',label:'課題生成',schema,text:'x'}})).status,404,'接続キー（Web）からは使えない')});
test('毎日の定期実行：終わった Batch を受け取り、超過分を Stripe の請求項目にする（1 日 1 回・同じ分は二重にしない）',async()=>{const f=fake();const {store,id}=await setup({settings:{aiIncluded:0}});await store.linkStripeCustomer('cus_1',id);await store.upsertSubscription({subscription:'sub_1',customer:'cus_1',status:'active',periodEnd:null,cancelAtPeriodEnd:false,eventAt:1});const e={...env,STRIPE_API_KEY:'rk_test'};
 await ask(store,{mode:'batch',key:'key-00003'},e);await now(store,e);f.batch.status='ended';const posts=[];setAiTestHooks({fetch:async(url,o)=>{posts.push({url,body:Object.fromEntries(new URLSearchParams(o.body)),key:o.headers['Idempotency-Key']});return new Response('{}')}});
 const at=new Date(Date.now()+3600e3);assert.deepEqual(await runAiDaily(e,store,at),[]);assert.equal(store.aiUsage.length,2,'Batch の使用量も記録');
 assert.equal(posts.length,1);assert.equal(posts[0].url,'https://api.stripe.com/v1/invoiceitems');assert.deepEqual({customer:posts[0].body.customer,amount:posts[0].body.amount,currency:posts[0].body.currency,subscription:posts[0].body.subscription},{customer:'cus_1',amount:'135',currency:'jpy',subscription:'sub_1'},'（$0.4＋$0.2）×150×1.5＝135 円');
 await runAiDaily(e,store,at);assert.equal(posts.length,1,'請求済みの分は二度と出さない');
 await store.upsertSubscription({subscription:'sub_1',customer:'cus_1',status:'canceled',periodEnd:null,cancelAtPeriodEnd:false,eventAt:2});store.aiUsage.push({...store.aiUsage[0],id:'x',billed:null,created:at.toISOString()});await runAiDaily(e,store,new Date(at.getTime()+86400e3));
 assert.deepEqual(posts.slice(1).map(p=>p.url.split('/').pop()),['invoiceitems','invoices'],'定期支払いが終わっていれば、その場で請求書を作る');assert.equal(posts[1].body.subscription,undefined)});
