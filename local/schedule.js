import {calendar} from './calendar.js';
import {courseIdOf, courseList} from './core.js';
// 授業の開始時刻（1 時限 90 分）。中京大学「授業について」の授業時間（キャンパスで異なる。名古屋：1限 9:00〜、豊田：9:30〜）
export const PERIOD_START = {
  名古屋: {1: '09:00', 2: '10:45', 3: '13:10', 4: '14:55', 5: '16:40'},
  豊田: {1: '09:30', 2: '11:10', 3: '13:30', 4: '15:10', 5: '16:50'}
};
export const CAMPUSES = Object.keys(PERIOD_START);
export const periodStart = (period, campus = '名古屋') =>
  (PERIOD_START[campus] || PERIOD_START['名古屋'])[Number(period)] || '';
// 授業の曜日・時限：自分の設定 → CUBICS の時間割 → manabo の表記（画面の時間割と同じ順）
export function courseSlot(state, i) {
  const c = courseList(state)[i];
  if (!c) return {weekday: '', period: 0};
  const id = courseIdOf(i, state),
    own = state.timetable?.[c.name] || {},
    cub = state.cubics?.courses?.[c.name] || {};
  return {
    weekday: own.weekday || cub.weekday || state.weekdays?.[id] || '',
    period: Number(own.period || cub.period || state.periods?.[id]) || 0
  };
}
// その授業の授業日：学年暦の曜日ごとの授業日と、自分で設定した日程
export function classDates(state, i, cal = calendar) {
  const id = courseIdOf(i, state),
    {weekday} = courseSlot(state, i),
    dates = new Set(cal?.rounds?.[weekday] || []);
  for (const d of Object.values(state.schedules?.[id] || {})) if (typeof d === 'string') dates.add(d);
  return dates;
}
// その日の授業（開始時刻つき）。曜日・時限が分からない授業、CUBICS で休講の回、削除した授業は除く
export function sessionsOn(state, date, cal = calendar) {
  const campus = state.settings?.campus || '名古屋';
  return courseList(state)
    .map((c, i) => {
      if (c.removed) return null;
      const {weekday, period} = courseSlot(state, i),
        start = periodStart(period, campus);
      if (!weekday || !start || !classDates(state, i, cal).has(date)) return null;
      if ((state.cubics?.events || []).some(e => e.course === c.name && e.date === date && e.status === '休講'))
        return null;
      return {i, name: c.name, date, period, start};
    })
    .filter(Boolean);
}
const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
// 授業の開始時刻を過ぎていて（開始から graceMinutes 分以内）、その日にまだその授業を同期していないもの（state.classSynced[日付][授業名]）
export function dueClassSyncs(state, now = new Date(), cal = calendar, graceMinutes = 120) {
  const date = now.toLocaleDateString('sv-SE', {timeZone: 'Asia/Tokyo'}),
    hm = now.toLocaleTimeString('en-GB', {timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit'});
  return sessionsOn(state, date, cal).filter(
    s => hm >= s.start && minutes(hm) - minutes(s.start) <= graceMinutes && !state.classSynced?.[date]?.[s.name]
  );
}
