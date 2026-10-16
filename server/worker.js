import {handleAdmin, health, userRow} from './admin.js';
import {currentCalendar, needsUpdate, calendarEnd} from './calendar.js';
import {handleStripe} from './stripe.js';
import {billingOf, PAID_KINDS} from './billing.js';
import {handleAi, aiStatus, runAiDaily} from './ai.js';
const origins = ['https://coursecue.hrk-6888.workers.dev'];
const KINDS = [
  'sync',
  'generate',
  'submit',
  'supplement',
  'settings',
  'credentials',
  'verify',
  'timetable',
  'link',
  'attendance',
  'prompt',
  'seen'
];
const json = (data, status = 200, origin = '') =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origins.includes(origin) ? origin : origins[0],
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      Vary: 'Origin'
    }
  });
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async v => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
async function equal(a, b) {
  if (!a || !b) return false;
  const x = await sha256(a),
    y = await sha256(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
const TOKEN = /^[0-9a-f]{64}$/,
  REGISTER_PER_HOUR = 20;
// D1 を使う保存先。テストでは同じ形の記憶上の保存先を使う
export function d1Store(db) {
  return {
    async getState(account) {
      const row = await db.prepare('SELECT value FROM account_state WHERE account=?').bind(account).first();
      if (row) return row.value;
      if (account !== 'legacy') return null;
      const old = await db.prepare('SELECT value FROM state WHERE id=?').bind('dashboard').first();
      return old ? old.value : null;
    },
    async putState(account, value) {
      await db
        .prepare(
          'INSERT INTO account_state(account,value) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET value=excluded.value'
        )
        .bind(account, value)
        .run();
    },
    async insertJob(j) {
      await db
        .prepare('INSERT INTO account_jobs(id,account,kind,task,payload,created,updated) VALUES(?,?,?,?,?,?,?)')
        .bind(j.id, j.account, j.kind, j.task, j.payload, j.created, j.updated)
        .run();
    },
    async listJobs(account) {
      return (
        await db
          .prepare(
            'SELECT id,kind,task,status,result,created,updated FROM account_jobs WHERE account=? ORDER BY created DESC LIMIT 50'
          )
          .bind(account)
          .all()
      ).results;
    },
    // exclude：取り出さない種類（支払いが必要な利用者の、作業を伴う処理）
    async claimJob(account, now, exclude = []) {
      const not = exclude.length ? ` AND kind NOT IN (${exclude.map(() => '?').join(',')})` : '';
      return db
        .prepare(
          `UPDATE account_jobs SET status='running',updated=? WHERE id=(SELECT id FROM account_jobs WHERE account=? AND status='pending'${not} ORDER BY created LIMIT 1) AND status='pending' RETURNING *`
        )
        .bind(now, account, ...exclude)
        .first();
    },
    async finishJob(account, id, status, result, now) {
      await db
        .prepare(
          "UPDATE account_jobs SET status=?,result=?,updated=?,payload=CASE WHEN kind='credentials' THEN '{}' ELSE payload END WHERE id=? AND account=? AND status='running'"
        )
        .bind(status, result, now, id, account)
        .run();
    },
    async findAccount(hash) {
      const row = await db
        .prepare('SELECT id,owner_hash,device_hash FROM accounts WHERE owner_hash=? OR device_hash=?')
        .bind(hash, hash)
        .first();
      return row ? {id: row.id, role: row.owner_hash === hash ? 'owner' : 'device'} : null;
    },
    async createAccount(a) {
      await db
        .prepare('INSERT INTO accounts(id,owner_hash,device_hash,created) VALUES(?,?,?,?)')
        .bind(a.id, a.ownerHash, a.deviceHash, a.created)
        .run();
    },
    // 管理者画面：状態からは件数・最終接続・版・使用量の集計だけを取り出す（最初の利用者 legacy は accounts にないので状態から足す）
    async adminUsers() {
      const cols =
        "json_extract(s.value,'$.deviceSeen') AS seen,json_extract(s.value,'$.os') AS os,json_extract(s.value,'$.version') AS version,json_extract(s.value,'$.runtime') AS runtime,json_extract(s.value,'$.lastSync') AS last_sync,json_extract(s.value,'$.credentialsConfigured') AS creds,json_array_length(s.value,'$.tasks') AS tasks,json_array_length(s.value,'$.courses') AS courses,json_extract(s.value,'$.lastError') AS last_error,json_extract(s.value,'$.lastErrorAt') AS last_error_at,json_extract(s.value,'$.usage') AS usage,u.label,u.plan,u.price,u.status,u.started,u.note";
      return (
        await db
          .prepare(
            `SELECT a.id AS account,a.created,${cols} FROM accounts a LEFT JOIN account_state s ON s.account=a.id LEFT JOIN admin_users u ON u.account=a.id UNION ALL SELECT s.account,NULL,${cols} FROM account_state s LEFT JOIN admin_users u ON u.account=s.account WHERE s.account='legacy' ORDER BY 2`
          )
          .all()
      ).results;
    },
    async hasAccount(id) {
      if (!id) return false;
      const row =
        id === 'legacy'
          ? await db.prepare("SELECT 1 AS x FROM account_state WHERE account='legacy'").first()
          : await db.prepare('SELECT 1 AS x FROM accounts WHERE id=?').bind(id).first();
      return !!row;
    },
    async putAdminUser(r) {
      await db
        .prepare(
          'INSERT INTO admin_users(account,label,plan,price,status,started,note,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET label=excluded.label,plan=excluded.plan,price=excluded.price,status=excluded.status,started=excluded.started,note=excluded.note,updated=excluded.updated'
        )
        .bind(r.account, r.label, r.plan, r.price, r.status, r.started || null, r.note, r.updated)
        .run();
    },
    async listPayments(from, to) {
      return (
        await db
          .prepare(
            'SELECT id,account,month,amount,method,paid_on,note,created FROM admin_payments WHERE month>=? AND month<=? ORDER BY month DESC,created DESC'
          )
          .bind(from, to)
          .all()
      ).results;
    },
    async addPayment(p) {
      await db
        .prepare(
          'INSERT INTO admin_payments(id,account,month,amount,method,paid_on,note,created) VALUES(?,?,?,?,?,?,?,?)'
        )
        .bind(p.id, p.account, p.month, p.amount, p.method, p.paid_on || null, p.note, p.created)
        .run();
    },
    async deletePayment(id) {
      await db.prepare('DELETE FROM admin_payments WHERE id=?').bind(id).run();
    },
    async listCosts() {
      return (
        await db
          .prepare(
            'SELECT id,item,amount,month,recurring,end_month,note,created FROM admin_costs ORDER BY month,created'
          )
          .all()
      ).results;
    },
    async addCost(c) {
      await db
        .prepare('INSERT INTO admin_costs(id,item,amount,month,recurring,note,created) VALUES(?,?,?,?,?,?,?)')
        .bind(c.id, c.item, c.amount, c.month, c.recurring, c.note, c.created)
        .run();
    },
    async endCost(id, month) {
      await db.prepare('UPDATE admin_costs SET end_month=? WHERE id=? AND recurring=1').bind(month, id).run();
    },
    async deleteCost(id) {
      await db.prepare('DELETE FROM admin_costs WHERE id=?').bind(id).run();
    },
    async getAdminSettings() {
      const out = {};
      for (const r of (await db.prepare('SELECT key,value FROM admin_settings').all()).results) {
        try {
          out[r.key] = JSON.parse(r.value);
        } catch {}
      }
      return out;
    },
    async putAdminSettings(v) {
      for (const [k, x] of Object.entries(v))
        await db
          .prepare(
            'INSERT INTO admin_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
          )
          .bind(k, JSON.stringify(x))
          .run();
    },
    // Stripe 連携：入金は記録の ID で上書き（同じ通知が何度届いても 1 件）
    async upsertPayment(p) {
      await db
        .prepare(
          'INSERT INTO admin_payments(id,account,month,amount,method,paid_on,note,created) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account=excluded.account,month=excluded.month,amount=excluded.amount,paid_on=excluded.paid_on,note=excluded.note'
        )
        .bind(p.id, p.account, p.month, p.amount, p.method, p.paid_on || null, p.note, p.created)
        .run();
    },
    async paymentAccountOf(id) {
      return (await db.prepare('SELECT account FROM admin_payments WHERE id=?').bind(id).first())?.account || null;
    },
    async stripeAccountFor(customer) {
      return (
        (await db.prepare('SELECT account FROM admin_stripe_customers WHERE customer=?').bind(customer).first())
          ?.account || null
      );
    },
    async listStripeCustomers() {
      return (await db.prepare('SELECT customer,account,created FROM admin_stripe_customers ORDER BY created').all())
        .results;
    },
    // 顧客と利用者を対応させ、その顧客の未割り当ての入金を利用者の入金に移す
    async linkStripeCustomer(customer, account) {
      const now = new Date().toISOString();
      await db.batch([
        db
          .prepare(
            'INSERT INTO admin_stripe_customers(customer,account,created) VALUES(?,?,?) ON CONFLICT(customer) DO UPDATE SET account=excluded.account'
          )
          .bind(customer, account, now),
        db
          .prepare(
            "INSERT INTO admin_payments(id,account,month,amount,method,paid_on,note,created) SELECT id,?,month,amount,'Stripe',paid_on,note,created FROM admin_stripe_unmatched WHERE customer=? ON CONFLICT(id) DO UPDATE SET account=excluded.account,amount=excluded.amount"
          )
          .bind(account, customer),
        db.prepare('DELETE FROM admin_stripe_unmatched WHERE customer=?').bind(customer)
      ]);
    },
    async unlinkStripeCustomer(customer) {
      await db.prepare('DELETE FROM admin_stripe_customers WHERE customer=?').bind(customer).run();
    },
    async upsertUnmatched(u) {
      await db
        .prepare(
          'INSERT INTO admin_stripe_unmatched(id,customer,email,month,amount,paid_on,note,created) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount,paid_on=excluded.paid_on,note=excluded.note'
        )
        .bind(u.id, u.customer, u.email, u.month, u.amount, u.paid_on || null, u.note, u.created)
        .run();
    },
    async listUnmatched() {
      return (
        await db
          .prepare(
            'SELECT id,customer,email,month,amount,paid_on,note,created FROM admin_stripe_unmatched ORDER BY created DESC'
          )
          .all()
      ).results;
    },
    // 1 件を利用者に割り当てる（顧客 ID があれば対応も覚え、その顧客の他の未割り当ても移す）
    async assignUnmatched(id, account) {
      const row = await db.prepare('SELECT * FROM admin_stripe_unmatched WHERE id=?').bind(id).first();
      if (!row) return false;
      if (row.customer) {
        await this.linkStripeCustomer(row.customer, account);
        return true;
      }
      await db.batch([
        db
          .prepare(
            "INSERT INTO admin_payments(id,account,month,amount,method,paid_on,note,created) VALUES(?,?,?,?,'Stripe',?,?,?) ON CONFLICT(id) DO UPDATE SET account=excluded.account,amount=excluded.amount"
          )
          .bind(row.id, account, row.month, row.amount, row.paid_on, row.note, row.created),
        db.prepare('DELETE FROM admin_stripe_unmatched WHERE id=?').bind(id)
      ]);
      return true;
    },
    async deleteUnmatched(id) {
      await db.prepare('DELETE FROM admin_stripe_unmatched WHERE id=?').bind(id).run();
    },
    // 定期支払い：古い通知では上書きしない。期間の終わりが通知になければ前の値を残す
    async upsertSubscription(x) {
      await db
        .prepare(
          'INSERT INTO admin_subscriptions(subscription,customer,status,period_end,cancel_at_period_end,event_at,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(subscription) DO UPDATE SET customer=excluded.customer,status=excluded.status,period_end=COALESCE(excluded.period_end,admin_subscriptions.period_end),cancel_at_period_end=excluded.cancel_at_period_end,event_at=excluded.event_at,updated=excluded.updated WHERE excluded.event_at>=admin_subscriptions.event_at'
        )
        .bind(
          x.subscription,
          x.customer,
          x.status,
          x.periodEnd,
          x.cancelAtPeriodEnd ? 1 : 0,
          x.eventAt,
          new Date().toISOString()
        )
        .run();
    },
    async planOf(account) {
      return (await db.prepare('SELECT plan FROM admin_users WHERE account=?').bind(account).first())?.plan || null;
    },
    async adminStatusOf(account) {
      return (await db.prepare('SELECT status FROM admin_users WHERE account=?').bind(account).first())?.status || null;
    },
    async subscriptionsOf(account) {
      return (
        await db
          .prepare(
            'SELECT s.subscription,s.customer,s.status,s.period_end,s.cancel_at_period_end,s.event_at FROM admin_subscriptions s JOIN admin_stripe_customers c ON c.customer=s.customer WHERE c.account=?'
          )
          .bind(account)
          .all()
      ).results;
    },
    async listSubscriptions() {
      return (
        await db
          .prepare(
            'SELECT s.subscription,s.customer,s.status,s.period_end,s.cancel_at_period_end,s.event_at,c.account FROM admin_subscriptions s LEFT JOIN admin_stripe_customers c ON c.customer=s.customer'
          )
          .all()
      ).results;
    },
    // SaBoRo の AI：使用量（月の「課題生成」の回数・実費・請求額）と Batch の依頼
    async aiMonthStats(account, month) {
      const r = await db
        .prepare(
          "SELECT COALESCE(SUM(CASE WHEN label='課題生成' AND ok=1 THEN 1 ELSE 0 END),0) AS count,COALESCE(SUM(cost_usd),0) AS cost,COALESCE(SUM(CASE WHEN billable=0 THEN cost_usd ELSE 0 END),0) AS free_cost,COALESCE(SUM(CASE WHEN mode='advanced' THEN 1 ELSE 0 END),0) AS advanced,COALESCE(SUM(charge_micro),0) AS charge FROM ai_usage WHERE account=? AND month=?"
        )
        .bind(account, month)
        .first();
      return {
        count: Number(r?.count) || 0,
        costUsd: Number(r?.cost) || 0,
        freeCostUsd: Number(r?.free_cost) || 0,
        advanced: Number(r?.advanced) || 0,
        chargeMicro: Number(r?.charge) || 0
      };
    },
    // 作っている最中の依頼の予約。同時に作る数と 1 日の回数の上限を、確かめて入れるまでを 1 つの文で行う（同時に送られても上限を超えない）
    // monthLimit（null なら見ない）：月の「課題生成」の回数（記録済み＋作っている最中）がこの数未満のときだけ。advancedLimit（null なら見ない）：月の高度な生成（記録済み＋作っている最中）がこの数未満のときだけ
    async reserveAi({
      id,
      account,
      created,
      since,
      staleBefore,
      dayLimit,
      maxInflight,
      label = '',
      mode = '',
      month = '',
      monthLimit = null,
      advancedLimit = null
    }) {
      const r = await db
        .prepare(
          "INSERT INTO ai_inflight(id,account,created,label,mode,month) SELECT ?1,?2,?3,?8,?9,?10 WHERE (SELECT COUNT(*) FROM ai_inflight WHERE account=?2 AND created>=?5)<?7 AND (SELECT COUNT(*) FROM ai_usage WHERE account=?2 AND created>=?4)+(SELECT COUNT(*) FROM ai_requests WHERE account=?2 AND created>=?4)+(SELECT COUNT(*) FROM ai_inflight WHERE account=?2 AND created>=?5)<?6 AND (?11 IS NULL OR (SELECT COUNT(*) FROM ai_usage WHERE account=?2 AND month=?10 AND label='課題生成' AND ok=1)+(SELECT COUNT(*) FROM ai_inflight WHERE account=?2 AND month=?10 AND label='課題生成' AND created>=?5)<?11) AND (?12 IS NULL OR (SELECT COUNT(*) FROM ai_usage WHERE account=?2 AND month=?10 AND mode='advanced')+(SELECT COUNT(*) FROM ai_inflight WHERE account=?2 AND month=?10 AND mode='advanced' AND created>=?5)<?12)"
        )
        .bind(
          id,
          account,
          created,
          since,
          staleBefore,
          dayLimit,
          maxInflight,
          label,
          mode,
          month,
          monthLimit,
          advancedLimit
        )
        .run();
      return (r.meta?.changes || 0) > 0;
    },
    async releaseAi(id) {
      await db.prepare('DELETE FROM ai_inflight WHERE id=?').bind(id).run();
    },
    async aiMonthAll(month) {
      return (
        await db
          .prepare(
            "SELECT account,SUM(CASE WHEN label='課題生成' AND ok=1 THEN 1 ELSE 0 END) AS count,SUM(cost_usd) AS cost_usd,SUM(charge_micro) AS charge_micro,COUNT(*) AS calls FROM ai_usage WHERE month=? GROUP BY account"
          )
          .bind(month)
          .all()
      ).results;
    },
    async aiDayCalls(account, since) {
      const r = await db
        .prepare(
          'SELECT (SELECT COUNT(*) FROM ai_usage WHERE account=?1 AND created>=?2)+(SELECT COUNT(*) FROM ai_requests WHERE account=?1 AND created>=?2) AS n'
        )
        .bind(account, since)
        .first();
      return Number(r?.n) || 0;
    },
    async addAiUsage(x) {
      await db
        .prepare(
          'INSERT INTO ai_usage(id,account,month,label,mode,model,input,output,cache_read,cache_write,cost_usd,billable,charge_micro,ok,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        )
        .bind(
          x.id,
          x.account,
          x.month,
          x.label,
          x.mode,
          x.model,
          x.input,
          x.output,
          x.cache_read,
          x.cache_write,
          x.cost_usd,
          x.billable,
          x.charge_micro,
          x.ok ?? 1,
          x.created
        )
        .run();
    },
    async getAiRequest(account, key) {
      return db
        .prepare(
          'SELECT id,account,key,label,batch_id,status,result,reason,created,updated FROM ai_requests WHERE account=? AND key=?'
        )
        .bind(account, key)
        .first();
    },
    async insertAiRequest(x) {
      const r = await db
        .prepare(
          'INSERT INTO ai_requests(id,account,key,label,batch_id,created,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account,key) DO NOTHING'
        )
        .bind(x.id, x.account, x.key, x.label, x.batch_id, x.created, x.updated)
        .run();
      return (r.meta?.changes || 0) > 0;
    },
    async finishAiRequest(id, x) {
      const r = await db
        .prepare("UPDATE ai_requests SET status=?,result=?,reason=?,updated=? WHERE id=? AND status='pending'")
        .bind(x.status, x.result, x.reason, x.updated, id)
        .run();
      return (r.meta?.changes || 0) > 0;
    },
    async deleteAiRequest(id) {
      await db.prepare('DELETE FROM ai_requests WHERE id=?').bind(id).run();
    },
    async listPendingAiRequests() {
      return (
        await db
          .prepare(
            "SELECT id,account,key,label,batch_id,status,created,updated FROM ai_requests WHERE status='pending' ORDER BY created LIMIT 200"
          )
          .all()
      ).results;
    },
    async cleanupAiRequests(doneBefore, pendingBefore) {
      await db
        .prepare("DELETE FROM ai_requests WHERE (status!='pending' AND updated<?) OR (status='pending' AND created<?)")
        .bind(doneBefore, pendingBefore)
        .run();
      await db.prepare('DELETE FROM ai_inflight WHERE created<?').bind(doneBefore).run();
    },
    // 未請求の分の集計。ids は集計した行（請求済みにするのはその行だけ）
    async unbilledAiCharges(cutoff) {
      return (
        await db
          .prepare(
            'SELECT account,SUM(charge_micro) AS charge_micro,GROUP_CONCAT(id) AS ids FROM ai_usage WHERE billable=1 AND billed IS NULL AND created<=? GROUP BY account'
          )
          .bind(cutoff)
          .all()
      ).results.map(r => ({
        account: r.account,
        charge_micro: Number(r.charge_micro) || 0,
        ids: String(r.ids || '')
          .split(',')
          .filter(Boolean)
      }));
    },
    async markAiBilled(account, ids, day) {
      for (let i = 0; i < ids.length; i += 50) {
        const part = ids.slice(i, i + 50);
        await db
          .prepare(
            `UPDATE ai_usage SET billed=? WHERE account=? AND billed IS NULL AND id IN (${part.map(() => '?').join(',')})`
          )
          .bind(day, account, ...part)
          .run();
      }
    },
    // 利用者の登録の数（登録の上限のため）
    async countAccountsSince(since) {
      const r = await db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE created>=?').bind(since).first();
      return Number(r?.n) || 0;
    }
  };
}
// 記憶上の保存先（テスト用）
export function memoryStore() {
  const states = new Map(),
    jobs = [],
    accounts = [],
    admin = new Map(),
    payments = [],
    costs = [],
    settings = {},
    customers = new Map(),
    unmatched = new Map(),
    subs = new Map(),
    aiUsage = [],
    aiRequests = new Map(),
    aiInflight = new Map();
  const upsert = p => {
    const i = payments.findIndex(x => x.id === p.id);
    if (i < 0) payments.push({...p});
    else
      Object.assign(payments[i], {
        account: p.account,
        month: p.month,
        amount: p.amount,
        paid_on: p.paid_on,
        note: p.note
      });
  };
  return {
    async getState(a) {
      return states.get(a) ?? null;
    },
    async putState(a, v) {
      states.set(a, v);
    },
    async insertJob(j) {
      jobs.push({...j, status: 'pending', result: null});
    },
    async listJobs(a) {
      return jobs
        .filter(j => j.account === a)
        .sort((x, y) => y.created.localeCompare(x.created))
        .slice(0, 50)
        .map(({account, payload, ...j}) => j);
    },
    async claimJob(a, now, exclude = []) {
      const j = jobs
        .filter(j => j.account === a && j.status === 'pending' && !exclude.includes(j.kind))
        .sort((x, y) => x.created.localeCompare(y.created))[0];
      if (!j) return null;
      j.status = 'running';
      j.updated = now;
      return {...j};
    },
    async finishJob(a, id, status, result, now) {
      const j = jobs.find(j => j.id === id && j.account === a && j.status === 'running');
      if (j) {
        j.status = status;
        j.result = result;
        j.updated = now;
        if (j.kind === 'credentials') j.payload = '{}';
      }
    },
    async findAccount(h) {
      const a = accounts.find(a => a.ownerHash === h || a.deviceHash === h);
      return a ? {id: a.id, role: a.ownerHash === h ? 'owner' : 'device'} : null;
    },
    async createAccount(a) {
      if (accounts.some(x => x.ownerHash === a.ownerHash || x.deviceHash === a.deviceHash)) throw Error('duplicate');
      accounts.push(a);
    },
    async countAccountsSince(since) {
      return accounts.filter(a => a.created >= since).length;
    },
    async adminUsers() {
      const row = (account, created) => {
        let v = null;
        try {
          v = JSON.parse(states.get(account) || 'null');
        } catch {}
        const m = admin.get(account) || {};
        return {
          account,
          created,
          seen: v?.deviceSeen ?? null,
          os: v?.os ?? null,
          version: v?.version ?? null,
          runtime: v?.runtime ?? null,
          last_sync: v?.lastSync ?? null,
          creds: v?.credentialsConfigured ? 1 : 0,
          tasks: Array.isArray(v?.tasks) ? v.tasks.length : null,
          courses: Array.isArray(v?.courses) ? v.courses.length : null,
          last_error: v?.lastError ?? null,
          last_error_at: v?.lastErrorAt ?? null,
          usage: v?.usage ? JSON.stringify(v.usage) : null,
          ...m
        };
      };
      return [...accounts.map(a => row(a.id, a.created)), ...(states.has('legacy') ? [row('legacy', null)] : [])];
    },
    async hasAccount(id) {
      return id === 'legacy' ? states.has('legacy') : accounts.some(a => a.id === id);
    },
    async putAdminUser(r) {
      const {account, ...rest} = r;
      admin.set(account, rest);
    },
    async listPayments(from, to) {
      return payments
        .filter(p => p.month >= from && p.month <= to)
        .sort((a, b) => b.month.localeCompare(a.month) || b.created.localeCompare(a.created))
        .map(p => ({...p}));
    },
    async addPayment(p) {
      payments.push({...p});
    },
    async deletePayment(id) {
      const i = payments.findIndex(p => p.id === id);
      if (i >= 0) payments.splice(i, 1);
    },
    async listCosts() {
      return costs.map(c => ({end_month: null, ...c}));
    },
    async addCost(c) {
      costs.push({...c});
    },
    async endCost(id, month) {
      const c = costs.find(c => c.id === id && c.recurring);
      if (c) c.end_month = month;
    },
    async deleteCost(id) {
      const i = costs.findIndex(c => c.id === id);
      if (i >= 0) costs.splice(i, 1);
    },
    async getAdminSettings() {
      return {...settings};
    },
    async putAdminSettings(v) {
      Object.assign(settings, v);
    },
    async upsertPayment(p) {
      upsert(p);
    },
    async paymentAccountOf(id) {
      return payments.find(p => p.id === id)?.account || null;
    },
    async stripeAccountFor(c) {
      return customers.get(c)?.account || null;
    },
    async listStripeCustomers() {
      return [...customers].map(([customer, v]) => ({customer, ...v}));
    },
    async linkStripeCustomer(customer, account) {
      customers.set(customer, {account, created: customers.get(customer)?.created || new Date().toISOString()});
      for (const [id, u] of [...unmatched])
        if (u.customer === customer) {
          upsert({
            id,
            account,
            month: u.month,
            amount: u.amount,
            method: 'Stripe',
            paid_on: u.paid_on,
            note: u.note,
            created: u.created
          });
          unmatched.delete(id);
        }
    },
    async unlinkStripeCustomer(c) {
      customers.delete(c);
    },
    async upsertUnmatched(u) {
      unmatched.set(u.id, {...(unmatched.get(u.id) || {}), ...u});
    },
    async listUnmatched() {
      return [...unmatched.values()].sort((a, b) => b.created.localeCompare(a.created)).map(u => ({...u}));
    },
    async assignUnmatched(id, account) {
      const u = unmatched.get(id);
      if (!u) return false;
      if (u.customer) {
        await this.linkStripeCustomer(u.customer, account);
        return true;
      }
      upsert({
        id,
        account,
        month: u.month,
        amount: u.amount,
        method: 'Stripe',
        paid_on: u.paid_on,
        note: u.note,
        created: u.created
      });
      unmatched.delete(id);
      return true;
    },
    async deleteUnmatched(id) {
      unmatched.delete(id);
    },
    async upsertSubscription(x) {
      const old = subs.get(x.subscription);
      if (old && x.eventAt < old.event_at) return;
      subs.set(x.subscription, {
        subscription: x.subscription,
        customer: x.customer,
        status: x.status,
        period_end: x.periodEnd ?? old?.period_end ?? null,
        cancel_at_period_end: x.cancelAtPeriodEnd ? 1 : 0,
        event_at: x.eventAt
      });
    },
    async planOf(a) {
      return admin.get(a)?.plan || null;
    },
    async adminStatusOf(a) {
      return admin.get(a)?.status || null;
    },
    async subscriptionsOf(a) {
      return [...subs.values()].filter(s => customers.get(s.customer)?.account === a).map(s => ({...s}));
    },
    async listSubscriptions() {
      return [...subs.values()].map(s => ({...s, account: customers.get(s.customer)?.account || null}));
    },
    async aiMonthStats(a, m) {
      const rows = aiUsage.filter(x => x.account === a && x.month === m);
      return {
        count: rows.filter(x => x.label === '課題生成' && x.ok !== 0).length,
        costUsd: rows.reduce((t, x) => t + x.cost_usd, 0),
        freeCostUsd: rows.filter(x => !x.billable).reduce((t, x) => t + x.cost_usd, 0),
        advanced: rows.filter(x => x.mode === 'advanced').length,
        chargeMicro: rows.reduce((t, x) => t + x.charge_micro, 0)
      };
    },
    async reserveAi({
      id,
      account,
      created,
      since,
      staleBefore,
      dayLimit,
      maxInflight,
      label = '',
      mode = '',
      month = '',
      monthLimit = null,
      advancedLimit = null
    }) {
      const live = [...aiInflight.values()].filter(x => x.account === account && x.created >= staleBefore);
      if (live.length >= maxInflight || live.length + (await this.aiDayCalls(account, since)) >= dayLimit) return false;
      const used = aiUsage.filter(x => x.account === account && x.month === month);
      if (
        monthLimit != null &&
        used.filter(x => x.label === '課題生成' && x.ok !== 0).length +
          live.filter(x => x.month === month && x.label === '課題生成').length >=
          monthLimit
      )
        return false;
      if (
        advancedLimit != null &&
        used.filter(x => x.mode === 'advanced').length +
          live.filter(x => x.month === month && x.mode === 'advanced').length >=
          advancedLimit
      )
        return false;
      aiInflight.set(id, {account, created, label, mode, month});
      return true;
    },
    async releaseAi(id) {
      aiInflight.delete(id);
    },
    async aiMonthAll(m) {
      const g = new Map();
      for (const x of aiUsage.filter(x => x.month === m)) {
        const r = g.get(x.account) || {account: x.account, count: 0, cost_usd: 0, charge_micro: 0, calls: 0};
        r.count += x.label === '課題生成' && x.ok !== 0 ? 1 : 0;
        r.cost_usd += x.cost_usd;
        r.charge_micro += x.charge_micro;
        r.calls++;
        g.set(x.account, r);
      }
      return [...g.values()];
    },
    async aiDayCalls(a, since) {
      return (
        aiUsage.filter(x => x.account === a && x.created >= since).length +
        [...aiRequests.values()].filter(x => x.account === a && x.created >= since).length
      );
    },
    async addAiUsage(x) {
      aiUsage.push({billed: null, ...x});
    },
    async getAiRequest(a, k) {
      const r = [...aiRequests.values()].find(x => x.account === a && x.key === k);
      return r ? {...r} : null;
    },
    async insertAiRequest(x) {
      if ([...aiRequests.values()].some(r => r.account === x.account && r.key === x.key)) return false;
      aiRequests.set(x.id, {status: 'pending', result: null, reason: null, ...x});
      return true;
    },
    async finishAiRequest(id, x) {
      const r = aiRequests.get(id);
      if (!r || r.status !== 'pending') return false;
      Object.assign(r, x);
      return true;
    },
    async deleteAiRequest(id) {
      aiRequests.delete(id);
    },
    async listPendingAiRequests() {
      return [...aiRequests.values()].filter(r => r.status === 'pending').map(r => ({...r}));
    },
    async cleanupAiRequests(doneBefore, pendingBefore) {
      for (const [id, r] of [...aiRequests])
        if (r.status !== 'pending' ? r.updated < doneBefore : r.created < pendingBefore) aiRequests.delete(id);
      for (const [id, r] of [...aiInflight]) if (r.created < doneBefore) aiInflight.delete(id);
    },
    async unbilledAiCharges(cutoff) {
      const g = new Map();
      for (const x of aiUsage)
        if (x.billable && !x.billed && x.created <= cutoff) {
          const r = g.get(x.account) || {account: x.account, charge_micro: 0, ids: []};
          r.charge_micro += x.charge_micro;
          r.ids.push(x.id);
          g.set(x.account, r);
        }
      return [...g.values()];
    },
    async markAiBilled(a, ids, day) {
      for (const x of aiUsage) if (x.account === a && !x.billed && ids.includes(x.id)) x.billed = day;
    },
    aiUsage,
    aiRequests
  };
}
// 支払いの状態（管理者画面の「支払いを必須にする」と Stripe の定期支払いから判定）
async function billingFor(store, account) {
  const [settings, plan, subs] = await Promise.all([
    store.getAdminSettings(),
    store.planOf(account),
    store.subscriptionsOf(account)
  ]);
  return billingOf({account, settings, plan, subs});
}
// 認証：登録済みの接続キー（owner）または Mac の鍵（device）。環境変数の旧トークンは最初の利用者（legacy）として扱う
async function authenticate(key, env, store) {
  if (!key) return null;
  if (await equal(key, env.OWNER_TOKEN)) return {id: 'legacy', role: 'owner'};
  if (await equal(key, env.DEVICE_TOKEN)) return {id: 'legacy', role: 'device'};
  if (!TOKEN.test(key)) return null;
  return store.findAccount(await sha256(key));
}
export async function handle(req, env, store, ctx) {
  const u = new URL(req.url),
    origin = req.headers.get('Origin') || '';
  if (!u.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
  if (origin && !origins.includes(origin)) return json({error: 'origin_denied'}, 403, origin);
  if (req.method === 'OPTIONS') return json({}, 200, origin);
  try {
    // 学年暦（認証なし。PC と画面が新しい学期の授業日を受け取る）。管理者画面で保存したもの、なければ同梱のもの
    if (u.pathname === '/api/academic-calendar' && req.method === 'GET') {
      const {calendar} = await currentCalendar(env, store, u);
      return calendar ? json(calendar, 200, origin) : json({error: 'not_found'}, 404, origin);
    }
    // 管理者画面の API（ADMIN_TOKEN で認証。利用者の鍵とは別）
    if (u.pathname.startsWith('/api/admin/')) return await handleAdmin(req, u, env, store, {json, equal, origin});
    // Stripe の通知（署名で確認。利用者の鍵は使わない）
    if (u.pathname === '/api/stripe/webhook') return await handleStripe(req, env, store, {json, origin});
    // 利用者の登録：Mac のセットアップが作った接続キーと Mac の鍵（どちらも 64 桁の16進）のハッシュだけを保存する
    // 登録は認証なしなので、1 時間あたりの数に上限を設ける（登録だけで状態の保存先（1 件 2 MB まで）を占められないように）
    if (u.pathname === '/api/register' && req.method === 'POST') {
      const d = await req.json().catch(() => ({}));
      if (!TOKEN.test(d.owner || '') || !TOKEN.test(d.device || '') || d.owner === d.device)
        return json({error: 'invalid_token'}, 400, origin);
      if ((await store.countAccountsSince(new Date(Date.now() - 3600e3).toISOString())) >= REGISTER_PER_HOUR)
        return json({error: 'too_many'}, 429, origin);
      const id = crypto.randomUUID();
      try {
        await store.createAccount({
          id,
          ownerHash: await sha256(d.owner),
          deviceHash: await sha256(d.device),
          created: new Date().toISOString()
        });
      } catch {
        return json({error: 'already_registered'}, 409, origin);
      }
      return json({id}, 201, origin);
    }
    const key = req.headers.get('Authorization')?.replace(/^Bearer /, '');
    const who = await authenticate(key, env, store);
    if (!who) return json({error: 'unauthorized'}, 401, origin);
    const agent = who.role === 'device',
      owner = who.role === 'owner',
      account = who.id;
    if (u.pathname === '/api/state' && req.method === 'GET') {
      const [value, billing, ai] = await Promise.all([
        store.getState(account),
        billingFor(store, account),
        aiStatus(store, env, account)
      ]);
      return json(
        {
          ...(value ? JSON.parse(value) : {tasks: [], materials: [], connection: 'not_configured'}),
          deployed: env.DEPLOYED_SHA || '',
          latestVersion: env.APP_VERSION || '',
          billing,
          ai
        },
        200,
        origin
      );
    }
    // SaBoRo の AI（Mac の鍵で。回答の作成をこちらの API キーで行う）
    if (u.pathname.startsWith('/api/agent/ai') && agent)
      return await handleAi(req, u, env, store, account, {json, origin, ctx});
    if (u.pathname === '/api/state' && req.method === 'POST' && agent) {
      const value = await req.text();
      if (value.length > 2000000) return json({error: 'too_large'}, 413, origin);
      try {
        JSON.parse(value);
      } catch {
        return json({error: 'invalid'}, 400, origin);
      }
      await store.putState(account, value);
      return json({ok: true}, 200, origin);
    }
    if (u.pathname === '/api/jobs' && req.method === 'POST' && owner) {
      const data = await req.json();
      if (!KINDS.includes(data.kind) || JSON.stringify(data).length > 100000)
        return json({error: 'invalid_job'}, 400, origin);
      if (PAID_KINDS.includes(data.kind) && !(await billingFor(store, account)).allowed)
        return json({error: 'payment_required'}, 402, origin);
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      await store.insertJob({
        id,
        account,
        kind: data.kind,
        task: data.task || null,
        payload: JSON.stringify(data.payload || {}),
        created: now,
        updated: now
      });
      return json({id, status: 'pending'}, 202, origin);
    }
    if (u.pathname === '/api/jobs' && req.method === 'GET') return json(await store.listJobs(account), 200, origin);
    if (u.pathname === '/api/agent/claim' && req.method === 'POST' && agent) {
      const billing = await billingFor(store, account);
      const row = await store.claimJob(account, new Date().toISOString(), billing.allowed ? [] : PAID_KINDS);
      const res = json(
        row
          ? {
              id: row.id,
              kind: row.kind,
              task: row.task,
              status: row.status,
              created: row.created,
              updated: row.updated,
              payload: JSON.parse(row.payload)
            }
          : null,
        200,
        origin
      );
      if (env.DEPLOYED_SHA) res.headers.set('X-Coursecue-Deployed', env.DEPLOYED_SHA);
      if (env.DEPLOYED_SIG) res.headers.set('X-Coursecue-Deployed-Sig', env.DEPLOYED_SIG);
      res.headers.set('X-Coursecue-Billing', billing.allowed ? 'ok' : 'required');
      return res;
    }
    if (u.pathname === '/api/agent/finish' && req.method === 'POST' && agent) {
      const d = await req.json();
      if (!['done', 'failed', 'waiting'].includes(d.status)) return json({error: 'invalid'}, 400, origin);
      await store.finishJob(
        account,
        String(d.id || ''),
        d.status,
        JSON.stringify(d.result || {}),
        new Date().toISOString()
      );
      return json({ok: true}, 200, origin);
    }
    return json({error: 'not_found'}, 404, origin);
  } catch (e) {
    // 原因を Workers のログに残す（鍵・本文は出さない。wrangler.jsonc の observability で保存される）
    console.error('saboro: request_failed', req.method, u.pathname, String(e?.message || e).slice(0, 300));
    return json({error: 'request_failed'}, 500, origin);
  }
}
// 運営者への通知（毎日の定期実行）：多くの利用者で同期が失敗している・止まっている、または定期処理で失敗があれば、ALERT_WEBHOOK_URL（Slack・Discord などの Webhook）に送る。未設定なら Workers のログに残すだけ
export async function alertOperator(
  env,
  store,
  log = [],
  now = new Date(),
  url = 'https://coursecue.hrk-6888.workers.dev/'
) {
  const h = health(await store.adminUsers().then(rows => rows.map(userRow)), now),
    {calendar} = await currentCalendar(env, store, url).catch(() => ({calendar: null})),
    lines = [
      ...(h.alert ? [h.message] : []),
      ...(calendar && needsUpdate(calendar, now)
        ? [
            `学年暦（${calendar.term}、${calendarEnd(calendar)} まで）の更新が必要です。管理者画面の「学年暦」で新しい学年暦の PDF の URL を入れてください`
          ]
        : []),
      ...log.slice(0, 10).map(x => '定期処理：' + x)
    ];
  if (!lines.length) return null;
  const text = 'saboro の運営通知\n' + lines.join('\n');
  console.error(text);
  // Discord は content（2000 文字まで）、Slack などは text で受け取る
  if (env.ALERT_WEBHOOK_URL) {
    const discord = /^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(env.ALERT_WEBHOOK_URL),
      r = await fetch(env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(discord ? {content: text.slice(0, 1900)} : {text})
      });
    if (!r.ok) console.error('saboro: 通知の送信に失敗', r.status);
  }
  return text;
}
export default {
  async fetch(req, env, ctx) {
    return handle(req, env, d1Store(env.DB), ctx);
  },
  // 毎日の定期実行（wrangler.jsonc の triggers）：SaBoRo の AI の Batch の受け取りと、無料分を超えた分の請求
  async scheduled(event, env, ctx) {
    const store = d1Store(env.DB);
    ctx.waitUntil(
      runAiDaily(env, store)
        .catch(e => [`定期処理が止まりました：${e.message}`])
        .then(async log => {
          if (log.length) console.error('saboro: AI の定期処理', log.join(' / '));
          await alertOperator(env, store, log).catch(e => console.error('saboro: 通知できません', e.message));
        })
    );
  }
};
