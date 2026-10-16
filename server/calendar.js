// 学年暦（大学の学年暦の PDF から読み取った、曜日ごとの第1回〜最終回の授業日）
// 管理者画面で PDF の URL を入れると AI で読み取り（server/ai.js の readCalendarPdf）、確かめてから保存する（admin_settings の academicCalendar）
// 保存したものを /api/academic-calendar で配る。なければアプリに同梱の dist/academic-calendar.json を返す。PC と画面はここから新しい学期の授業日を受け取る
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'],
  DATE = /^\d{4}-\d{2}-\d{2}$/;
const jst = (now = new Date()) => new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
export const calendarEnd = c =>
  Object.values(c?.rounds || {})
    .flat()
    .sort()
    .at(-1) || '';
// 期間の終わりが 30 日以内（または終わった）なら、管理者に新しい学年暦の URL を頼む
export const UPDATE_BEFORE_DAYS = 30;
export const needsUpdate = (c, now = new Date()) =>
  !c || calendarEnd(c) < jst(new Date(now.getTime() + UPDATE_BEFORE_DAYS * 864e5));
// 学年暦を確かめる。errors があれば保存しない。warnings（曜日が違う日など。振替授業の日はありうる）は管理者に見せて判断してもらう
export function checkCalendar(c) {
  const errors = [],
    warnings = [];
  if (!c || typeof c !== 'object' || !c.rounds || typeof c.rounds !== 'object')
    return {errors: ['形が違います'], warnings};
  if (typeof c.term !== 'string' || !c.term.trim() || c.term.length > 40) errors.push('学期の名前がありません');
  if (c.source != null && !/^https:\/\/[^\s]{1,300}$/.test(c.source)) errors.push('読み取り元の URL が不正です');
  const days = Object.entries(c.rounds).filter(([, v]) => Array.isArray(v) && v.length);
  if (days.length < 5) errors.push('授業日のある曜日が 5 つ未満です');
  for (const [w, dates] of Object.entries(c.rounds)) {
    const wi = WEEKDAYS.indexOf(w);
    if (wi < 1) {
      errors.push(`曜日「${w}」は使えません`);
      continue;
    }
    if (!Array.isArray(dates)) {
      errors.push(`${w}曜の授業日が一覧になっていません`);
      continue;
    }
    if (!dates.length) continue;
    if (dates.length < 10 || dates.length > 20)
      errors.push(`${w}曜の授業日が ${dates.length} 回です（10〜20 回のはず）`);
    for (const [i, d] of dates.entries()) {
      if (typeof d !== 'string' || !DATE.test(d) || isNaN(new Date(d + 'T00:00:00Z'))) {
        errors.push(`${w}曜の第${i + 1}回の日付が不正です（${String(d).slice(0, 20)}）`);
        continue;
      }
      if (i && d <= dates[i - 1]) errors.push(`${w}曜の第${i + 1}回が前の回より前です`);
      if (new Date(d + 'T00:00:00Z').getUTCDay() !== wi)
        warnings.push(
          `${w}曜の第${i + 1}回（${d}）は${WEEKDAYS[new Date(d + 'T00:00:00Z').getUTCDay()]}曜日です（振替授業なら問題ありません）`
        );
    }
  }
  const all = days
    .flatMap(([, v]) => v)
    .filter(d => typeof d === 'string' && DATE.test(d))
    .sort();
  if (all.length && (new Date(all.at(-1)) - new Date(all[0])) / 864e5 > 200)
    errors.push('最初と最後の授業日が 200 日以上離れています（1 学期分のはず）');
  return {errors, warnings};
}
// 保存する形にそろえる（空の曜日は除く）
export const normalizeCalendar = c => ({
  term: String(c?.term ?? '').trim(),
  ...(c?.source ? {source: String(c.source)} : {}),
  rounds: Object.fromEntries(
    Object.entries(c?.rounds && typeof c.rounds === 'object' ? c.rounds : {}).filter(
      ([, v]) => Array.isArray(v) && v.length
    )
  )
});
// 今配っている学年暦：保存したもの（形が正しければ）、なければ同梱のもの
export async function currentCalendar(env, store, url) {
  const saved = (await store.getAdminSettings()).academicCalendar;
  if (saved && !checkCalendar(saved).errors.length) return {calendar: saved, saved: true};
  try {
    const r = await env.ASSETS?.fetch(new Request(new URL('/academic-calendar.json', url)));
    if (r?.ok) return {calendar: await r.json(), saved: false};
  } catch {}
  return {calendar: null, saved: false};
}
