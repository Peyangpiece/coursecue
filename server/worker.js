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
 async createAccount(a){await db.prepare('INSERT INTO accounts(id,owner_hash,device_hash,created) VALUES(?,?,?,?)').bind(a.id,a.ownerHash,a.deviceHash,a.created).run()}}}
// 記憶上の保存先（テスト用）
export function memoryStore(){const states=new Map(),jobs=[],accounts=[];return {
 async getState(a){return states.get(a)??null},async putState(a,v){states.set(a,v)},
 async insertJob(j){jobs.push({...j,status:'pending',result:null})},
 async listJobs(a){return jobs.filter(j=>j.account===a).sort((x,y)=>y.created.localeCompare(x.created)).slice(0,50).map(({account,payload,...j})=>j)},
 async claimJob(a,now){const j=jobs.filter(j=>j.account===a&&j.status==='pending').sort((x,y)=>x.created.localeCompare(y.created))[0];if(!j)return null;j.status='running';j.updated=now;return {...j}},
 async finishJob(a,id,status,result,now){const j=jobs.find(j=>j.id===id&&j.account===a&&j.status==='running');if(j){j.status=status;j.result=result;j.updated=now;if(j.kind==='credentials')j.payload='{}'}},
 async findAccount(h){const a=accounts.find(a=>a.ownerHash===h||a.deviceHash===h);return a?{id:a.id,role:a.ownerHash===h?'owner':'device'}:null},
 async createAccount(a){if(accounts.some(x=>x.ownerHash===a.ownerHash||x.deviceHash===a.deviceHash))throw Error('duplicate');accounts.push(a)}}}
// 認証：登録済みの接続キー（owner）または Mac の鍵（device）。環境変数の旧トークンは最初の利用者（legacy）として扱う
async function authenticate(key,env,store){if(!key)return null;if(await equal(key,env.OWNER_TOKEN))return {id:'legacy',role:'owner'};if(await equal(key,env.DEVICE_TOKEN))return {id:'legacy',role:'device'};if(!TOKEN.test(key))return null;return store.findAccount(await sha256(key))}
export async function handle(req,env,store){const u=new URL(req.url),origin=req.headers.get('Origin')||'';
if(!u.pathname.startsWith('/api/'))return env.ASSETS.fetch(req);
if(origin&&!origins.includes(origin))return json({error:'origin_denied'},403,origin);
if(req.method==='OPTIONS')return json({},200,origin);
try{
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
