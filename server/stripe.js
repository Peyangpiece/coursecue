// Stripe の通知（Webhook）を受けて入金を自動で記録する。受け口は /api/stripe/webhook、署名の秘密は Worker の秘密 STRIPE_WEBHOOK_SECRET（whsec_…）
// 扱う通知：
// - invoice.paid：定期支払い（サブスクリプション）の入金。請求書ごとに 1 件
// - checkout.session.completed / checkout.session.async_payment_succeeded：単発の支払い（mode=payment、コンビニ払いなど後から確定するものを含む）。
//   定期支払いの初回（mode=subscription）は invoice.paid と二重にならないよう入金は記録せず、client_reference_id から「顧客 → 利用者」の対応だけを覚える
// - charge.refunded：返金（一部返金を含む）。支払いごとに返金の合計をマイナスで記録（後から増えたら上書き）
// 利用者の特定：支払いリンクの client_reference_id（利用者の ID）、または覚えた Stripe の顧客 ID。分からない入金は「未割り当て」に置き、管理者画面で割り当てる
// 同じ通知が何度届いても、記録の ID（stripe:請求書 ID など）が同じなので二重にならない。円（JPY）以外の支払いは記録しない
const TOLERANCE=300;
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
async function hmac(secret,text){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text)))}
const same=(a,b)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0};
// Stripe-Signature: t=時刻,v1=署名[,v1=…]。署名は「時刻.本文」の HMAC-SHA256（16進）。5 分より古い・新しすぎるものは受け付けない
export async function verifyStripeSignature(body,header,secret,now=Date.now()){if(!header||!secret)return false;const parts=header.split(',').map(p=>p.split('=')),t=Number(parts.find(([k])=>k==='t')?.[1]),sigs=parts.filter(([k])=>k==='v1').map(([,v])=>v||'');if(!Number.isFinite(t)||!sigs.length||Math.abs(now/1000-t)>TOLERANCE)return false;const expected=await hmac(secret,`${t}.${body}`);return sigs.some(s=>same(s,expected))}
// 日本時間の日付・月（入金の月として使う）
export const jstDate=sec=>new Date(sec*1000+9*3600e3).toISOString().slice(0,10);
const REF=/^[A-Za-z0-9_-]{1,200}$/;
// 通知 1 件から記録する内容を作る（記録しないものは null）
export function paymentFromEvent(event){const o=event?.data?.object||{},type=event?.type;if(o.currency&&o.currency!=='jpy')return null;
 if(type==='invoice.paid'){if(!(o.amount_paid>0))return null;const at=o.status_transitions?.paid_at||event.created;return {id:`stripe:${o.id}`,customer:o.customer||'',email:o.customer_email||'',amount:o.amount_paid,paid_on:jstDate(at),note:`Stripe 請求書 ${o.number||o.id}`}}
 if(type==='checkout.session.completed'||type==='checkout.session.async_payment_succeeded'){if(o.mode!=='payment'||o.payment_status!=='paid'||!(o.amount_total>0))return null;return {id:`stripe:${o.id}`,customer:o.customer||'',email:o.customer_details?.email||'',reference:REF.test(o.client_reference_id||'')?o.client_reference_id:'',amount:o.amount_total,paid_on:jstDate(event.created),note:'Stripe 支払いリンク'}}
 if(type==='charge.refunded'){if(!(o.amount_refunded>0))return null;return {id:`stripe:refund:${o.id}`,customer:o.customer||'',email:o.billing_details?.email||o.receipt_email||'',amount:-o.amount_refunded,paid_on:jstDate(event.created),note:`Stripe 返金（${o.id}）`}}
 return null}
// 定期支払いの初回の Checkout：顧客 ID と利用者 ID の対応を覚える
export function linkFromEvent(event){const o=event?.data?.object||{};if(event?.type!=='checkout.session.completed'||!o.customer||!REF.test(o.client_reference_id||''))return null;return {customer:o.customer,account:o.client_reference_id}}
export async function handleStripe(req,env,store,{json,origin}){const secret=env.STRIPE_WEBHOOK_SECRET;if(!secret)return json({error:'stripe_not_configured'},503,origin);if(req.method!=='POST')return json({error:'not_found'},404,origin);
 const body=await req.text();if(body.length>1000000)return json({error:'too_large'},413,origin);if(!(await verifyStripeSignature(body,req.headers.get('Stripe-Signature'),secret)))return json({error:'bad_signature'},400,origin);
 let event;try{event=JSON.parse(body)}catch{return json({error:'invalid'},400,origin)}
 const link=linkFromEvent(event);if(link&&await store.hasAccount(link.account))await store.linkStripeCustomer(link.customer,link.account);
 const p=paymentFromEvent(event);if(!p)return json({received:true},200,origin);
 // 利用者：支払いリンクの利用者 ID → 覚えた顧客 ID の順に探す
 let account=p.reference&&await store.hasAccount(p.reference)?p.reference:null;if(account&&p.customer)await store.linkStripeCustomer(p.customer,account);if(!account&&p.customer)account=await store.stripeAccountFor(p.customer);
 // 前に割り当て済みの記録（一部返金が後から増えた場合など）は、その利用者のまま上書きする
 if(!account)account=await store.paymentAccountOf(p.id);
 const month=p.paid_on.slice(0,7),created=new Date().toISOString();
 if(account)await store.upsertPayment({id:p.id,account,month,amount:p.amount,method:'Stripe',paid_on:p.paid_on,note:p.note,created});
 else await store.upsertUnmatched({id:p.id,customer:p.customer,email:p.email,month,amount:p.amount,paid_on:p.paid_on,note:p.note,created});
 return json({received:true},200,origin)}
