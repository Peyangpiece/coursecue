// saboro 管理者画面：利用者の一覧、売上・費用・利益、AI の使用状況。データは /api/admin/*（Worker の秘密 ADMIN_TOKEN で認証）
// 秘密はこのタブの間だけ保存する（sessionStorage。タブを閉じると消える）
'use strict';
const KEY = 'saboro-admin-token',
  app = document.getElementById('app');
// プランは分けない（AI は誰でも同じ）。「無料」は月額を払わない人（支払いを必須にしても止めない）。旧データの api・byo はどちらも「有料」
const PLAN = {byo: '有料', free: '無料'},
  planName = p => (p === 'free' ? '無料' : '有料'),
  STATUS = {active: '利用中', trial: 'お試し', stopped: '停止'};
let token = null,
  data = null,
  month = null,
  editing = null,
  paying = null,
  view = 'main',
  cal = null,
  calPreview = null,
  calBusy = false;
try {
  token = sessionStorage.getItem(KEY);
} catch {}
const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const yen = v => (v == null ? '—' : `${(Math.round(v) || 0).toLocaleString('ja-JP')}円`),
  num = v => Math.round(v || 0).toLocaleString('ja-JP');
const panel = (title, body, tools = '') =>
  `<section class="panel"><h2 class="panel-heading"><span class="mark" aria-hidden="true"></span>${title}${tools ? `<span class="tools">${tools}</span>` : ''}</h2><div class="panel-body">${body}</div></section>`;
const short = id => (id === 'legacy' ? '最初の利用者' : String(id).slice(0, 8));
const nameOf = u => (u ? esc(u.label || short(u.account)) : '（削除済み）');
// 最終接続などの日時：何分前・何時間前・何日前
function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (!(s >= 0)) return esc(iso.slice(0, 10));
  if (s < 120) return '今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}
