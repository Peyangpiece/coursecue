// 本番の保存先 d1Store を、Miniflare（workerd）の本物の D1 で動かす。memoryStore と同じ入力で同じ答えになることも確かめる
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,readdirSync} from 'node:fs';import {Miniflare} from 'miniflare';import {d1Store,memoryStore} from '../server/worker.js';
const sql=f=>readFileSync(f,'utf8').split('\n').filter(l=>l.trim()&&!l.trim().startsWith('--')).join('\n');
// 新しい D1 を 1 つ作り、schema.sql → migrations/ の順に当てる（公開と同じ順）
async function openD1(t){const mf=new Miniflare({workers:[{config:{name:'t',compatibilityDate:'2025-04-28',manifest:{mainModule:'index.js',modules:{'index.js':{type:'esm',contents:'export default {fetch(){return new Response("ok")}}'}}},env:{DB:{type:'d1',id:'coursecue-test'}}}}]});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 await db.exec(sql('server/schema.sql'));for(const f of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(sql('migrations/'+f));return db}
// 同じ操作を D1 と記憶上の保存先の両方に行い、答えが同じことを確かめる
async function pair(t){const db=await openD1(t);return {db,d1:d1Store(db),mem:memoryStore(),async same(f,msg){const [a,b]=await Promise.all([f(this.d1),f(this.mem)]);assert.deepEqual(a,b,msg);return a}}}
const at=i=>`2026-04-01T00:00:${String(i).padStart(2,'0')}.000Z`,sorted=rows=>[...rows].sort((a,b)=>String(a.account).localeCompare(String(b.account)));

test('利用者の登録：接続キーは owner、Mac の鍵は device。同じ鍵の二重登録は失敗し、legacy は状態の有無で判定する',async t=>{const p=await pair(t);
 await p.same(s=>s.createAccount({id:'a1',ownerHash:'o1',deviceHash:'d1',created:at(1)}));await p.same(s=>s.createAccount({id:'a2',ownerHash:'o2',deviceHash:'d2',created:at(2)}));
 assert.deepEqual(await p.same(s=>s.findAccount('o1')),{id:'a1',role:'owner'});assert.deepEqual(await p.same(s=>s.findAccount('d2')),{id:'a2',role:'device'});assert.equal(await p.same(s=>s.findAccount('zz')),null);
 for(const s of [p.d1,p.mem]){await assert.rejects(s.createAccount({id:'a3',ownerHash:'o1',deviceHash:'d3',created:at(3)}),'同じ接続キー');await assert.rejects(s.createAccount({id:'a3',ownerHash:'o3',deviceHash:'d2',created:at(3)}),'同じ Mac の鍵')}
 assert.equal(await p.same(s=>s.findAccount('o3')),null,'失敗した登録は残らない');
 assert.equal(await p.same(s=>s.hasAccount('a1')),true);assert.equal(await p.same(s=>s.hasAccount('nope')),false);assert.equal(await p.same(s=>s.hasAccount('')),false);
 assert.equal(await p.same(s=>s.hasAccount('legacy')),false,'legacy は状態がなければいない');await p.same(s=>s.putState('legacy','{}'));assert.equal(await p.same(s=>s.hasAccount('legacy')),true)});

test('状態：保存・上書き・未登録は null。legacy は旧構成の state 表（id=dashboard）から引き継ぐ',async t=>{const p=await pair(t);
 assert.equal(await p.same(s=>s.getState('a1')),null);await p.same(s=>s.putState('a1','{"v":1}'));assert.equal(await p.same(s=>s.getState('a1')),'{"v":1}');await p.same(s=>s.putState('a1','{"v":2}'));assert.equal(await p.same(s=>s.getState('a1')),'{"v":2}');
 assert.equal(await p.d1.getState('legacy'),null);await p.db.prepare("INSERT INTO state(id,value) VALUES('dashboard','{\"old\":true}')").run();assert.equal(await p.d1.getState('legacy'),'{"old":true}','旧構成の値');assert.equal(await p.d1.getState('a9'),null,'legacy 以外は引き継がない');
 await p.d1.putState('legacy','{"new":true}');assert.equal(await p.d1.getState('legacy'),'{"new":true}','新しい表の値が優先')});

test('処理：一覧は新しい順に最大 50 件で account・payload を含まない。取り出しは古い順・除外あり・2 回目は null。終了は running で本人のときだけ、credentials の内容は消す',async t=>{const p=await pair(t);
 const job=(i,account,kind,payload='{}')=>({id:'j'+i,account,kind,task:i%2?'t'+i:null,payload,created:at(i),updated:at(i)});
 await p.same(s=>s.insertJob(job(3,'a1','generate')));await p.same(s=>s.insertJob(job(1,'a1','sync')));await p.same(s=>s.insertJob(job(2,'a1','credentials','{"id":"u","pw":"secret"}')));await p.same(s=>s.insertJob(job(4,'a2','sync')));
 const list=await p.same(s=>s.listJobs('a1'));assert.deepEqual(list.map(j=>j.id),['j3','j2','j1'],'新しい順');assert.deepEqual(Object.keys(list[0]).sort(),['created','id','kind','result','status','task','updated']);assert.equal(list[0].status,'pending');assert.equal(list[0].result,null);assert.deepEqual(await p.same(s=>s.listJobs('a3')),[]);
 assert.equal(await p.same(s=>s.claimJob('a1',at(10),['sync','generate','credentials'])),null,'除外した種類は取らない');assert.equal((await p.same(s=>s.listJobs('a1'))).every(j=>j.status==='pending'),true);
 const c1=await p.same(s=>s.claimJob('a1',at(10),['credentials']));assert.equal(c1.id,'j1','古い順（除外以外）');assert.equal(c1.status,'running');assert.equal(c1.updated,at(10));assert.deepEqual(Object.keys(c1).sort(),['account','created','id','kind','payload','result','status','task','updated']);
 const c2=await p.same(s=>s.claimJob('a1',at(11)));assert.equal(c2.id,'j2');assert.equal(c2.payload,'{"id":"u","pw":"secret"}');
 const c3=await p.same(s=>s.claimJob('a1',at(12)));assert.equal(c3.id,'j3');assert.equal(await p.same(s=>s.claimJob('a1',at(13))),null,'もうない');assert.equal(await p.same(s=>s.claimJob('a9',at(13))),null);
 await p.same(s=>s.finishJob('a2','j1','done','{"x":1}',at(20)));assert.equal((await p.same(s=>s.listJobs('a1')))[2].status,'running','他の利用者は終了できない');
 await p.same(s=>s.finishJob('a1','j1','done','{"x":1}',at(20)));await p.same(s=>s.finishJob('a1','j2','failed','{"error":"e"}',at(21)));
 const after=await p.same(s=>s.listJobs('a1'));assert.deepEqual(after.map(j=>[j.id,j.status,j.result,j.updated]),[['j3','running',null,at(12)],['j2','failed','{"error":"e"}',at(21)],['j1','done','{"x":1}',at(20)]]);
 await p.same(s=>s.finishJob('a1','j1','failed','{}',at(22)));assert.equal((await p.same(s=>s.listJobs('a1')))[2].status,'done','終わったものは書き換わらない');
 assert.equal((await p.db.prepare("SELECT payload FROM account_jobs WHERE id='j2'").first()).payload,'{}','credentials の内容は消す');assert.equal((await p.db.prepare("SELECT payload FROM account_jobs WHERE id='j1'").first()).payload,'{}');
 await p.same(s=>s.finishJob('a2','j4','done',null,at(23)));assert.equal((await p.same(s=>s.listJobs('a2')))[0].status,'pending','取り出していない処理は終了できない');
 for(let i=20;i<80;i++)await p.same(s=>s.insertJob(job(i,'a5','sync')));const many=await p.same(s=>s.listJobs('a5'));assert.equal(many.length,50);assert.equal(many[0].id,'j79')});

test('管理者画面の利用者一覧：状態から件数・最終接続・版・使用量を取り出し、legacy は状態の表から足す',async t=>{const p=await pair(t);
 await p.same(s=>s.createAccount({id:'a1',ownerHash:'o1',deviceHash:'d1',created:at(1)}));await p.same(s=>s.createAccount({id:'a2',ownerHash:'o2',deviceHash:'d2',created:at(2)}));
 const state={deviceSeen:'2026-04-02T01:00:00Z',os:'darwin 25.0',version:'1.0.39',runtime:'electron',lastSync:'2026-04-02T00:30:00Z',credentialsConfigured:true,tasks:[{id:1},{id:2},{id:3}],courses:[{id:'c'}],lastError:'boom',lastErrorAt:'2026-04-01T00:00:00Z',usage:{month:'2026-04',count:3}};
 await p.same(s=>s.putState('a1',JSON.stringify(state)));await p.same(s=>s.putState('legacy',JSON.stringify({version:'0.9',tasks:[],credentialsConfigured:false})));
 await p.same(s=>s.putAdminUser({account:'a1',label:'太郎',plan:'api',price:980,status:'active',started:'2026-04-01',note:'n',updated:at(5)}));
 const rows=await p.d1.adminUsers();assert.deepEqual(rows.map(r=>r.account),['legacy','a1','a2'],'created の順（legacy は NULL なので先頭）');
 assert.deepEqual(rows[1],{account:'a1',created:at(1),seen:state.deviceSeen,os:state.os,version:state.version,runtime:'electron',last_sync:state.lastSync,creds:1,tasks:3,courses:1,last_error:'boom',last_error_at:state.lastErrorAt,usage:'{"month":"2026-04","count":3}',label:'太郎',plan:'api',price:980,status:'active',started:'2026-04-01',note:'n'});
 assert.deepEqual(rows[2],{account:'a2',created:at(2),seen:null,os:null,version:null,runtime:null,last_sync:null,creds:null,tasks:null,courses:null,last_error:null,last_error_at:null,usage:null,label:null,plan:null,price:null,status:null,started:null,note:null},'状態も管理情報もない利用者');
 assert.deepEqual(rows[0],{...rows[2],account:'legacy',created:null,version:'0.9',creds:0,tasks:0});
 // memoryStore との違い：並び（legacy の位置）、状態にない creds（0 と null）、管理情報のない利用者の label 等（null と無し）、putAdminUser の updated が混ざる点だけ。画面側（userRow）はどちらも同じに扱う
 const norm=r=>{const {updated,...x}=r;return {label:null,plan:null,price:null,status:null,started:null,note:null,...x,creds:r.creds?1:0}};assert.deepEqual(sorted(rows).map(norm),sorted(await p.mem.adminUsers()).map(norm))});

test('管理者の表：利用者情報の上書き、入金の期間と並び、費用の終了は毎月のものだけ、設定はキーごとに JSON で往復する',async t=>{const p=await pair(t);
 await p.same(s=>s.putAdminUser({account:'a1',label:'x',plan:'byo',price:0,status:'trial',started:'',note:'',updated:at(1)}));await p.same(s=>s.putAdminUser({account:'a1',label:'y',plan:'api',price:1500,status:'active',started:'2026-04-01',note:'m',updated:at(2)}));
 assert.equal(await p.same(s=>s.planOf('a1')),'api');assert.equal(await p.same(s=>s.adminStatusOf('a1')),'active');assert.equal(await p.same(s=>s.planOf('zz')),null);assert.equal(await p.same(s=>s.adminStatusOf('zz')),null);
 assert.equal((await p.db.prepare("SELECT COUNT(*) AS n FROM admin_users").first()).n,1);assert.equal((await p.db.prepare("SELECT started FROM admin_users WHERE account='a1'").first()).started,'2026-04-01');
 await p.same(s=>s.putAdminUser({account:'a1',label:'y',plan:'api',price:1500,status:'active',started:'',note:'m',updated:at(3)}));assert.equal((await p.db.prepare("SELECT started FROM admin_users WHERE account='a1'").first()).started,null,'空の開始日は NULL');
 const pay=(id,account,month,created,amount=1000)=>({id,account,month,amount,method:'bank',paid_on:null,note:'',created});
 await p.same(s=>s.addPayment(pay('p1','a1','2026-03',at(1))));await p.same(s=>s.addPayment(pay('p2','a1','2026-04',at(2))));await p.same(s=>s.addPayment(pay('p3','a2','2026-04',at(3))));await p.same(s=>s.addPayment(pay('p4','a1','2026-05',at(4))));await p.same(s=>s.addPayment({...pay('p5','a1','2026-02',at(5)),paid_on:'2026-02-03'}));
 assert.deepEqual((await p.same(s=>s.listPayments('2026-03','2026-04'))).map(x=>x.id),['p3','p2','p1'],'月の新しい順、同じ月は記録の新しい順。範囲は両端を含む');assert.deepEqual((await p.same(s=>s.listPayments('2026-02','2026-02')))[0],{id:'p5',account:'a1',month:'2026-02',amount:1000,method:'bank',paid_on:'2026-02-03',note:'',created:at(5)});
 await p.same(s=>s.deletePayment('p2'));await p.same(s=>s.deletePayment('none'));assert.deepEqual((await p.same(s=>s.listPayments('2026-01','2026-12'))).map(x=>x.id),['p4','p3','p1','p5']);
 const cost=(id,month,recurring,created)=>({id,item:'i'+id,amount:500,month,recurring,note:'',created});
 await p.same(s=>s.addCost(cost('c2','2026-04',1,at(2))));await p.same(s=>s.addCost(cost('c1','2026-03',0,at(1))));await p.same(s=>s.addCost(cost('c3','2026-04',0,at(3))));
 // memoryStore の listCosts は入れた順のまま（並べない）なので、並びは D1 だけで確かめ、中身は並べ替えて比べる
 const byId=rows=>[...rows].sort((a,b)=>a.id.localeCompare(b.id)),costs=async msg=>{const [a,b]=await Promise.all([p.d1.listCosts(),p.mem.listCosts()]);assert.deepEqual(byId(a),byId(b),msg);return a};
 assert.deepEqual((await costs()).map(c=>[c.id,c.end_month]),[['c1',null],['c2',null],['c3',null]],'月の順、同じ月は記録の順');
 await p.same(s=>s.endCost('c3','2026-06'));await p.same(s=>s.endCost('c2','2026-06'));assert.deepEqual((await costs()).map(c=>[c.id,c.end_month]),[['c1',null],['c2','2026-06'],['c3',null]],'毎月のものだけ終えられる');
 await p.same(s=>s.deleteCost('c1'));assert.deepEqual((await costs()).map(c=>c.id),['c2','c3']);
 assert.deepEqual(await p.same(s=>s.getAdminSettings()),{});const settings={feeRate:0.036,taxIncluded:true,usdJpy:150.5,academicCalendar:{terms:[{name:'前期',start:'2026-04-01'}],holidays:['2026-05-05']},label:'テスト'};
 await p.same(s=>s.putAdminSettings(settings));assert.deepEqual(await p.same(s=>s.getAdminSettings()),settings);
 await p.same(s=>s.putAdminSettings({usdJpy:160,memo:null}));assert.deepEqual(await p.same(s=>s.getAdminSettings()),{...settings,usdJpy:160,memo:null},'キーごとに上書き、他のキーは残る');
 assert.equal((await p.db.prepare("SELECT value FROM admin_settings WHERE key='academicCalendar'").first()).value,JSON.stringify(settings.academicCalendar),'値は JSON 文字列で 1 行ずつ');
 await p.db.prepare("INSERT INTO admin_settings(key,value) VALUES('broken','{not json')").run();assert.equal('broken' in await p.d1.getAdminSettings(),false,'壊れた値は飛ばす')});

test('Stripe の入金：同じ ID は上書き、顧客と利用者の対応で未割り当ての入金を移す',async t=>{const p=await pair(t);
 const spay=(id,account,month,amount,created=at(1))=>({id,account,month,amount,method:'Stripe',paid_on:'2026-04-02',note:'n',created});
 await p.same(s=>s.upsertPayment(spay('pi_1','a1','2026-04',1000)));await p.same(s=>s.upsertPayment({...spay('pi_1','a1','2026-04',1200,at(9)),paid_on:'2026-04-03',note:'again',method:'other'}));
 assert.deepEqual(await p.same(s=>s.listPayments('2026-04','2026-04')),[{id:'pi_1',account:'a1',month:'2026-04',amount:1200,method:'Stripe',paid_on:'2026-04-03',note:'again',created:at(1)}],'同じ通知が何度届いても 1 件。method と created は最初のまま');
 assert.equal(await p.same(s=>s.paymentAccountOf('pi_1')),'a1');assert.equal(await p.same(s=>s.paymentAccountOf('pi_x')),null);
 const un=(id,customer,month,created)=>({id,customer,email:'e@x',month,amount:980,paid_on:'2026-04-05',note:'',created});
 await p.same(s=>s.upsertUnmatched(un('pi_2','cus_1','2026-04',at(2))));await p.same(s=>s.upsertUnmatched(un('pi_3','cus_1','2026-05',at(3))));await p.same(s=>s.upsertUnmatched(un('pi_4','cus_2','2026-04',at(4))));await p.same(s=>s.upsertUnmatched(un('pi_5','','2026-04',at(5))));
 await p.same(s=>s.upsertUnmatched({...un('pi_2','cus_1','2026-04',at(2)),amount:1100,note:'fix'}));
 assert.deepEqual((await p.same(s=>s.listUnmatched())).map(u=>[u.id,u.amount,u.note]),[['pi_5',980,''],['pi_4',980,''],['pi_3',980,''],['pi_2',1100,'fix']],'新しい順。同じ ID は金額・メモを上書き');
 assert.equal(await p.same(s=>s.stripeAccountFor('cus_1')),null);await p.same(s=>s.linkStripeCustomer('cus_1','a2'));assert.equal(await p.same(s=>s.stripeAccountFor('cus_1')),'a2');
 const customers=()=>p.same(async s=>(await s.listStripeCustomers()).map(c=>[c.customer,c.account]));assert.deepEqual(await customers(),[['cus_1','a2']]);assert.match((await p.d1.listStripeCustomers())[0].created,/^\d{4}-\d\d-\d\dT/,'対応づけた時刻（今）');
 assert.deepEqual((await p.same(s=>s.listUnmatched())).map(u=>u.id),['pi_5','pi_4'],'その顧客の未割り当ては消える');
 assert.deepEqual((await p.same(s=>s.listPayments('2026-04','2026-05'))).map(x=>[x.id,x.account,x.amount,x.method,x.paid_on]),[['pi_3','a2',980,'Stripe','2026-04-05'],['pi_2','a2',1100,'Stripe','2026-04-05'],['pi_1','a1',1200,'Stripe','2026-04-03']],'利用者の入金に移る');
 await p.same(s=>s.linkStripeCustomer('cus_1','a3'));assert.equal(await p.same(s=>s.stripeAccountFor('cus_1')),'a3','対応は付け替えられる');assert.deepEqual(await customers(),[['cus_1','a3']]);
 await p.same(s=>s.upsertUnmatched({...un('pi_2','cus_1','2026-04',at(2)),amount:1300,note:'fix'}));await p.same(s=>s.linkStripeCustomer('cus_1','a3'));assert.deepEqual((await p.same(s=>s.listPayments('2026-04','2026-04'))).find(x=>x.id==='pi_2'),{id:'pi_2',account:'a3',month:'2026-04',amount:1300,method:'Stripe',paid_on:'2026-04-05',note:'fix',created:at(2)},'既にある入金は利用者と金額を上書き');assert.equal((await p.same(s=>s.listPayments('2026-04','2026-04'))).length,2);
 assert.equal(await p.same(s=>s.assignUnmatched('pi_x','a1')),false);assert.equal(await p.same(s=>s.assignUnmatched('pi_4','a4')),true,'顧客 ID があれば対応も覚える');assert.equal(await p.same(s=>s.stripeAccountFor('cus_2')),'a4');assert.equal(await p.same(s=>s.paymentAccountOf('pi_4')),'a4');
 assert.equal(await p.same(s=>s.assignUnmatched('pi_5','a1')),true,'顧客 ID がなければその 1 件だけ');assert.equal(await p.same(s=>s.paymentAccountOf('pi_5')),'a1');assert.deepEqual(await customers(),[['cus_1','a3'],['cus_2','a4']]);assert.deepEqual(await p.same(s=>s.listUnmatched()),[]);
 await p.same(s=>s.upsertUnmatched(un('pi_6','','2026-04',at(6))));await p.same(s=>s.deleteUnmatched('pi_6'));assert.deepEqual(await p.same(s=>s.listUnmatched()),[]);
 await p.same(s=>s.unlinkStripeCustomer('cus_2'));assert.equal(await p.same(s=>s.stripeAccountFor('cus_2')),null);assert.equal(await p.same(s=>s.paymentAccountOf('pi_4')),'a4','入金は残る');
 // D1 だけ：移すときの ON CONFLICT は account と amount しか上書きしない（note・paid_on・month は最初のまま）。memoryStore の upsert は全部上書きするので、ここは比べない
 await p.d1.upsertUnmatched({...un('pi_5','','2026-05',at(5)),amount:990,note:'changed',paid_on:'2026-04-09'});assert.equal(await p.d1.assignUnmatched('pi_5','a2'),true);assert.deepEqual((await p.d1.listPayments('2026-04','2026-05')).find(x=>x.id==='pi_5'),{id:'pi_5',account:'a2',month:'2026-04',amount:990,method:'Stripe',paid_on:'2026-04-05',note:'',created:at(5)})});

test('Stripe の定期支払い：古い通知では上書きしない。期間の終わりがなければ前の値を残す。利用者ごとの一覧は顧客の対応で引く',async t=>{const p=await pair(t);
 const sub=(x={})=>({subscription:'sub_1',customer:'cus_1',status:'active',periodEnd:1000,cancelAtPeriodEnd:false,eventAt:10,...x});
 await p.same(s=>s.upsertSubscription(sub()));await p.same(s=>s.upsertSubscription(sub({status:'canceled',periodEnd:900,eventAt:5})));
 const one=async()=>(await p.same(s=>s.listSubscriptions()))[0];assert.deepEqual(await one(),{subscription:'sub_1',customer:'cus_1',status:'active',period_end:1000,cancel_at_period_end:0,event_at:10,account:null},'古い通知は無視。対応のない顧客は account が null');
 await p.same(s=>s.upsertSubscription(sub({status:'past_due',periodEnd:null,cancelAtPeriodEnd:true,eventAt:10})));assert.deepEqual(await one(),{subscription:'sub_1',customer:'cus_1',status:'past_due',period_end:1000,cancel_at_period_end:1,event_at:10,account:null},'同じ時刻は上書き。期間の終わりは前の値');
 await p.same(s=>s.upsertSubscription(sub({status:'active',periodEnd:2000,customer:'cus_2',eventAt:20})));assert.deepEqual(await one(),{subscription:'sub_1',customer:'cus_2',status:'active',period_end:2000,cancel_at_period_end:0,event_at:20,account:null});
 await p.same(s=>s.upsertSubscription(sub({subscription:'sub_2',customer:'cus_1',periodEnd:null,eventAt:1})));assert.equal((await p.same(s=>s.listSubscriptions())).find(s=>s.subscription==='sub_2').period_end,null,'最初から終わりがなければ null');
 await p.same(s=>s.linkStripeCustomer('cus_2','a1'));await p.same(s=>s.linkStripeCustomer('cus_1','a2'));
 assert.deepEqual(await p.same(s=>s.subscriptionsOf('a1')),[{subscription:'sub_1',customer:'cus_2',status:'active',period_end:2000,cancel_at_period_end:0,event_at:20}]);assert.deepEqual((await p.same(s=>s.subscriptionsOf('a2'))).map(s=>s.subscription),['sub_2']);assert.deepEqual(await p.same(s=>s.subscriptionsOf('a9')),[]);
 assert.deepEqual(sorted(await p.same(s=>s.listSubscriptions())).map(s=>[s.subscription,s.account]),[['sub_1','a1'],['sub_2','a2']])});

test('AI の使用量：月の回数は「課題生成」で作成できた回だけ、無料分の実費は billable=0 だけ、advanced の回数。日の回数は使用量と Batch の依頼の和',async t=>{const p=await pair(t);
 const use=(id,x)=>({id,account:'a1',month:'2026-04',label:'課題生成',mode:'standard',model:'m',input:10,output:20,cache_read:0,cache_write:0,cost_usd:0.01,billable:0,charge_micro:0,ok:1,created:at(1),...x});
 await p.same(s=>s.addAiUsage(use('u1',{})));await p.same(s=>s.addAiUsage(use('u2',{ok:0,cost_usd:0.02})));await p.same(s=>s.addAiUsage(use('u3',{label:'要約',cost_usd:0.03})));await p.same(s=>s.addAiUsage(use('u4',{mode:'advanced',billable:1,charge_micro:1500000,cost_usd:0.5})));
 await p.same(s=>s.addAiUsage(use('u5',{month:'2026-03',cost_usd:9})));await p.same(s=>s.addAiUsage(use('u6',{account:'a2',mode:'advanced',cost_usd:0.1,charge_micro:7})));
 const stats=await p.same(s=>s.aiMonthStats('a1','2026-04'));assert.equal(stats.count,2,'u1 と u4（advanced も課題生成）。ok=0 と他のラベルは数えない');assert.equal(stats.advanced,1);assert.equal(stats.chargeMicro,1500000);assert.ok(Math.abs(stats.costUsd-0.56)<1e-9);assert.ok(Math.abs(stats.freeCostUsd-0.06)<1e-9,'billable=1 の実費は無料分に入れない');
 assert.deepEqual(await p.same(s=>s.aiMonthStats('a1','2026-05')),{count:0,costUsd:0,freeCostUsd:0,advanced:0,chargeMicro:0});
 const all=sorted(await p.same(s=>s.aiMonthAll('2026-04')));assert.deepEqual(all.map(r=>[r.account,r.count,r.calls,r.charge_micro]),[['a1',2,4,1500000],['a2',1,1,7]]);assert.ok(Math.abs(all[0].cost_usd-0.56)<1e-9);assert.deepEqual(await p.same(s=>s.aiMonthAll('2026-06')),[]);
 assert.equal((await p.db.prepare("SELECT ok FROM ai_usage WHERE id='u2'").first()).ok,0,'migrations の ok 列が使われる');
 const req=(id,key,created)=>({id,account:'a1',key,label:'課題生成',batch_id:'b1',created,updated:created});await p.same(s=>s.insertAiRequest(req('r1','k1',at(2))));await p.same(s=>s.insertAiRequest(req('r0','k0',at(0))));
 assert.equal(await p.same(s=>s.aiDayCalls('a1',at(1))),6,'使用量 5 件（別の月の u5 も当日分）＋依頼 1 件');assert.equal(await p.same(s=>s.aiDayCalls('a1',at(3))),0);assert.equal(await p.same(s=>s.aiDayCalls('a2',at(0))),1)});

test('AI の予約：同時に作る数と 1 日の回数を 1 文で確かめて入れる。古い予約は数えず、解放すれば空く',async t=>{const p=await pair(t);
 const r=(id,x={})=>({id,account:'a1',created:at(10),since:at(0),staleBefore:at(5),dayLimit:10,maxInflight:2,...x});
 assert.equal(await p.same(s=>s.reserveAi(r('i1'))),true);assert.equal(await p.same(s=>s.reserveAi(r('i2'))),true);assert.equal(await p.same(s=>s.reserveAi(r('i3'))),false,'3 つ目は同時の上限');
 assert.equal(await p.same(s=>s.reserveAi(r('i4',{account:'a2'}))),true,'別の利用者は別に数える');
 await p.same(s=>s.releaseAi('i1'));assert.equal(await p.same(s=>s.reserveAi(r('i3'))),true,'解放すれば空く');assert.equal((await p.db.prepare("SELECT COUNT(*) AS n FROM ai_inflight WHERE account='a1'").first()).n,2);
 await p.same(s=>s.releaseAi('i2'));await p.same(s=>s.releaseAi('i3'));await p.same(s=>s.reserveAi(r('old',{created:at(1)})));await p.same(s=>s.reserveAi(r('old2',{created:at(2)})));
 assert.equal(await p.same(s=>s.reserveAi(r('i5'))),true,'staleBefore より古い予約は数えない');assert.equal(await p.same(s=>s.reserveAi(r('i6'))),true);assert.equal(await p.same(s=>s.reserveAi(r('i7'))),false);
 for(const id of ['i5','i6'])await p.same(s=>s.releaseAi(id));
 const use=(id,created)=>({id,account:'a1',month:'2026-04',label:'課題生成',mode:'standard',model:'m',input:0,output:0,cache_read:0,cache_write:0,cost_usd:0,billable:0,charge_micro:0,ok:1,created});
 await p.same(s=>s.addAiUsage(use('u1',at(6))));await p.same(s=>s.addAiUsage(use('u2',at(7))));await p.same(s=>s.insertAiRequest({id:'q1',account:'a1',key:'k',label:'課題生成',batch_id:'b',created:at(8),updated:at(8)}));
 assert.equal(await p.same(s=>s.reserveAi(r('i8',{dayLimit:4}))),true,'使用量 2＋依頼 1＋予約 0 ＝ 3 ＜ 4');assert.equal(await p.same(s=>s.reserveAi(r('i9',{dayLimit:4}))),false,'予約も数えて 4 に達した');
 assert.equal(await p.same(s=>s.reserveAi(r('i9',{dayLimit:5}))),true);await p.same(s=>s.releaseAi('i8'));await p.same(s=>s.releaseAi('i9'));
 assert.equal(await p.same(s=>s.reserveAi(r('i10',{dayLimit:3}))),false,'使用量と依頼だけで上限');assert.equal(await p.same(s=>s.reserveAi(r('i10',{dayLimit:3,since:at(7)}))),true,'since より前は数えない')});

test('AI の Batch の依頼：同じキーは入れない。終了は pending のときだけ。古いものの掃除',async t=>{const p=await pair(t);
 const req=(id,account,key,created)=>({id,account,key,label:'課題生成',batch_id:'batch_'+id,created,updated:created});
 assert.equal(await p.same(s=>s.insertAiRequest(req('r2','a1','k1',at(2)))),true);assert.equal(await p.same(s=>s.insertAiRequest(req('r9','a1','k1',at(9)))),false,'同じ利用者の同じキー');assert.equal(await p.same(s=>s.insertAiRequest(req('r1','a2','k1',at(1)))),true,'別の利用者なら入る');assert.equal(await p.same(s=>s.insertAiRequest(req('r3','a1','k3',at(3)))),true);
 assert.deepEqual(await p.same(s=>s.getAiRequest('a1','k1')),{id:'r2',account:'a1',key:'k1',label:'課題生成',batch_id:'batch_r2',status:'pending',result:null,reason:null,created:at(2),updated:at(2)});assert.equal(await p.same(s=>s.getAiRequest('a1','zz')),null);
 const pendingIds=()=>p.same(async s=>(await s.listPendingAiRequests()).map(r=>r.id).sort());const pick=r=>({id:r.id,account:r.account,key:r.key,label:r.label,batch_id:r.batch_id,status:r.status,created:r.created,updated:r.updated});
 const pending=await p.d1.listPendingAiRequests();assert.deepEqual(pending.map(r=>r.id),['r1','r2','r3'],'古い順');assert.deepEqual(Object.keys(pending[0]).sort(),['account','batch_id','created','id','key','label','status','updated'],'結果は含まない');assert.deepEqual(pending,(await p.mem.listPendingAiRequests()).map(pick).sort((a,b)=>a.created.localeCompare(b.created)),'memoryStore は入れた順のままなので並べて比べる');
 assert.equal(await p.same(s=>s.finishAiRequest('r2',{status:'done',result:'答え',reason:null,updated:at(5)})),true);assert.equal(await p.same(s=>s.finishAiRequest('r2',{status:'failed',result:null,reason:'late',updated:at(6)})),false,'終わったものは書き換わらない');assert.equal(await p.same(s=>s.finishAiRequest('rx',{status:'done',result:null,reason:null,updated:at(6)})),false);
 assert.deepEqual(await p.same(s=>s.getAiRequest('a1','k1')),{id:'r2',account:'a1',key:'k1',label:'課題生成',batch_id:'batch_r2',status:'done',result:'答え',reason:null,created:at(2),updated:at(5)});
 assert.equal(await p.same(s=>s.finishAiRequest('r3',{status:'failed',result:null,reason:'expired',updated:at(6)})),true);assert.deepEqual((await pendingIds()).length,1);
 await p.same(s=>s.deleteAiRequest('r2'));assert.equal(await p.same(s=>s.getAiRequest('a1','k1')),null);assert.equal(await p.same(s=>s.insertAiRequest(req('r4','a1','k1',at(8)))),true,'消せば同じキーで入れ直せる');
 await p.same(s=>s.reserveAi({id:'i1',account:'a1',created:at(1),since:at(0),staleBefore:at(0),dayLimit:99,maxInflight:9}));await p.same(s=>s.reserveAi({id:'i2',account:'a1',created:at(9),since:at(0),staleBefore:at(0),dayLimit:99,maxInflight:9}));
 // 残り：r1（pending, 作成 1）、r3（failed, 更新 6）、r4（pending, 作成 8）、予約 i1（1）・i2（9）
 await p.same(s=>s.cleanupAiRequests(at(7),at(2)));
 assert.deepEqual(await pendingIds(),['r4'],'pending は pendingBefore より古いものを消す');assert.equal(await p.same(s=>s.getAiRequest('a1','k3')),null,'終わったものは doneBefore より古い（updated<）ものを消す');
 assert.deepEqual((await p.db.prepare('SELECT id FROM ai_inflight ORDER BY created').all()).results.map(r=>r.id),['i2'],'予約は doneBefore より古いものを消す');
 await p.same(s=>s.finishAiRequest('r4',{status:'done',result:'x',reason:null,updated:at(7)}));await p.same(s=>s.cleanupAiRequests(at(7),at(2)));assert.equal((await p.same(s=>s.getAiRequest('a1','k1')))?.status,'done','updated が doneBefore と等しいものは残る（未満だけ消す）');
 await p.same(s=>s.cleanupAiRequests(at(8),at(2)));assert.equal(await p.same(s=>s.getAiRequest('a1','k1')),null)});
// 今回足した SQL：月の無料分の回数・高度な生成の回数を予約で数える（migrations/0002 の列）、請求済みは集計した行の id だけ、登録の数
test('AI の予約：月の「課題生成」の回数（記録済み＋作っている最中）と高度な生成の回数も 1 文で数える。請求済みは集計した id の行だけ。登録の数は時刻で数える',async t=>{const p=await pair(t);const base={account:'a',since:at(0),staleBefore:at(0),dayLimit:100,maxInflight:10,month:'2026-04'};
 const usage=(id,o)=>({id,account:'a',month:'2026-04',label:'課題生成',mode:'now',model:'m',input:1,output:1,cache_read:0,cache_write:0,cost_usd:0.1,billable:0,charge_micro:0,ok:1,created:at(1),...o});
 await p.same(s=>s.addAiUsage(usage('u1')));await p.same(s=>s.addAiUsage(usage('u2',{ok:0})),'作成できなかった回は数えない');
 assert.equal(await p.same(s=>s.reserveAi({...base,id:'r1',created:at(2),label:'課題生成',monthLimit:2})),true,'記録 1 件＋予約 0 件 < 2');assert.equal(await p.same(s=>s.reserveAi({...base,id:'r2',created:at(3),label:'課題生成',monthLimit:2})),false,'記録 1 件＋予約 1 件 = 2');
 assert.equal(await p.same(s=>s.reserveAi({...base,id:'r3',created:at(3),label:'質問の作成',monthLimit:null})),true,'回数を見ない依頼は入る');assert.equal(await p.same(s=>s.reserveAi({...base,id:'r4',created:at(3),label:'課題生成',monthLimit:null})),true,'請求できる人（monthLimit なし）は入る');
 await p.same(s=>s.addAiUsage(usage('u3',{mode:'advanced'})));assert.equal(await p.same(s=>s.reserveAi({...base,id:'r5',created:at(4),label:'課題生成',mode:'advanced',advancedLimit:3})),true);assert.equal(await p.same(s=>s.reserveAi({...base,id:'r6',created:at(4),label:'課題生成',mode:'advanced',advancedLimit:3})),true);assert.equal(await p.same(s=>s.reserveAi({...base,id:'r7',created:at(4),label:'課題生成',mode:'advanced',advancedLimit:3})),false,'記録 1＋予約 2 = 3');
 await p.same(s=>s.releaseAi('r5'));assert.equal(await p.same(s=>s.reserveAi({...base,id:'r8',created:at(4),label:'課題生成',mode:'advanced',advancedLimit:3})),true,'解放すれば空く');
 await p.same(s=>s.addAiUsage(usage('b1',{billable:1,charge_micro:90e6,created:at(5)})));await p.same(s=>s.addAiUsage(usage('b2',{billable:1,charge_micro:45e6,created:at(6)})));await p.same(s=>s.addAiUsage(usage('b3',{billable:1,charge_micro:10e6,created:at(9)})));await p.same(s=>s.addAiUsage(usage('b4',{account:'z',billable:1,charge_micro:1e6,created:at(5)})));
 const g=await p.same(async s=>sorted((await s.unbilledAiCharges(at(7))).map(r=>({...r,ids:[...r.ids].sort()}))),'cutoff までの未請求を利用者ごとに集計し、行の id を持つ');assert.deepEqual(g,[{account:'a',charge_micro:135e6,ids:['b1','b2']},{account:'z',charge_micro:1e6,ids:['b4']}]);
 await p.same(s=>s.markAiBilled('a',['b1','b2'],'2026-04-01'));assert.deepEqual(await p.same(async s=>sorted(await s.unbilledAiCharges(at(10)))),[{account:'a',charge_micro:10e6,ids:['b3']},{account:'z',charge_micro:1e6,ids:['b4']}],'集計した id だけ請求済みになり、ほかの利用者と後の行は残る');
 await p.same(s=>s.markAiBilled('a',['b3','b4'],'2026-04-02'));assert.deepEqual(await p.same(async s=>sorted(await s.unbilledAiCharges(at(10)))),[{account:'z',charge_micro:1e6,ids:['b4']}],'別の利用者の id は請求済みにしない');
 await p.same(s=>s.createAccount({id:'n1',ownerHash:'o9',deviceHash:'d9',created:at(20)}));await p.same(s=>s.createAccount({id:'n2',ownerHash:'o8',deviceHash:'d8',created:at(30)}));assert.equal(await p.same(s=>s.countAccountsSince(at(25))),1);assert.equal(await p.same(s=>s.countAccountsSince(at(0))),2)});
