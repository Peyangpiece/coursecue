import {handleAdmin} from './admin.js';import {handleStripe} from './stripe.js';
const origins=['https://coursecue.hrk-6888.workers.dev','https://coursecue-2026.web.app'];
const KINDS=['sync','generate','submit','supplement','settings','credentials','verify','timetable','link','attendance'];
const json=(data,status=200,origin='')=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':origins.includes(origin)?origin:origins[0],'Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Vary':'Origin'}});
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
export const sha256=async v=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)));
async function equal(a,b){if(!a||!b)return false;const x=await sha256(a),y=await sha256(b);let d=0;for(let i=0;i<x.length;i++)d|=x.charCodeAt(i)^y.charCodeAt(i);return d===0}
const TOKEN=/^[0-9a-f]{64}$/;
// D1 を使う保存先。テストでは同じ形の記憶上の保存先を使う
export function d1Store(db){return {
 async getState(account){const row=await db.prepare('SELECT value FROM account_state WHERE account=?').bind(account).first();if(row)return row.value;if(account!=='legacy')return null;const old=await db.prepare('SELECT value FROM state WHERE id=?').bind('dashboard').first();return old?old.value:null},
 async putState(account,value){await db.prepare('INSERT INTO account_state(account,value) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET value=excluded.value').bind(account,value).run()},
 async insertJob(j){await db.prepare('INSERT INTO account_jobs(id,account,kind,task,payload,created,updated) VALUES(?,?,?,?,?,?,?)').bind(j.id,j.account,j.kind,j.task,j.payload,j.created,j.updated).run()},
 async listJobs(account){return (await db.prepare('SELECT id,kind,task,status,result,created,updated FROM account_jobs WHERE account=? ORDER BY created DESC LIMIT 50').bind(account).all()).results},
 async claimJob(account,now){return db.prepare("UPDATE account_jobs SET status='running',updated=? WHERE id=(SELECT id FROM account_jobs WHERE account=? AND status='pending' ORDER BY created LIMIT 1) AND status='pending' RETURNING *").bind(now,account).first()},
 async finishJob(account,id,status,result,now){await db.prepare("UPDATE account_jobs SET status=?,result=?,updated=?,payload=CASE WHEN kind='credentials' THEN '{}' ELSE payload END WHERE id=? AND account=? AND status='running'").bind(status,result,now,id,account).run()},
 async findAccount(hash){const row=await db.prepare('SELECT id,owner_hash,device_hash FROM accounts WHERE owner_hash=? OR device_hash=?').bind(hash,hash).first();return row?{id:row.id,role:row.owner_hash===hash?'owner':'device'}:null},
 async createAccount(a){await db.prepare('INSERT INTO accounts(id,owner_hash,device_hash,created) VALUES(?,?,?,?)').bind(a.id,a.ownerHash,a.deviceHash,a.created).run()},
 // 管理者画面：状態からは件数・最終接続・版・使用量の集計だけを取り出す（最初の利用者 legacy は accounts にないので状態から足す）
 async adminUsers(){const cols="json_extract(s.value,'$.deviceSeen') AS seen,json_extract(s.value,'$.os') AS os,json_extract(s.value,'$.version') AS version,json_extract(s.value,'$.runtime') AS runtime,json_extract(s.value,'$.lastSync') AS last_sync,json_extract(s.value,'$.credentialsConfigured') AS creds,json_array_length(s.value,'$.tasks') AS tasks,json_array_length(s.value,'$.courses') AS courses,json_extract(s.value,'$.lastError') AS last_error,json_extract(s.value,'$.usage') AS usage,u.label,u.plan,u.price,u.status,u.started,u.note";return (await db.prepare(`SELECT a.id AS account,a.created,${cols} FROM accounts a LEFT JOIN account_state s ON s.account=a.id LEFT JOIN admin_users u ON u.account=a.id UNION ALL SELECT s.account,NULL,${cols} FROM account_state s LEFT JOIN admin_users u ON u.account=s.account WHERE s.account='legacy' ORDER BY 2`).all()).results},
 async hasAccount(id){if(!id)return false;const row=id==='legacy'?await db.prepare("SELECT 1 AS x FROM account_state WHERE account='legacy'").first():await db.prepare('SELECT 1 AS x FROM accounts WHERE id=?').bind(id).first();return !!row},
 async putAdminUser(r){await db.prepare('INSERT INTO admin_users(account,label,plan,price,status,started,note,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET label=excluded.label,plan=excluded.plan,price=excluded.price,status=excluded.status,started=excluded.started,note=excluded.note,updated=excluded.updated').bind(r.account,r.label,r.plan,r.price,r.status,r.started||null,r.note,r.updated).run()},
 async listPayments(from,to){return (await db.prepare('SELECT id,account,month,amount,method,paid_on,note,created FROM admin_payments WHERE month>=? AND month<=? ORDER BY month DESC,created DESC').bind(from,to).all()).results},
 async addPayment(p){await db.prepare('INSERT INTO admin_payments(id,account,month,amount,method,paid_on,note,created) VALUES(?,?,?,?,?,?,?,?)').bind(p.id,p.account,p.month,p.amount,p.method,p.paid_on||null,p.note,p.created).run()},
 async deletePayment(id){await db.prepare('DELETE FROM admin_payments WHERE id=?').bind(id).run()},
 async listCosts(){return (await db.prepare('SELECT id,item,amount,month,recurring,end_month,note,created FROM admin_costs ORDER BY month,created').all()).results},
 async addCost(c){await db.prepare('INSERT INTO admin_costs(id,item,amount,month,recurring,note,created) VALUES(?,?,?,?,?,?,?)').bind(c.id,c.item,c.amount,c.month,c.recurring,c.note,c.created).run()},
 async endCost(id,month){await db.prepare('UPDATE admin_costs SET end_month=? WHERE id=? AND recurring=1').bind(month,id).run()},
 async deleteCost(id){await db.prepare('DELETE FROM admin_costs WHERE id=?').bind(id).run()},
 async getAdminSettings(){const out={};for(const r of (await db.prepare('SELECT key,value FROM admin_settings').all()).results){try{out[r.key]=JSON.parse(r.value)}catch{}}return out},
 async putAdminSettings(v){for(const [k,x] of Object.entries(v))await db.prepare('INSERT INTO admin_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k,JSON.stringify(x)).run()},
 // Stripe 連携：入金は記録の ID で上書き（同じ通知が何度届いても 1 件）
 async upsertPayment(p){await db.prepare('INSERT INTO admin_payments(id,account,month,amount,method,paid_on,note,created) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account=excluded.account,month=excluded.month,amount=excluded.amount,paid_on=excluded.paid_on,note=excluded.note').bind(p.id,p.account,p.month,p.amount,p.method,p.paid_on||null,p.note,p.created).run()},
 async paymentAccountOf(id){return (await db.prepare('SELECT account FROM admin_payments WHERE id=?').bind(id).first())?.account||null},
 async stripeAccountFor(customer){return (await db.prepare('SELECT account FROM admin_stripe_customers WHERE customer=?').bind(customer).first())?.account||null},
 async listStripeCustomers(){return (await db.prepare('SELECT customer,account,created FROM admin_stripe_customers ORDER BY created').all()).results},
 // 顧客と利用者を対応させ、その顧客の未割り当ての入金を利用者の入金に移す
 async linkStripeCustomer(customer,account){const now=new Date().toISOString();await db.batch([db.prepare('INSERT INTO admin_stripe_customers(customer,account,created) VALUES(?,?,?) ON CONFLICT(customer) DO UPDATE SET account=excluded.account').bind(customer,account,now),db.prepare("INSERT INTO admin_payments(id,account,month,amount,method,paid_on,note,created) SELECT id,?,month,amount,'Stripe',paid_on,note,created FROM admin_stripe_unmatched WHERE customer=? ON CONFLICT(id) DO UPDATE SET account=excluded.account,amount=excluded.amount").bind(account,customer),db.prepare('DELETE FROM admin_stripe_unmatched WHERE customer=?').bind(customer)])},
 async unlinkStripeCustomer(customer){await db.prepare('DELETE FROM admin_stripe_customers WHERE customer=?').bind(customer).run()},
 async upsertUnmatched(u){await db.prepare('INSERT INTO admin_stripe_unmatched(id,customer,email,month,amount,paid_on,note,created) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount,paid_on=excluded.paid_on,note=excluded.note').bind(u.id,u.customer,u.email,u.month,u.amount,u.paid_on||null,u.note,u.created).run()},
 async listUnmatched(){return (await db.prepare('SELECT id,customer,email,month,amount,paid_on,note,created FROM admin_stripe_unmatched ORDER BY created DESC').all()).results},
 // 1 件を利用者に割り当てる（顧客 ID があれば対応も覚え、その顧客の他の未割り当ても移す）
 async assignUnmatched(id,account){const row=await db.prepare('SELECT * FROM admin_stripe_unmatched WHERE id=?').bind(id).first();if(!row)return false;if(row.customer){await this.linkStripeCustomer(row.customer,account);return true}await db.batch([db.prepare("INSERT INTO admin_payments(id,account,month,amount,method,paid_on,note,created) VALUES(?,?,?,?,'Stripe',?,?,?) ON CONFLICT(id) DO UPDATE SET account=excluded.account,amount=excluded.amount").bind(row.id,account,row.month,row.amount,row.paid_on,row.note,row.created),db.prepare('DELETE FROM admin_stripe_unmatched WHERE id=?').bind(id)]);return true},
 async deleteUnmatched(id){await db.prepare('DELETE FROM admin_stripe_unmatched WHERE id=?').bind(id).run()}}}
// 記憶上の保存先（テスト用）
export function memoryStore(){const states=new Map(),jobs=[],accounts=[],admin=new Map(),payments=[],costs=[],settings={},customers=new Map(),unmatched=new Map();const upsert=p=>{const i=payments.findIndex(x=>x.id===p.id);if(i<0)payments.push({...p});else Object.assign(payments[i],{account:p.account,month:p.month,amount:p.amount,paid_on:p.paid_on,note:p.note})};return {
 async getState(a){return states.get(a)??null},async putState(a,v){states.set(a,v)},
 async insertJob(j){jobs.push({...j,status:'pending',result:null})},
 async listJobs(a){return jobs.filter(j=>j.account===a).sort((x,y)=>y.created.localeCompare(x.created)).slice(0,50).map(({account,payload,...j})=>j)},
 async claimJob(a,now){const j=jobs.filter(j=>j.account===a&&j.status==='pending').sort((x,y)=>x.created.localeCompare(y.created))[0];if(!j)return null;j.status='running';j.updated=now;return {...j}},
 async finishJob(a,id,status,result,now){const j=jobs.find(j=>j.id===id&&j.account===a&&j.status==='running');if(j){j.status=status;j.result=result;j.updated=now;if(j.kind==='credentials')j.payload='{}'}},
 async findAccount(h){const a=accounts.find(a=>a.ownerHash===h||a.deviceHash===h);return a?{id:a.id,role:a.ownerHash===h?'owner':'device'}:null},
 async createAccount(a){if(accounts.some(x=>x.ownerHash===a.ownerHash||x.deviceHash===a.deviceHash))throw Error('duplicate');accounts.push(a)},
 async adminUsers(){const row=(account,created)=>{let v=null;try{v=JSON.parse(states.get(account)||'null')}catch{}const m=admin.get(account)||{};return {account,created,seen:v?.deviceSeen??null,os:v?.os??null,version:v?.version??null,runtime:v?.runtime??null,last_sync:v?.lastSync??null,creds:v?.credentialsConfigured?1:0,tasks:Array.isArray(v?.tasks)?v.tasks.length:null,courses:Array.isArray(v?.courses)?v.courses.length:null,last_error:v?.lastError??null,usage:v?.usage?JSON.stringify(v.usage):null,...m}};return [...accounts.map(a=>row(a.id,a.created)),...(states.has('legacy')?[row('legacy',null)]:[])]},
 async hasAccount(id){return id==='legacy'?states.has('legacy'):accounts.some(a=>a.id===id)},
 async putAdminUser(r){const {account,...rest}=r;admin.set(account,rest)},
 async listPayments(from,to){return payments.filter(p=>p.month>=from&&p.month<=to).sort((a,b)=>b.month.localeCompare(a.month)||b.created.localeCompare(a.created)).map(p=>({...p}))},
 async addPayment(p){payments.push({...p})},async deletePayment(id){const i=payments.findIndex(p=>p.id===id);if(i>=0)payments.splice(i,1)},
 async listCosts(){return costs.map(c=>({end_month:null,...c}))},async addCost(c){costs.push({...c})},
 async endCost(id,month){const c=costs.find(c=>c.id===id&&c.recurring);if(c)c.end_month=month},async deleteCost(id){const i=costs.findIndex(c=>c.id===id);if(i>=0)costs.splice(i,1)},
 async getAdminSettings(){return {...settings}},async putAdminSettings(v){Object.assign(settings,v)},
 async upsertPayment(p){upsert(p)},async paymentAccountOf(id){return payments.find(p=>p.id===id)?.account||null},
 async stripeAccountFor(c){return customers.get(c)?.account||null},async listStripeCustomers(){return [...customers].map(([customer,v])=>({customer,...v}))},
 async linkStripeCustomer(customer,account){customers.set(customer,{account,created:customers.get(customer)?.created||new Date().toISOString()});for(const [id,u] of [...unmatched])if(u.customer===customer){upsert({id,account,month:u.month,amount:u.amount,method:'Stripe',paid_on:u.paid_on,note:u.note,created:u.created});unmatched.delete(id)}},
 async unlinkStripeCustomer(c){customers.delete(c)},
 async upsertUnmatched(u){unmatched.set(u.id,{...(unmatched.get(u.id)||{}),...u})},async listUnmatched(){return [...unmatched.values()].sort((a,b)=>b.created.localeCompare(a.created)).map(u=>({...u}))},
 async assignUnmatched(id,account){const u=unmatched.get(id);if(!u)return false;if(u.customer){await this.linkStripeCustomer(u.customer,account);return true}upsert({id,account,month:u.month,amount:u.amount,method:'Stripe',paid_on:u.paid_on,note:u.note,created:u.created});unmatched.delete(id);return true},
 async deleteUnmatched(id){unmatched.delete(id)}}}
// 認証：登録済みの接続キー（owner）または Mac の鍵（device）。環境変数の旧トークンは最初の利用者（legacy）として扱う
async function authenticate(key,env,store){if(!key)return null;if(await equal(key,env.OWNER_TOKEN))return {id:'legacy',role:'owner'};if(await equal(key,env.DEVICE_TOKEN))return {id:'legacy',role:'device'};if(!TOKEN.test(key))return null;return store.findAccount(await sha256(key))}
export async function handle(req,env,store){const u=new URL(req.url),origin=req.headers.get('Origin')||'';
if(!u.pathname.startsWith('/api/'))return env.ASSETS.fetch(req);
if(origin&&!origins.includes(origin))return json({error:'origin_denied'},403,origin);
if(req.method==='OPTIONS')return json({},200,origin);
try{
// 管理者画面の API（ADMIN_TOKEN で認証。利用者の鍵とは別）
if(u.pathname.startsWith('/api/admin/'))return await handleAdmin(req,u,env,store,{json,equal,origin});
// Stripe の通知（署名で確認。利用者の鍵は使わない）
if(u.pathname==='/api/stripe/webhook')return await handleStripe(req,env,store,{json,origin});
// 利用者の登録：Mac のセットアップが作った接続キーと Mac の鍵（どちらも 64 桁の16進）のハッシュだけを保存する
if(u.pathname==='/api/register'&&req.method==='POST'){const d=await req.json().catch(()=>({}));if(!TOKEN.test(d.owner||'')||!TOKEN.test(d.device||'')||d.owner===d.device)return json({error:'invalid_token'},400,origin);const id=crypto.randomUUID();try{await store.createAccount({id,ownerHash:await sha256(d.owner),deviceHash:await sha256(d.device),created:new Date().toISOString()})}catch{return json({error:'already_registered'},409,origin)}return json({id},201,origin)}
const key=req.headers.get('Authorization')?.replace(/^Bearer /,'');const who=await authenticate(key,env,store);
if(!who)return json({error:'unauthorized'},401,origin);
const agent=who.role==='device',owner=who.role==='owner',account=who.id;
if(u.pathname==='/api/state'&&req.method==='GET'){const value=await store.getState(account);return json({...(value?JSON.parse(value):{tasks:[],materials:[],connection:'not_configured'}),deployed:env.DEPLOYED_SHA||''},200,origin)}
if(u.pathname==='/api/state'&&req.method==='POST'&&agent){const value=await req.text();if(value.length>2000000)return json({error:'too_large'},413,origin);JSON.parse(value);await store.putState(account,value);return json({ok:true},200,origin)}
if(u.pathname==='/api/jobs'&&req.method==='POST'&&owner){const data=await req.json();if(!KINDS.includes(data.kind)||JSON.stringify(data).length>100000)return json({error:'invalid_job'},400,origin);const id=crypto.randomUUID(),now=new Date().toISOString();await store.insertJob({id,account,kind:data.kind,task:data.task||null,payload:JSON.stringify(data.payload||{}),created:now,updated:now});return json({id,status:'pending'},202,origin)}
if(u.pathname==='/api/jobs'&&req.method==='GET')return json(await store.listJobs(account),200,origin);
if(u.pathname==='/api/agent/claim'&&req.method==='POST'&&agent){const row=await store.claimJob(account,new Date().toISOString());const res=json(row?{id:row.id,kind:row.kind,task:row.task,status:row.status,created:row.created,updated:row.updated,payload:JSON.parse(row.payload)}:null,200,origin);if(env.DEPLOYED_SHA)res.headers.set('X-Coursecue-Deployed',env.DEPLOYED_SHA);return res}
if(u.pathname==='/api/agent/finish'&&req.method==='POST'&&agent){const d=await req.json();if(!['done','failed','waiting'].includes(d.status))return json({error:'invalid'},400,origin);await store.finishJob(account,String(d.id||''),d.status,JSON.stringify(d.result||{}),new Date().toISOString());return json({ok:true},200,origin)}
return json({error:'not_found'},404,origin)
}catch{return json({error:'request_failed'},500,origin)}}
export default {async fetch(req,env){return handle(req,env,d1Store(env.DB))}};