function toast(s) {
  const e = document.getElementById('toast');
  e.textContent = s;
  e.style.display = 'block';
  e.onclick = () => {
    e.style.display = 'none';
  };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => {
    e.style.display = 'none';
  }, 3000);
}
async function api(path, body) {
  const r = await fetch('/api/admin' + path, {
    method: body ? 'POST' : 'GET',
    headers: {Authorization: 'Bearer ' + token, ...(body ? {'Content-Type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 401) {
    logout('管理者の秘密が違います。');
    throw Error('unauthorized');
  }
  if (r.status === 503) {
    app.innerHTML = notConfigured();
    throw Error('not_configured');
  }
  if (!r.ok) {
    let m = '';
    try {
      const j = await r.json();
      m = j.message || (j.errors || []).join('／');
    } catch {}
    throw Error(m || (r.status === 400 ? '入力を確認してください' : `エラー（${r.status}）`));
  }
  return r.json();
}
function notConfigured() {
  return panel(
    '管理者画面の準備',
    `<p>サーバーに管理者の秘密（<code>ADMIN_TOKEN</code>）がまだ設定されていません。32 文字以上のランダムな文字列を用意して、次のどちらかで設定してください。</p><ol><li>GitHub のリポジトリの Settings → Secrets and variables → Actions に <code>ADMIN_TOKEN</code> として追加し、次の公開（main への反映）を待つ</li><li>手元で <code>npx wrangler secret put ADMIN_TOKEN</code> を実行する</li></ol><p class="muted">設定後にこのページを開き直し、同じ文字列でログインします。</p>`
  );
}
function login(error = '') {
  app.innerHTML = panel(
    '管理者ログイン',
    `<form id="login"><div class="form-grid"><div class="wide"><label for="token">管理者の秘密（ADMIN_TOKEN）</label><input class="form-control" type="password" id="token" autocomplete="current-password" required></div></div>${error ? `<p class="err">${esc(error)}</p>` : ''}<div class="actions"><button class="btn btn-primary">ログイン</button><span class="muted">このタブを閉じると、ログインは解除されます。</span></div></form>`
  );
  document.getElementById('token').focus();
}
function logout(message = '') {
  token = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
  login(message);
}
async function load(m = month) {
  try {
    data = await api('/overview' + (m ? `?month=${encodeURIComponent(m)}` : ''));
    month = data.month;
    render();
  } catch (e) {
    if (!['unauthorized', 'not_configured'].includes(e.message))
      app.innerHTML = panel(
        '読み込めません',
        `<p class="err">${esc(e.message)}</p><button class="btn" data-action="reload">再読み込み</button>`
      );
  }
}
// 概要：売上・利益・見込み・未入金
function summary() {
  const s = data.summary,
    set = data.settings;
  const stat = (label, value, sub = '', minus = false) =>
    `<div class="stat${minus ? ' minus' : ''}"><span class="stat-label">${label}</span><span class="stat-num">${value}${sub ? `<small>${sub}</small>` : ''}</span></div>`;
  const stats = `<div class="stats">${stat('売上（入金）', yen(s.revenue), `${s.paying}人`)}${stat('利益', yen(s.profit), '', s.profit < 0)}${stat('1人あたり利益', yen(s.perPaying), '', s.perPaying < 0)}${stat('見込み（月額の合計）', yen(s.expected))}${stat('未入金', `${s.unpaid.length}人`)}</div>`;
  const row = (k, v, note = '') =>
    `<tr><th>${k}</th><td class="num${v < 0 ? ' minus' : ''}">${yen(v)}</td><td class="muted">${note}</td></tr>`;
  const table = `<div class="scroll"><table class="table-default"><tbody>${row('売上（入金の合計）', s.revenue)}${row('決済手数料', -s.fees, `売上の ${(set.feeRate * 100).toFixed(1)}%`)}${row('消費税', -s.tax, set.taxable ? '税込の売上の 10/110' : '引かない（免税事業者の設定）')}${row(s.apiActual ? 'SaBoRo課題サポートの費用（実費）' : 'SaBoRo課題サポートの費用（目安）', -s.apiCost, s.apiActual ? `こちらの API キーで実際に使った分 $${s.apiUsd.toFixed(2)} × ${set.usdJpy}円${s.aiCharge ? `。無料分を超えた分の請求 ${yen(s.aiCharge)}（入金されると売上に入ります）` : ''}` : `「saboro の API」プランの人の使用量 $${s.apiUsd.toFixed(2)} × ${set.usdJpy}円。通常料金での目安（Batch なら約半分）`)}${row('固定費', -s.fixed, 'この月に含まれる費用の合計')}${row('<strong>利益</strong>', s.profit, s.paying ? `入金のあった ${s.paying}人で割ると ${yen(s.perPaying)}` : '')}</tbody></table></div>`;
  const unpaid = s.unpaid.length
    ? `<p class="muted" style="margin-top:8px">未入金（利用中・月額あり）：${s.unpaid.map(id => nameOf(data.users.find(u => u.account === id))).join('、')}</p>`
    : '';
  return panel(`${esc(month)} の売上と利益`, stats + table + unpaid);
}
function trend() {
  const rows = data.trend
    .map(
      t =>
        `<tr${t.month === month ? ' style="font-weight:700"' : ''}><td>${esc(t.month)}</td><td class="num">${yen(t.revenue)}</td><td class="num">${yen(t.fees + t.tax)}</td><td class="num">${yen(t.apiCost)}</td><td class="num">${yen(t.fixed)}</td><td class="num${t.profit < 0 ? ' minus' : ''}">${yen(t.profit)}</td><td class="num">${t.paying}人</td></tr>`
    )
    .join('');
  return panel(
    '推移（6 か月）',
    `<div class="scroll"><table class="table-default wide"><thead><tr><th>月</th><th class="num">売上</th><th class="num">手数料・税</th><th class="num">SaBoRo課題サポートの費用</th><th class="num">固定費</th><th class="num">利益</th><th class="num">入金</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted" style="margin-top:6px">SaBoRo課題サポートの費用は、利用者の端末が残す使用量（直近 3 か月分）から計算するため、それより前の月は 0 円になります。</p>`
  );
}
// 利用者の一覧と、編集・入金の記録
// 契約の状態（支払いを必須にしているかどうかで出し方を変える）
function billingTag(u) {
  const b = u.billing || {},
    req = data.settings.requirePayment;
  if (req && u.plan === 'free' && !b.active) return '<span class="tag">無料・対象外</span>';
  if (b.active)
    return b.cancelAtPeriodEnd
      ? `<span class="tag unpaid">解約予定${b.periodEnd ? ' ' + esc(b.periodEnd.slice(0, 10)) : ''}</span>`
      : b.status === 'past_due'
        ? '<span class="tag unpaid">支払い再試行中</span>'
        : '<span class="tag active">定期支払い 有効</span>';
  if (req) return `<span class="tag unpaid">未払い・停止中</span>`;
  return b.status ? `<span class="tag stopped">定期支払い ${esc(b.status)}</span>` : '';
}
function users() {
  const paid = new Set(data.payments.map(p => p.account)),
    unpaid = new Set(data.summary.unpaid);
  const rows = data.users
    .map(u => {
      const m = u.usageMonth,
        est = m?.estimateUsd ? m.estimateUsd * data.settings.usdJpy : 0;
      return `<tr><td><strong>${nameOf(u)}</strong><br><span class="muted"><code>${esc(short(u.account))}</code>${u.created ? ` ・登録 ${esc(u.created.slice(0, 10))}` : ''}</span>${u.note ? `<br><span class="muted">${esc(u.note)}</span>` : ''}</td>
  <td>${u.registered ? `<span class="tag ${esc(u.status)}">${STATUS[u.status]}</span><br><span class="muted">${planName(u.plan)}</span>` : '<span class="tag unpaid">未登録</span><br><span class="muted">「編集」で保存すると登録</span>'}${billingTag(u) ? '<br>' + billingTag(u) : ''}</td><td class="num">${u.price ? yen(u.price) : '—'}<br>${paid.has(u.account) ? '<span class="tag active">入金済み</span>' : unpaid.has(u.account) ? '<span class="tag unpaid">未入金</span>' : ''}</td>
  <td>${ago(u.seen)}<br><span class="muted">${esc({darwin: 'Mac', win32: 'Windows'}[u.os] || u.os || '—')}${u.version ? ` ・${esc(String(u.version).slice(0, 10))}` : ''}</span></td><td>同期 ${ago(u.lastSync)}<br><span class="muted">授業 ${u.courses}・課題 ${u.tasks}${u.creds ? '' : '・<span class="err">manabo 未設定</span>'}</span>${u.lastError ? `<br><span class="err" title="${esc(u.lastError)}">エラーあり</span>` : ''}</td>
  <td class="num">${m ? `${num(m.calls)}回${m.failed ? `<br><span class="muted">失敗 ${num(m.failed)}</span>` : ''}` : '—'}<br><span class="muted">${m ? `目安 ${yen(est)}` : ''}</span>${u.ai ? `<br><span class="muted">SaBoRo ${num(u.ai.count)}/${num(data.terms?.included ?? 60)}回・実費 ${yen(u.ai.costUsd * data.settings.usdJpy)}${u.ai.chargeYen ? `・超過 ${yen(u.ai.chargeYen)}` : ''}</span>` : ''}</td>
  <td><button class="btn btn-sm" data-action="edit" data-account="${esc(u.account)}">編集</button> <button class="btn btn-sm" data-action="pay" data-account="${esc(u.account)}">入金を記録</button></td></tr>`;
    })
    .join('');
  const unregistered = data.users.filter(u => !u.registered).length;
  return panel(
    `利用者（${data.users.length}人）`,
    `${unregistered ? `<p class="muted" style="margin-bottom:8px">未登録の利用者が ${unregistered}人います。未登録で定期支払いもない人は、SaBoRo課題サポートを使えません。使ってよい人は「編集」で状態を選んで保存してください。</p>` : ''}` +
      `${editForm()}${payForm()}${data.users.length ? `<div class="scroll"><table class="table-default wide"><thead><tr><th>利用者</th><th>状態・プラン</th><th class="num">月額</th><th>最終接続・端末</th><th>同期・件数</th><th class="num">今月のSaBoRo課題サポート</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">まだ登録した利用者はいません。デスクトップアプリで接続すると、ここに出ます。</p>'}<p class="muted" style="margin-top:6px">授業名・課題・資料の中身は、この画面には出しません（件数だけ）。</p>`
  );
}
function editForm() {
  const u = data.users.find(x => x.account === editing);
  if (!u) return '';
  const opt = (map, v) =>
    Object.entries(map)
      .map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`)
      .join('');
  return `<form class="editbox" id="edit-form"><strong>${nameOf(u)} を編集</strong><div class="form-grid"><div><label for="e-label">呼び名</label><input class="form-control" id="e-label" maxlength="40" value="${esc(u.label)}"></div><div><label for="e-status">状態</label><select class="form-control" id="e-status">${opt(STATUS, u.status)}</select></div><div><label for="e-plan">料金</label><select class="form-control" id="e-plan">${opt(PLAN, u.plan === 'free' ? 'free' : 'byo')}</select></div><div><label for="e-price">月額（税込・円）</label><input class="form-control" id="e-price" type="number" min="0" step="1" value="${u.price}"></div><div><label for="e-started">利用開始日</label><input class="form-control" id="e-started" type="date" value="${esc(u.started)}"></div><div class="wide"><label for="e-note">メモ</label><input class="form-control" id="e-note" maxlength="500" value="${esc(u.note)}"></div></div><div class="actions" style="margin-top:0"><button class="btn btn-primary">保存</button><button class="btn" type="button" data-action="cancel">やめる</button></div>
 <div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--panel-line)"><strong style="font-size:13px">Stripe</strong>
 ${payLink(u) ? `<div class="form-grid"><div class="wide"><label for="e-link">この利用者の支払いリンク（支払うと自動でこの利用者に記録されます）</label><div style="display:flex;gap:6px"><input class="form-control" id="e-link" readonly value="${esc(payLink(u))}"><button class="btn btn-sm" type="button" data-action="copylink">コピー</button></div></div></div>` : ''}
 <p class="muted" style="margin:6px 0">顧客 ID：${u.stripeCustomers.length ? u.stripeCustomers.map(c => `<code>${esc(c)}</code> <button class="btn btn-sm" type="button" data-action="unlink" data-customer="${esc(c)}">解除</button>`).join(' ') : 'まだありません（初回の支払いで自動で覚えます）'}</p>
 <div class="form-grid"><div><label for="e-customer">顧客 ID を手で追加（cus_…）</label><input class="form-control" id="e-customer" maxlength="110" placeholder="cus_..."></div><div><button class="btn btn-sm" type="button" data-action="link">追加</button></div></div></div></form>`;
}
function payForm() {
  const u = data.users.find(x => x.account === paying);
  if (!u) return '';
  const today = new Date().toISOString().slice(0, 10);
  return `<form class="editbox" id="pay-form"><strong>${nameOf(u)} の入金を記録</strong><div class="form-grid"><div><label for="p-month">対象の月</label><input class="form-control" id="p-month" type="month" value="${esc(month)}" required></div><div><label for="p-amount">金額（税込・円。返金はマイナス）</label><input class="form-control" id="p-amount" type="number" step="1" value="${u.price || ''}" required></div><div><label for="p-paid">入金日</label><input class="form-control" id="p-paid" type="date" value="${today}"></div><div><label for="p-method">方法</label><input class="form-control" id="p-method" maxlength="20" placeholder="振込・PayPay など"></div><div class="wide"><label for="p-note">メモ</label><input class="form-control" id="p-note" maxlength="200"></div></div><div class="actions" style="margin-top:0"><button class="btn btn-primary">記録</button><button class="btn" type="button" data-action="cancel">やめる</button></div></form>`;
}
function payments() {
  const rows = data.payments
    .map(
      p =>
        `<tr><td>${esc(p.paid_on || p.created.slice(0, 10))}</td><td>${nameOf(data.users.find(u => u.account === p.account))}</td><td class="num${p.amount < 0 ? ' minus' : ''}">${yen(p.amount)}</td><td>${esc(p.method)}</td><td class="muted">${esc(p.note)}</td><td><button class="btn btn-sm" data-action="delpay" data-id="${esc(p.id)}">削除</button></td></tr>`
    )
    .join('');
  return panel(
    `${esc(month)} の入金`,
    data.payments.length
      ? `<div class="scroll"><table class="table-default wide"><thead><tr><th>入金日</th><th>利用者</th><th class="num">金額</th><th>方法</th><th>メモ</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted">この月の入金の記録はありません。利用者の「入金を記録」から追加します。</p>'
  );
}
// 費用：その月だけのもの・毎月のもの
function costs() {
  const rows = data.costs
    .map(
      c =>
        `<tr${c.applies ? '' : ' class="muted"'}><td>${esc(c.item)}${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</td><td class="num">${yen(c.amount)}</td><td>${c.recurring ? `毎月（${esc(c.month)}〜${c.end_month ? esc(c.end_month) : ''}）` : esc(c.month)}</td><td>${c.applies ? '含む' : '—'}</td><td>${c.recurring && !c.end_month ? `<button class="btn btn-sm" data-action="endcost" data-id="${esc(c.id)}">${esc(month)} で終了</button> ` : ''}<button class="btn btn-sm" data-action="delcost" data-id="${esc(c.id)}">削除</button></td></tr>`
    )
    .join('');
  return panel(
    '費用',
    `${data.costs.length ? `<div class="scroll"><table class="table-default wide"><thead><tr><th>項目</th><th class="num">金額</th><th>期間</th><th>${esc(month)}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">登録した費用はありません。</p>'}
 <form id="cost-form" class="editbox" style="margin-top:12px"><strong>費用を追加</strong><div class="form-grid"><div><label for="c-item">項目</label><input class="form-control" id="c-item" maxlength="40" required placeholder="Cloudflare・Apple など"></div><div><label for="c-amount">金額（円・月あたり）</label><input class="form-control" id="c-amount" type="number" min="0" step="1" required></div><div><label for="c-month">月（毎月なら開始月）</label><input class="form-control" id="c-month" type="month" value="${esc(month)}" required></div><div><label class="check" style="font-size:14px;color:inherit"><input type="checkbox" id="c-recurring" checked> 毎月かかる</label></div><div class="wide"><label for="c-note">メモ</label><input class="form-control" id="c-note" maxlength="200" placeholder="年額のものは 12 で割って毎月に（例：Apple 年 99 ドル → 約 1,240 円）"></div></div><div class="actions" style="margin-top:0"><button class="btn btn-primary">追加</button></div></form>
 <p class="muted">「削除」は記録ごと消します（過去の月の利益も変わります）。やめた毎月の費用は「終了」にすると、それまでの月は残ります。</p>`
  );
}
function usage() {
  const u = data.summary.usage,
    s = data.summary.users,
    est = u.estimateUsd * data.settings.usdJpy,
    prov = Object.entries(u.byProvider)
      .map(([k, v]) => `${esc(k)} ${num(v.calls)}回${v.failed ? `（失敗 ${num(v.failed)}）` : ''}`)
      .join('・');
  return panel(
    `${esc(month)} の使用状況`,
    `<div class="scroll"><table class="table-default"><tbody>
 <tr><th>利用者</th><td>${s.total}人（利用中 ${s.active}・お試し ${s.trial}・停止 ${s.stopped}）</td></tr><tr><th>接続中の端末</th><td>24 時間以内 ${s.seen24h}台・7 日以内 ${s.seen7d}台</td></tr>
 <tr><th>SaBoRo課題サポートを使った回数</th><td>${num(u.calls)}回${u.failed ? `（うち失敗 ${num(u.failed)}回）` : ''}${prov ? `<br><span class="muted">${prov}</span>` : ''}</td></tr>
 <tr><th>トークン</th><td>${u.tokenCalls ? `入力 ${num(u.input)}・出力 ${num(u.output)}（Claude の ${num(u.tokenCalls)}回分、1回平均 入力 ${num(u.input / u.tokenCalls)}・出力 ${num(u.output / u.tokenCalls)}）` : '—'}</td></tr>
 <tr><th>全員分をこちらの API で作った場合</th><td>通常 ${yen(est)}・Batch ${yen(est / 2)}（$${u.estimateUsd.toFixed(2)}）${u.tokenCalls ? `／1回平均 ${yen(est / u.tokenCalls)}` : ''}</td></tr></tbody></table></div><p class="muted" style="margin-top:6px">各端末が記録した使用量（1.0.26 以降）の合計です。Codex はトークン数が分からないため、回数だけです。</p>`
  );
}
// Stripe 連携：通知の受け口・未割り当ての入金
const payLink = u =>
  data.settings.paymentLink ? `${data.settings.paymentLink}?client_reference_id=${encodeURIComponent(u.account)}` : '';
function stripe() {
  const st = data.stripe || {configured: false, unmatched: []},
    hook = `${location.origin}/api/stripe/webhook`,
    events =
      '<code>invoice.paid</code>・<code>checkout.session.completed</code>・<code>checkout.session.async_payment_succeeded</code>・<code>charge.refunded</code>・<code>customer.subscription.created</code>・<code>customer.subscription.updated</code>・<code>customer.subscription.deleted</code>';
  if (!st.configured)
    return panel(
      'Stripe 連携',
      `<p>Stripe での入金を自動で記録するには、次の 3 つを設定します。</p><ol><li>Stripe のダッシュボードの Webhook（ワークベンチ）でエンドポイントを追加し、URL に <code>${esc(hook)}</code>、イベントに ${events} を選ぶ</li><li>作成したエンドポイントの「署名シークレット」（<code>whsec_</code> で始まる文字列）を、GitHub の Secrets に <code>STRIPE_WEBHOOK_SECRET</code> として登録する</li><li>本番への反映をやり直す（GitHub の Actions で「Test and deploy」を実行）</li></ol><p class="muted">設定が済むと、この欄に「受け取り中」と出ます。</p>`
    );
  const opts = data.users.map(u => `<option value="${esc(u.account)}">${nameOf(u)}</option>`).join('');
  const rows = st.unmatched
    .map(
      x =>
        `<tr><td>${esc(x.paid_on || '')}</td><td class="num${x.amount < 0 ? ' minus' : ''}">${yen(x.amount)}</td><td>${esc(x.email || '')}${x.customer ? `<br><span class="muted"><code>${esc(x.customer)}</code></span>` : ''}<br><span class="muted">${esc(x.note)}</span></td><td><select class="form-control" id="assign-${esc(x.id)}" style="min-width:140px"><option value="">利用者を選ぶ</option>${opts}</select></td><td><button class="btn btn-sm btn-primary" data-action="assign" data-id="${esc(x.id)}">割り当て</button> <button class="btn btn-sm" data-action="delunmatched" data-id="${esc(x.id)}">削除</button></td></tr>`
    )
    .join('');
  return panel(
    'Stripe 連携',
    `<p><span class="tag active">受け取り中</span> Stripe での入金・返金を自動で記録します（受け口 <code>${esc(hook)}</code>）。</p>
 <p class="muted">記録する通知：${events}。利用者は、支払いリンクに付けた利用者 ID（<code>client_reference_id</code>）か、覚えた Stripe の顧客 ID で見分けます。利用者ごとの支払いリンクは「編集」に出ます${data.settings.paymentLink ? '' : '（下の「計算の設定」で支払いリンクを登録すると出ます）'}。</p>
 ${st.unmatched.length ? `<h3 class="sub">利用者の分からない入金（${st.unmatched.length}件）</h3><p class="muted">割り当てると顧客 ID も覚えるので、同じ顧客の次の入金からは自動で記録します。</p><div class="scroll"><table class="table-default wide"><thead><tr><th>入金日</th><th class="num">金額</th><th>支払った人</th><th>利用者</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">利用者の分からない入金はありません。</p>'}`
  );
}
function settings() {
  const s = data.settings;
  return panel(
    '計算の設定',
    `<form id="settings-form"><div class="form-grid"><div><label for="s-fee">決済手数料（%）</label><input class="form-control" id="s-fee" type="number" min="0" max="20" step="0.1" value="${(s.feeRate * 100).toFixed(1)}"></div><div><label for="s-usd">1 ドル（円）</label><input class="form-control" id="s-usd" type="number" min="50" max="500" step="1" value="${s.usdJpy}"></div><div><label class="check" style="font-size:14px;color:inherit"><input type="checkbox" id="s-tax"${s.taxable ? ' checked' : ''}> 消費税を売上から引く（課税事業者）</label></div><div class="wide"><label for="s-link">Stripe の支払いリンク（任意。https://buy.stripe.com/… の「?」より前。毎月の定期支払いにしたリンク）</label><input class="form-control" id="s-link" type="url" maxlength="290" placeholder="https://buy.stripe.com/xxxxxxxx" value="${esc(s.paymentLink || '')}"></div>
 <div class="wide"><label for="s-portal">Stripe の顧客ポータルのリンク（解約・カードの変更。利用者の設定画面に出ます）</label><input class="form-control" id="s-portal" type="url" maxlength="290" placeholder="https://billing.stripe.com/p/login/xxxxxxxx" value="${esc(s.portalLink || '')}"></div>
 <div><label for="s-price">支払い画面に出す月額（税込・円）</label><input class="form-control" id="s-price" type="number" min="0" step="1" value="${s.monthlyPrice || 0}"></div>
 <div class="wide"><p class="muted" style="margin:0">SaBoRo課題サポートの料金の条件（月額に含む課題生成 60 回、超過分＝実費×1.5 倍、請求の為替 1 ドル＝150 円）は、特定商取引法に基づく表記と同じ固定値です。変えるときは表記と一緒にコードで変えます。上の為替は利益の計算だけに使います。</p></div><div><label for="s-ai-cap">無料分で使える実費の上限（1 人・月・ドル。0 で上限なし）</label><input class="form-control" id="s-ai-cap" type="number" min="0" max="1000" step="1" value="${s.aiFreeCapUsd ?? 15}"></div>
 <div class="wide"><label class="check" style="font-size:14px;color:inherit"><input type="checkbox" id="s-require"${s.requirePayment ? ' checked' : ''}> 支払いを必須にする（定期支払いが有効でない利用者は、同期・回答の作成・提出などを止め、支払いの画面を出します。プランが「無料」の人は対象外）</label></div></div><div class="actions" style="margin-top:0"><button class="btn btn-primary">保存</button></div></form>`
  );
}
// 画面の切り替え（売上・利用者／学年暦）。学年暦の更新が必要なら、タブと売上の画面の先頭で知らせる
const tab = (v, label) =>
  `<button class="btn btn-sm${view === v ? ' btn-primary' : ''}" data-action="view" data-view="${v}"${view === v ? ' aria-current="page"' : ''}>${label}</button>`;
function render() {
  const need = data.calendar?.needsUpdate;
  app.innerHTML = `<div class="bar">${tab('main', '売上・利用者')}${tab('calendar', `学年暦${need ? ' <span class="tag unpaid">要更新</span>' : ''}`)}${view === 'main' ? `<label for="month" class="muted">月</label><input class="form-control" type="month" id="month" value="${esc(month)}"><button class="btn btn-sm" data-action="thismonth"${month === data.current ? ' disabled' : ''}>今月</button>` : ''}<button class="btn btn-sm" data-action="reload">再読み込み</button><span class="grow"></span><button class="btn btn-sm" data-action="logout">ログアウト</button></div>${view === 'calendar' ? calendarView() : `${need ? panel('学年暦の更新が必要です', `<p>今の学年暦（${esc(data.calendar.term)}）は ${esc(data.calendar.end)} までです。「学年暦」で、大学の新しい学年暦（PDF）の URL を入れて更新してください。</p><button class="btn btn-sm btn-primary" data-action="view" data-view="calendar">学年暦を更新する</button>`) : ''}${summary()}${users()}${payments()}${stripe()}${costs()}${usage()}${trend()}${settings()}`}`;
}
// 学年暦：今配っているもの・更新の依頼・PDF の読み取りと保存
const DAYS = ['月', '火', '水', '木', '金', '土'];
function calTable(c) {
  const n = Math.max(0, ...DAYS.map(d => (c.rounds?.[d] || []).length));
  if (!n) return '<p class="muted">授業日がありません</p>';
  return `<div class="scroll"><table class="table-default wide"><thead><tr><th>回</th>${DAYS.map(d => `<th>${d}</th>`).join('')}</tr></thead><tbody>${Array.from({length: n}, (_, i) => `<tr><td>第${i + 1}回</td>${DAYS.map(d => `<td>${esc((c.rounds?.[d] || [])[i]?.slice(5) || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function calendarView() {
  if (!cal) return panel('学年暦', '<p class="muted">読み込み中…</p>');
  const c = cal.calendar,
    first = c ? Object.values(c.rounds).flat().sort()[0] : '';
  const now =
    panel(
      '今の学年暦',
      c
        ? `<table class="table-default"><tbody><tr><th>学期</th><td>${esc(c.term)}</td></tr><tr><th>期間</th><td>${esc(first)} 〜 ${esc(cal.end)}</td></tr><tr><th>読み取り元</th><td>${c.source ? `<a href="${esc(c.source)}" target="_blank" rel="noopener">${esc(c.source)}</a>` : '—'}</td></tr><tr><th>配っているもの</th><td>${cal.saved ? '管理者画面で更新した学年暦' : 'アプリに同梱の学年暦'}</td></tr></tbody></table>`
        : '<p class="muted">学年暦がありません</p>'
    ) +
    (cal.needsUpdate
      ? panel(
          '学年暦の更新が必要です',
          `<p>今の学年暦は ${esc(cal.end || '—')} までです。<strong>大学の新しい学年暦（PDF）の URL を入れて、更新をお願いします。</strong></p><p class="muted">期間の終わりの ${30} 日前から、この案内と運営通知が出ます。保存すると、利用者の PC は今の学期が終わった後の同期で受け取ります（アプリの配布はいりません）。</p>`
        )
      : '');
  const form = panel(
    '新しい学年暦を読み取る',
    `<form id="calendar-read"><div class="form-grid"><div class="wide"><label for="cal-url">大学の学年暦（PDF）の URL</label><input class="form-control" type="url" id="cal-url" required placeholder="https://www.chukyo-u.ac.jp/…/calendar….pdf" value="${esc(calPreview?.calendar?.source || '')}"></div><div><label for="cal-term">読む学期（任意。空なら次の学期）</label><input class="form-control" id="cal-term" maxlength="40" placeholder="例：2027 春学期"></div></div><div class="actions"><button class="btn btn-primary"${calBusy ? ' disabled' : ''}>${calBusy ? '読み取り中…（1 分ほど）' : '読み取る'}</button><span class="muted">SaBoRo課題サポートの AI で PDF を読み取ります（1 回 数十円ほど）。保存する前に中身を確かめられます。</span></div></form>`
  );
  const p = calPreview,
    preview = p
      ? panel(
          `読み取った学年暦：${esc(p.calendar.term || '（学期名なし）')}`,
          `${p.errors.length ? `<p class="err">保存できません：${p.errors.map(esc).join('／')}</p>` : ''}${p.warnings.length ? `<p class="muted">確かめてください：${p.warnings.map(esc).join('／')}</p>` : ''}${calTable(p.calendar)}<div class="actions"><button class="btn btn-primary" data-action="savecal"${p.errors.length ? ' disabled' : ''}>この学年暦を保存する</button><button class="btn" data-action="dropcal">やめる</button></div>`
        )
      : '';
  return now + form + preview + (c ? panel('今の学年暦の授業日', calTable(c)) : '');
}
async function openCalendar() {
  view = 'calendar';
  cal = null;
  render();
  try {
    cal = await api('/calendar');
    render();
  } catch (e) {
    if (!['unauthorized', 'not_configured'].includes(e.message)) toast(e.message);
  }
}
const val = id => document.getElementById(id)?.value ?? '';
async function act(fn, message) {
  try {
    await fn();
    editing = paying = null;
    toast(message);
    await load();
  } catch (e) {
    if (!['unauthorized', 'not_configured'].includes(e.message)) toast(e.message);
  }
}
app.addEventListener('submit', e => {
  e.preventDefault();
  const id = e.target.id;
  if (id === 'calendar-read') {
    calBusy = true;
    render();
    api('/calendar/read', {url: val('cal-url').trim(), term: val('cal-term').trim()})
      .then(
        r => {
          calPreview = r;
        },
        e => {
          if (!['unauthorized', 'not_configured'].includes(e.message)) toast(`読み取れませんでした：${e.message}`);
        }
      )
      .finally(() => {
        calBusy = false;
        render();
      });
    return;
  }
  if (id === 'login') {
    token = val('token').trim();
    try {
      sessionStorage.setItem(KEY, token);
    } catch {}
    load();
    return;
  }
  if (id === 'edit-form')
    act(
      () =>
        api('/user', {
          account: editing,
          label: val('e-label'),
          status: val('e-status'),
          plan: val('e-plan'),
          price: Number(val('e-price') || 0),
          started: val('e-started'),
          note: val('e-note')
        }),
      '保存しました'
    );
  if (id === 'pay-form')
    act(
      () =>
        api('/payment', {
          account: paying,
          month: val('p-month'),
          amount: Number(val('p-amount')),
          paid_on: val('p-paid'),
          method: val('p-method'),
          note: val('p-note')
        }),
      '入金を記録しました'
    );
  if (id === 'cost-form')
    act(
      () =>
        api('/cost', {
          item: val('c-item'),
          amount: Number(val('c-amount')),
          month: val('c-month'),
          recurring: document.getElementById('c-recurring').checked,
          note: val('c-note')
        }),
      '費用を追加しました'
    );
  if (id === 'settings-form') {
    const require = document.getElementById('s-require').checked;
    const stop = data.users.filter(u => u.plan !== 'free' && !u.billing?.active);
    if (
      require &&
      !data.settings.requirePayment &&
      !confirm(
        `支払いを必須にします。いま定期支払いが有効でない ${stop.length}人（${stop.map(u => u.label || short(u.account)).join('、') || 'なし'}）は、同期や回答の作成が止まります。\n自分など料金のかからない人は、先にプランを「無料」にしてください。続けますか？`
      )
    )
      return;
    act(
      () =>
        api('/settings', {
          feeRate: Number(val('s-fee')) / 100,
          usdJpy: Number(val('s-usd')),
          taxable: document.getElementById('s-tax').checked,
          paymentLink: val('s-link').trim(),
          portalLink: val('s-portal').trim(),
          monthlyPrice: Number(val('s-price') || 0),
          aiFreeCapUsd: Number(val('s-ai-cap') || 15),
          requirePayment: require
        }),
      '設定を保存しました'
    );
  }
});
app.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const a = b.dataset.action;
  if (a === 'view') {
    if (b.dataset.view === 'calendar') openCalendar();
    else {
      view = 'main';
      render();
    }
    return;
  }
  if (a === 'savecal') {
    if (!calPreview || calPreview.errors.length) return;
    if (
      !confirm(
        `学年暦を「${calPreview.calendar.term}」に更新します。利用者の PC は今の学期が終わった後の同期で受け取ります。保存しますか？`
      )
    )
      return;
    api('/calendar', {calendar: calPreview.calendar}).then(
      () => {
        calPreview = null;
        toast('学年暦を保存しました');
        load().then(openCalendar);
      },
      e => {
        if (!['unauthorized', 'not_configured'].includes(e.message)) toast(e.message);
      }
    );
    return;
  }
  if (a === 'dropcal') {
    calPreview = null;
    render();
    return;
  }
  if (a === 'reload') {
    if (view === 'calendar') openCalendar();
    else load();
    return;
  } else if (a === 'logout') logout();
  else if (a === 'thismonth') load(data.current);
  else if (a === 'edit') {
    editing = b.dataset.account;
    paying = null;
    render();
    document.getElementById('e-label')?.focus();
  } else if (a === 'pay') {
    paying = b.dataset.account;
    editing = null;
    render();
    document.getElementById('p-amount')?.focus();
  } else if (a === 'cancel') {
    editing = paying = null;
    render();
  } else if (a === 'copylink') {
    const v = val('e-link');
    (navigator.clipboard?.writeText(v) || Promise.reject()).then(
      () => toast('コピーしました'),
      () => {
        document.getElementById('e-link').select();
        toast('選択しました。コピーしてください');
      }
    );
  } else if (a === 'link') {
    const c = val('e-customer').trim();
    const keep = editing;
    act(() => api('/stripe/link', {account: keep, customer: c}), '顧客 ID を追加しました').then(() => {
      editing = keep;
      render();
    });
  } else if (a === 'unlink' && confirm('この顧客 ID の対応を解除しますか？（記録済みの入金はそのまま）')) {
    const keep = editing;
    act(() => api('/stripe/unlink', {customer: b.dataset.customer}), '解除しました').then(() => {
      editing = keep;
      render();
    });
  } else if (a === 'assign') {
    const account = document.getElementById('assign-' + b.dataset.id)?.value;
    if (!account) {
      toast('利用者を選んでください');
      return;
    }
    act(() => api('/stripe/assign', {id: b.dataset.id, account}), '割り当てました');
  } else if (a === 'delunmatched' && confirm('この入金の記録を削除しますか？（Stripe 側はそのまま）'))
    act(() => api('/stripe/unmatched/delete', {id: b.dataset.id}), '削除しました');
  else if (a === 'delpay' && confirm('この入金の記録を削除しますか？'))
    act(() => api('/payment/delete', {id: b.dataset.id}), '削除しました');
  else if (a === 'delcost' && confirm('この費用を削除しますか？過去の月の利益も変わります。'))
    act(() => api('/cost/delete', {id: b.dataset.id}), '削除しました');
  else if (a === 'endcost' && confirm(`${month} を最後の月として終了しますか？`))
    act(() => api('/cost/end', {id: b.dataset.id, month}), '終了にしました');
});
app.addEventListener('change', e => {
  if (e.target.id === 'month' && e.target.value) load(e.target.value);
});
if (token) load();
else login();
