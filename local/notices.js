import {fileRound} from './timetable.js';
// お知らせの読み取り：見出し（「【第03回，10/09】配布資料 & 復習用動画」など）と本文から、回・日付・Zoom のリンクとパスコード・教室・休講を取り出す
// 日付は学年暦の学期（「2026 秋学期」）の年で補う。秋学期の 1〜3 月は翌年
const ROUND = /第\s*0?(\d{1,2})\s*回/;
const MD = /(\d{1,2})\s*\/\s*(\d{1,2})/;
export const termYear = term => Number(String(term || '').match(/(\d{4})/)?.[1]) || new Date().getFullYear();
export function noticeDate(title, term) {
  const m = String(title || '').match(MD);
  if (!m) return '';
  const month = Number(m[1]),
    day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  let year = termYear(term);
  if (/秋|後期|冬/.test(String(term || '')) && month <= 3) year++;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const ZOOM = /https?:\/\/[\w.-]*zoom\.us\/[^\s"'<>]+/i;
const PASS = /パスコード\s*[:：]?\s*([^\s　]+)/;
const ROOM = /教室\s*(?:は|が|[:：])?\s*([0-9A-Za-z]{2,6}(?:教室|号室)?)/;
const CANCELLED = /休講/;
// 1 件のお知らせ（title：見出し、text：本文、files：付いているファイル）を読む
export function parseNotice({title = '', text = '', files = [], links = []}, term) {
  const head = String(title).normalize('NFKC'),
    body = String(text).normalize('NFKC'),
    round = Number(head.match(ROUND)?.[1] || 0) || files.map(f => fileRound(f.name)).find(Boolean) || 0,
    zoom = body.match(ZOOM)?.[0] || (links || []).find(l => ZOOM.test(l)) || '',
    pass = zoom ? body.match(PASS)?.[1] || '' : '',
    room = body.match(ROOM)?.[1] || '';
  return {
    title: String(title).trim().slice(0, 200),
    round,
    date: noticeDate(head, term),
    zoom,
    pass: pass.slice(0, 40),
    room: room.slice(0, 20),
    cancelled:
      CANCELLED.test(head) ||
      (CANCELLED.test(body) &&
        !/休講(?:では|じゃ)?(?:ない|なく|ありません)|休講(?:は|に|と)?(?:しません|なりません|ありません)/.test(body)),
    files: files.map(f => ({url: f.url, name: f.name})),
    text: String(text).trim().slice(0, 300)
  };
}
// お知らせの見分けの鍵（同じお知らせを二度「新着」にしない）
export const noticeKey = n => `${n.title}|${n.date}|${n.files.map(f => f.url).join(',')}`;
// 休講のお知らせから、時間割に出す予定（CUBICS の events と同じ形）
export const noticeEvents = (course, notices) =>
  (notices || [])
    .filter(n => n.cancelled && n.date)
    .map(n => ({course, date: n.date, status: '休講', source: 'お知らせ', title: n.title}));
