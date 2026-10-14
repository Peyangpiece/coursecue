// 管理者画面（/admin.html）の API と集計。認証は Worker の秘密 ADMIN_TOKEN（32 文字以上）で、利用者の接続キー・Mac の鍵とは別
// 利用者の状態からは、件数・最終接続・版・AI の使用量の集計だけを読む（授業名・課題・資料の中身は返さない）
// 売上は入金の記録、費用は登録した費用、AI の費用は「saboro の API」プランの利用者の使用量から Claude Sonnet 5.5 の通常料金で出した目安
import {billingOf} from './billing.js';
export const PLANS=['api','byo','free'],STATUSES=['active','trial','stopped'];
// paymentLink：Stripe の支払いリンク（https://buy.stripe.com/…）。利用者ごとに client_reference_id を付けて画面に出す
// requirePayment：支払いを必須にする（定期支払いが有効でない利用者は同期・回答の作成などを止める。プランが「無料」の人は対象外）。portalLink：Stripe の顧客ポータル（解約・カード変更）。monthlyPrice：支払い画面に出す月額
// aiIncluded：SaBoRo の AI の月の無料分（課題生成の回数）。aiMarkup：無料分を超えた分の請求＝実費×この倍率
export const DEFAULT_SETTINGS={feeRate:0.036,taxable:false,usdJpy:150,paymentLink:'',requirePayment:false,portalLink:'',monthlyPrice:0,aiIncluded:60,aiMarkup:1.5};
const CUSTOMER=/^cus_[A-Za-z0-9]{1,100}$/;
const MONTH=/^\d{4}-(0[1-9]|1[0-2])$/,DATE=/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const monthAdd=(m,n)=>{const [y,mo]=m.split('-').map(Number),d=new Date(Date.UTC(y,mo-1+n,1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`};
// 「今月」は日本時間で決める
export const currentMonth=(now=new Date())=>{const d=new Date(now.getTime()+9*3600e3);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`};
export const costApplies=(c,m)=>c.recurring?c.month<=m&&(!c.end_month||m<=c.end_month):c.month===m;
const parse=v=>{if(v==null)return null;if(typeof v==='object')return v;try{return JSON.parse(v)}catch{return null}};
// 保存先から読んだ 1 行を画面に出す形にそろえる（D1 と記憶上の保存先で同じ形）
export function userRow(r){return {account:r.account,created:r.created||null,seen:r.seen||null,os:r.os||null,version:r.version||null,runtime:r.runtime||null,lastSync:r.last_sync||null,creds:!!r.creds,tasks:Number(r.tasks)||0,courses:Number(r.courses)||0,lastError:r.last_error?String(r.last_error).slice(0,120):null,usage:parse(r.usage),label:r.label||'',plan:PLANS.includes(r.plan)?r.plan:'byo',price:Number(r.price)||0,status:STATUSES.includes(r.status)?r.status:'trial',started:r.started||'',note:r.note||''}}
const usageOf=(u,m)=>u.usage?.months?.[m]||null;
// 1 か月分の集計
// aiRows：SaBoRo の AI の実際の使用量（利用者ごとの月の合計）。あれば AI の費用はこの実費、なければ「saboro の API」プランの人の使用量から出した目安
export function summarize({month,users,payments,costs,settings=DEFAULT_SETTINGS,now=new Date(),aiRows=null}){const s={...DEFAULT_SETTINGS,...settings},inMonth=payments.filter(p=>p.month===month);
 const revenue=inMonth.reduce((a,p)=>a+p.amount,0),fees=Math.round(revenue*s.feeRate),tax=s.taxable?Math.round(revenue*10/110):0;
 const apiUsd=aiRows?aiRows.reduce((a,r)=>a+(Number(r.cost_usd)||0),0):users.filter(u=>u.plan==='api').reduce((a,u)=>a+(usageOf(u,month)?.estimateUsd||0),0),apiCost=Math.round(apiUsd*s.usdJpy);
 const fixed=costs.filter(c=>costApplies(c,month)).reduce((a,c)=>a+c.amount,0),profit=revenue-fees-tax-apiCost-fixed;
 const payers=new Set(inMonth.map(p=>p.account)),billable=users.filter(u=>u.status==='active'&&u.price>0);
 const usage={calls:0,failed:0,tokenCalls:0,input:0,output:0,estimateUsd:0,byProvider:{}};for(const u of users){const m=usageOf(u,month);if(!m)continue;usage.calls+=m.calls||0;usage.failed+=m.failed||0;const t=m.tokens||{};usage.tokenCalls+=t.calls||0;usage.input+=(t.input||0)+(t.cacheRead||0)+(t.cacheWrite||0);usage.output+=t.output||0;usage.estimateUsd+=m.estimateUsd||0;for(const [k,v] of Object.entries(m.byProvider||{})){const p=usage.byProvider[k]||={calls:0,failed:0};p.calls+=v.calls||0;p.failed+=v.failed||0}}
 const since=h=>users.filter(u=>u.seen&&now-new Date(u.seen)<=h*3600e3).length;
 return {month,apiActual:!!aiRows,aiCharge:aiRows?Math.round(aiRows.reduce((a,r)=>a+(Number(r.charge_micro)||0),0)/1e6):0,revenue,expected:billable.reduce((a,u)=>a+u.price,0),fees,tax,apiCost,apiUsd,fixed,profit,paying:payers.size,perPaying:payers.size?Math.round(profit/payers.size):null,unpaid:billable.filter(u=>!payers.has(u.account)).map(u=>u.account),usage,users:{total:users.length,active:users.filter(u=>u.status==='active').length,trial:users.filter(u=>u.status==='trial').length,stopped:users.filter(u=>u.status==='stopped').length,seen24h:since(24),seen7d:since(24*7)}}}
// 入力の確認（不正なら null）
const str=(v,max,{required=false}={})=>{if(v==null||v==='')return required?null:'';const t=String(v).trim();return t.length>max||(required&&!t)?null:t};
const int=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max?v:null;
export function validUser(d){const label=str(d.label,40),note=str(d.note,500),started=d.started?(DATE.test(d.started)?d.started:null):'',price=int(d.price,0,1000000);if(label==null||note==null||started==null||price==null||!PLANS.includes(d.plan)||!STATUSES.includes(d.status))return null;return {label,plan:d.plan,price,status:d.status,started,note}}
export function validPayment(d){const amount=int(d.amount,-10000000,10000000),method=str(d.method,20),note=str(d.note,200),paid_on=d.paid_on?(DATE.test(d.paid_on)?d.paid_on:null):'';if(!amount||!MONTH.test(d.month||'')||method==null||note==null||paid_on==null)return null;return {month:d.month,amount,method,paid_on,note}}
export function validCost(d){const item=str(d.item,40,{required:true}),note=str(d.note,200),amount=int(d.amount,0,10000000);if(item==null||note==null||amount==null||!MONTH.test(d.month||'')||typeof d.recurring!=='boolean')return null;return {item,amount,month:d.month,recurring:d.recurring?1:0,note}}
const URL_OK=v=>!v||/^https:\/\/[^\s?#]{1,290}$/.test(v),URL_Q=v=>!v||/^https:\/\/[^\s#]{1,290}$/.test(v);
export function validSettings(d){const ok=typeof d.feeRate==='number'&&d.feeRate>=0&&d.feeRate<=0.2&&typeof d.taxable==='boolean'&&typeof d.usdJpy==='number'&&d.usdJpy>=50&&d.usdJpy<=500;const opt=k=>d[k]==null?undefined:String(d[k]).trim();const link=opt('paymentLink'),portal=opt('portalLink');
 if(!ok||!URL_OK(link)||!URL_Q(portal)||(d.requirePayment!=null&&typeof d.requirePayment!=='boolean')||(d.monthlyPrice!=null&&!(Number.isInteger(d.monthlyPrice)&&d.monthlyPrice>=0&&d.monthlyPrice<=100000))||(d.aiIncluded!=null&&!(Number.isInteger(d.aiIncluded)&&d.aiIncluded>=0&&d.aiIncluded<=1000))||(d.aiMarkup!=null&&!(typeof d.aiMarkup==='number'&&d.aiMarkup>=1&&d.aiMarkup<=5)))return null;
 return {feeRate:d.feeRate,taxable:d.taxable,usdJpy:d.usdJpy,...(link!==undefined?{paymentLink:link}:{}),...(portal!==undefined?{portalLink:portal}:{}),...(d.requirePayment!=null?{requirePayment:d.requirePayment}:{}),...(d.monthlyPrice!=null?{monthlyPrice:d.monthlyPrice}:{}),...(d.aiIncluded!=null?{aiIncluded:d.aiIncluded}:{}),...(d.aiMarkup!=null?{aiMarkup:d.aiMarkup}:{})}}
// /api/admin/* の処理。json・equal は worker.js から受け取る
export async function handleAdmin(req,u,env,store,{json,equal,origin}){const token=env.ADMIN_TOKEN;if(!token||String(token).length<32)return json({error:'admin_not_configured'},503,origin);
 const key=req.headers.get('Authorization')?.replace(/^Bearer /,'');if(!(await equal(key,token)))return json({error:'unauthorized'},401,origin);
 const path=u.pathname.slice('/api/admin'.length),body=req.method==='POST'?await req.json().catch(()=>null):null;if(req.method==='POST'&&!body)return json({error:'invalid'},400,origin);
 const bad=()=>json({error:'invalid'},400,origin),ok=()=>json({ok:true},200,origin),now=new Date();
 if(path==='/overview'&&req.method==='GET'){const q=u.searchParams.get('month'),month=MONTH.test(q||'')?q:currentMonth(now);const months=[-5,-4,-3,-2,-1,0].map(i=>monthAdd(month,i));const [users,payments,costs,settings,unmatched,customers,subscriptions,aiByMonth]=await Promise.all([store.adminUsers().then(rows=>rows.map(userRow)),store.listPayments(monthAdd(month,-5),month),store.listCosts(),store.getAdminSettings(),store.listUnmatched(),store.listStripeCustomers(),store.listSubscriptions(),Promise.all(months.map(m=>store.aiMonthAll(m)))]);const set={...DEFAULT_SETTINGS,...settings},aiOf=m=>aiByMonth[months.indexOf(m)]||[];
  const trend=months.map(m=>{const r=summarize({month:m,users,payments,costs,settings:set,now,aiRows:aiOf(m)});return {month:m,revenue:r.revenue,fees:r.fees,tax:r.tax,apiCost:r.apiCost,fixed:r.fixed,profit:r.profit,paying:r.paying}});
  return json({month,current:currentMonth(now),settings:set,summary:summarize({month,users,payments,costs,settings:set,now,aiRows:aiOf(month)}),trend,users:users.map(({usage,...x})=>({...x,usageMonth:usageOf({usage},month),ai:(r=>r?{count:Number(r.count)||0,calls:Number(r.calls)||0,costUsd:Number(r.cost_usd)||0,chargeYen:Math.round((Number(r.charge_micro)||0)/1e6)}:null)(aiOf(month).find(r=>r.account===x.account)),stripeCustomers:customers.filter(c=>c.account===x.account).map(c=>c.customer),billing:billingOf({account:x.account,settings:set,plan:x.plan,subs:subscriptions.filter(s=>s.account===x.account)})})),stripe:{configured:!!env.STRIPE_WEBHOOK_SECRET,unmatched},payments:payments.filter(p=>p.month===month),costs:costs.map(c=>({...c,recurring:!!c.recurring,applies:costApplies(c,month)}))},200,origin)}
 if(req.method!=='POST')return json({error:'not_found'},404,origin);
 if(path==='/user'){const v=validUser(body);if(!v||!(await store.hasAccount(String(body.account||''))))return bad();await store.putAdminUser({account:body.account,...v,updated:now.toISOString()});return ok()}
 if(path==='/payment'){const v=validPayment(body);if(!v||!(await store.hasAccount(String(body.account||''))))return bad();await store.addPayment({id:crypto.randomUUID(),account:body.account,...v,created:now.toISOString()});return ok()}
 if(path==='/payment/delete'){await store.deletePayment(String(body.id||''));return ok()}
 if(path==='/cost'){const v=validCost(body);if(!v)return bad();await store.addCost({id:crypto.randomUUID(),...v,created:now.toISOString()});return ok()}
 if(path==='/cost/end'){if(!MONTH.test(body.month||''))return bad();await store.endCost(String(body.id||''),body.month);return ok()}
 if(path==='/cost/delete'){await store.deleteCost(String(body.id||''));return ok()}
 // Stripe 連携：未割り当ての入金を利用者に割り当てる・顧客 ID の対応を登録／解除する・未割り当てを消す
 if(path==='/stripe/assign'){if(!(await store.hasAccount(String(body.account||''))))return bad();return (await store.assignUnmatched(String(body.id||''),body.account))?ok():bad()}
 if(path==='/stripe/link'){if(!CUSTOMER.test(body.customer||'')||!(await store.hasAccount(String(body.account||''))))return bad();await store.linkStripeCustomer(body.customer,body.account);return ok()}
 if(path==='/stripe/unlink'){if(!CUSTOMER.test(body.customer||''))return bad();await store.unlinkStripeCustomer(body.customer);return ok()}
 if(path==='/stripe/unmatched/delete'){await store.deleteUnmatched(String(body.id||''));return ok()}
 if(path==='/settings'){const v=validSettings(body);if(!v)return bad();await store.putAdminSettings(v);return ok()}
 return json({error:'not_found'},404,origin)}
