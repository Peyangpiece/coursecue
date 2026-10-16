// 支払いが必要か・使えるかの判定。管理者画面の「支払いを必須にする」が有効なときだけ止める（既定は無効）
// 使える：必須でない、プランが「無料」、または Stripe の定期支払いが有効（active・trialing・支払いの再試行中の past_due）
// 止めるのは作業を伴う処理（同期・回答の作成・提出・補足・出席）だけ。設定・ログイン情報・確認などは止めない（支払い前の準備や解約後の後始末ができるように）
export const ACTIVE = ['active', 'trialing', 'past_due'];
// 月額（税込・円）。特定商取引法に基づく表記と同じ固定値（site/public/tokushoho.html と必ず同時に変える。tests/site.test.js で照らす）。管理画面の「支払い画面に出す月額」が 0 ならこの値を出す
export const MONTHLY_YEN = 2500;
export const PAID_KINDS = ['sync', 'generate', 'submit', 'supplement', 'attendance', 'prompt', 'attcheck'];
// subs：この利用者の定期支払い（顧客 ID を通して対応したもの）
export function billingOf({account, settings = {}, plan, subs = []}) {
  const required = !!settings.requirePayment && plan !== 'free',
    live = subs.filter(s => ACTIVE.includes(s.status)),
    sub = [...(live.length ? live : subs)].sort((a, b) => (b.event_at || 0) - (a.event_at || 0))[0] || null;
  const active = live.length > 0;
  return {
    required,
    active,
    allowed: !required || active,
    exempt: !!settings.requirePayment && plan === 'free',
    status: sub?.status || null,
    periodEnd: sub?.period_end ? new Date(sub.period_end * 1000).toISOString() : null,
    cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
    price: Number(settings.monthlyPrice) || MONTHLY_YEN,
    checkoutUrl: settings.paymentLink
      ? `${settings.paymentLink}?client_reference_id=${encodeURIComponent(account)}`
      : '',
    portalUrl: settings.portalLink || ''
  };
}
