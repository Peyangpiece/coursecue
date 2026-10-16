// 時間割・出席管理（app.js の状態・描画を使う）
const WEEKDAYS = ['月', '火', '水', '木', '金', '土'],
  MODES = ['対面', 'オンライン', 'オンデマンド', '休講'],
  MARKS = ['出席', '遅刻', '欠席', '公欠'];
const modeClass = {対面: 'mode-face', オンライン: 'mode-online', オンデマンド: 'mode-demand', 休講: 'mode-off'},
  markClass = {出席: 'done', 遅刻: 'wait', 欠席: 'mode-off', 公欠: 'draft'};
let academicRounds = {},
  weekOffset = 0,
  pendingTimetable = [];
if (typeof fetch === 'function')
  academicCalendar()
    .then(j => {
      academicRounds = j.rounds || {};
      render();
    })
    .catch(() => {});
const todayISO = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Asia/Tokyo'});
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayLabel = iso => {
  const d = new Date(iso + 'T00:00:00Z');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${'日月火水木金土'[d.getUTCDay()]})`;
};
// 日曜は翌週（これからの授業）を表示する
const weekStart = () => {
  const t = todayISO(),
    day = new Date(t + 'T00:00:00Z').getUTCDay();
  return addDays(t, (day === 0 ? 1 : -(day - 1)) + 7 * weekOffset);
};
const courseId = i => (key ? courseIdOf(i) || null : null);
// 授業ごとの設定（曜日・時限は manabo から自動取得したものを既定にする）
// 優先順：自分で設定した値 → CUBICS（大学の時間割） → ガイダンス資料から読み取った値（根拠あり） → manabo の表記
// 授業形式は 自分で設定した値 → 資料 → CUBICS からの推定。CUBICS で教室が割り当てられていれば対面、
// 読み取った全週で時間割に枠がなければオンデマンドとみなす（対応づけに失敗した枠と同じ曜日・時限のときや、1つも対応づけられなかったときは推定しない）
function cubicsMode(i, cub) {
  const c = state.cubics;
  if (!c?.weeks?.length || !Object.keys(c.courses || {}).length) return '';
  if (cub.room) return '対面';
  if (cub.weekday) return '';
  const id = courseId(i),
    own = state.timetable?.[courses[i]] || {},
    w = own.weekday || state.weekdays?.[id],
    p = own.period || state.periods?.[id];
  if (w && (c.unmatched || []).some(u => u.weekday === w && (!p || !u.period || u.period === p))) return '';
  return 'オンデマンド';
}
const courseInfo = i => state.courseInfo?.[courses[i]] || {};
function courseConfig(i) {
  const name = courses[i],
    own = state.timetable?.[name] || {},
    id = courseId(i),
    info = courseInfo(i),
    cub = state.cubics?.courses?.[name] || {};
  const slotFrom = own.weekday ? '' : cub.weekday ? 'CUBICS' : state.weekdays?.[id] ? 'manabo' : '';
  return {
    weekday: own.weekday || cub.weekday || state.weekdays?.[id] || '',
    period: own.period || (own.weekday ? null : cub.period) || state.periods?.[id] || null,
    room: own.room || cub.room || info.room?.value || '',
    mode: own.mode || info.mode?.value || cubicsMode(i, cub) || '',
    autoMode: info.mode?.value || cubicsMode(i, cub) || '',
    modeFrom: own.mode ? '' : info.mode ? '資料' : cubicsMode(i, cub) ? 'CUBICS' : '',
    limit: own.limit ?? info.absenceLimit?.value ?? null,
    auto: !!slotFrom,
    slotFrom,
    roomFrom: own.room ? '' : cub.room ? 'CUBICS' : info.room ? '資料' : '',
    fromInfo: {
      room: !own.room && !cub.room && !!info.room,
      mode: !own.mode && !!info.mode,
      limit: own.limit == null && info.absenceLimit != null
    }
  };
}
const cubicsEvent = (i, date) =>
  date && state.cubics?.events?.find(e => e.course === courses[i] && e.date === date && e.status !== '補講');
// お知らせから読み取った休講（PC の state.noticeEvents）と、その回のお知らせ（Zoom・教室）
const noticeEvent = (i, date) =>
  date && (state.noticeEvents || []).find(e => e.course === courses[i] && e.date === date);
const noticeFor = (i, r) => (state.notices?.[courses[i]] || []).find(n => n.round === +r) || null;
// その回の資料（PC に保存した記録。回は記録の round か名前の「第N回」）
const roundMaterials = (i, r) =>
  (state.materials || []).filter(
    m =>
      m.course === courses[i] &&
      (Number(m.round) ||
        Number(
          String(m.name || '')
            .normalize('NFKC')
            .match(/第\s*0?(\d+)\s*回/)?.[1] || 0
        )) === +r
  );
const infoRows = i => {
  const info = courseInfo(i),
    labels = {
      room: '教室',
      mode: '授業形式',
      absenceLimit: '欠席の上限',
      attendanceMethod: '出席の取り方',
      lateRule: '遅刻の扱い',
      notes: 'その他'
    };
  const rows = Object.entries(labels)
    .filter(([k]) => info[k])
    .map(
      ([k, l]) =>
        `<tr><th>${l}</th><td>${esc(info[k].value)}${k === 'absenceLimit' ? '回' : ''}<small class="muted" style="display:block">「${esc(info[k].evidence)}」（${esc(info[k].file)}）</small></td></tr>`
    );
  for (const x of [...(info.sessions || []), ...(state.plannedModes?.[courses[i]] || [])])
    rows.push(
      `<tr><th>第${x.from === x.to ? x.from : `${x.from}〜${x.to}`}回</th><td>${modeLabel(x.mode)}<small class="muted" style="display:block">「${esc(x.evidence)}」（${esc(x.file)}）</small></td></tr>`
    );
  return rows.length
    ? `<h3>ガイダンス資料・シラバスから読み取った情報</h3><table class="table-default">${rows.join('')}</table><p class="muted" style="margin-top:6px">資料の本文に根拠の文が見つかった項目だけを表示しています。下で設定した値が優先されます。</p>`
    : info.extractedAt
      ? '<p class="muted">ガイダンス資料から読み取れる授業情報はありませんでした。</p>'
      : '';
};
// 第n回 → 日付（manabo連携時は同期で設定された日程、なければ学年暦）
function courseDates(i) {
  const id = courseId(i),
    own = id && state.schedules?.[id];
  const w = courseConfig(i).weekday,
    cal = academicRounds[w];
  const out = {};
  if (cal) cal.forEach((d, n) => (out[n + 1] = d));
  if (own) for (const [r, d] of Object.entries(own)) out[r] = d;
  return out;
}
const session = (i, r) => state.sessions?.[courses[i]]?.[r] || {};
// 資料・シラバスに書かれたその回の授業形式（manabo の【動画】表記を最優先、範囲が重なるときは後の記載を優先）
const plannedMode = (i, r) =>
  [...(courseInfo(i).sessions || []), ...(state.plannedModes?.[courses[i]] || [])]
    .filter(x => x.from <= r && r <= x.to)
    .at(-1) || null;
// 回の情報：自分の記録 → CUBICS の休講・授業変更 → 資料・シラバスの回ごとの形式 → 授業の既定
function sessionInfo(i, r) {
  r = +r;
  const c = courseConfig(i),
    s = session(i, r),
    date = courseDates(i)[r],
    ev = cubicsEvent(i, date),
    nev = noticeEvent(i, date),
    notice = noticeFor(i, r),
    plan = plannedMode(i, r);
  return {
    plan,
    mode: s.mode || (ev?.status === '休講' || nev?.status === '休講' ? '休講' : '') || plan?.mode || c.mode || '',
    room: s.room || (ev?.status === '授業変更' && ev.room) || notice?.room || c.room || '',
    attendance: s.attendance || '',
    note: s.note || '',
    changed: ev?.status === '授業変更',
    official: ev?.status || (nev ? `${nev.status}（お知らせ）` : ''),
    zoom: notice?.zoom || '',
    pass: notice?.pass || '',
    notice
  };
}
// 状態への反映（Mac 側の bridge.js にも同じ規則がある）
function applyTimetable(target, {course, round, values}) {
  if (round) {
    target.sessions = {...target.sessions};
    const all = {...target.sessions[course]},
      cur = {...all[round]};
    for (const [k, v] of Object.entries(values)) {
      if (v === '' || v === null) delete cur[k];
      else cur[k] = v;
    }
    if (Object.keys(cur).length) all[round] = cur;
    else delete all[round];
    target.sessions[course] = all;
  } else {
    target.timetable = {...target.timetable};
    const cur = {...target.timetable[course]};
    for (const [k, v] of Object.entries(values)) {
      if (v === '' || v === null) delete cur[k];
      else cur[k] = v;
    }
    target.timetable[course] = cur;
  }
}
function saveTimetable(patch) {
  applyTimetable(state, patch);
  if (!key) {
    savePersonal();
    render();
    return;
  }
  pendingTimetable.push({patch, at: Date.now()});
  render();
  job('timetable', null, patch);
}
// サーバーから読み直した直後も、Mac がまだ反映していない変更を表示し続ける
function reapplyPending() {
  pendingTimetable = pendingTimetable.filter(p => Date.now() - p.at < 90000);
  for (const p of pendingTimetable) applyTimetable(state, p.patch);
}
const modeLabel = m => (m ? `<span class="label ${modeClass[m] || ''}">${esc(m)}</span>` : '');
const markLabel = a => (a ? `<span class="label ${markClass[a] || ''}">${esc(a)}</span>` : '');
// 指定日の授業一覧
function sessionsOn(iso) {
  const w = '日月火水木金土'[new Date(iso + 'T00:00:00Z').getUTCDay()],
    out = [];
  courses.forEach((c, i) => {
    if (typeof removedCourse === 'function' && removedCourse(i)) return;
    const cfg = courseConfig(i);
    if (cfg.weekday !== w) return;
    const dates = courseDates(i),
      r = Object.keys(dates).find(k => dates[k] === iso);
    out.push({i, round: r ? +r : null, period: cfg.period, date: iso});
  });
  for (const e of state.cubics?.events || [])
    if (
      e.status === '補講' &&
      e.date === iso &&
      courses.includes(e.course) &&
      !(typeof removedCourse === 'function' && removedCourse(courses.indexOf(e.course)))
    )
      out.push({i: courses.indexOf(e.course), makeup: true, period: e.period, room: e.room, date: iso});
  return out.sort((a, b) => (a.period || 9) - (b.period || 9));
}
function cell(s) {
  if (s.makeup)
    return `<div class="tt-session makeup"><span class="tt-name">${esc(courses[s.i])}</span><span class="meta">補講${s.room ? ` · ${esc(s.room)}` : ''}</span><span class="tt-labels"><span class="label mode-makeup">補講</span></span></div>`;
  if (!s.round) return `<div class="tt-off">${esc(courses[s.i])}<small>授業なし（学年暦）</small></div>`;
  const info = sessionInfo(s.i, s.round);
  return `<button class="tt-session${info.mode === '休講' ? ' cancelled' : ''}" data-session="${s.i}:${s.round}"><span class="tt-name">${esc(courses[s.i])}</span><span class="meta">第${s.round}回${info.room ? ` · ${esc(info.room)}` : ''}</span><span class="tt-labels">${modeLabel(info.mode)}${info.changed ? '<span class="label wait">授業変更</span>' : ''}${markLabel(info.attendance)}</span></button>`;
}
function timetableView() {
  const start = weekStart(),
    today = todayISO(),
    days = WEEKDAYS.slice(0, courses.some((c, i) => courseConfig(i).weekday === '土') ? 6 : 5).map((w, k) => ({
      w,
      iso: addDays(start, k)
    }));
  const periods = Math.max(5, ...courses.map((c, i) => courseConfig(i).period || 0));
  const byDay = Object.fromEntries(days.map(d => [d.iso, sessionsOn(d.iso)]));
  const rows = Array.from(
    {length: periods},
    (_, p) =>
      `<tr><th scope="row">${p + 1}限</th>${days
        .map(
          d =>
            `<td class="${d.iso === today ? 'today' : ''}">${byDay[d.iso]
              .filter(s => s.period === p + 1)
              .map(cell)
              .join('')}</td>`
        )
        .join('')}</tr>`
  ).join('');
  // スマホ用：曜日ごとの一覧（PC の表と同じ内容。CSS で切り替える）
  const dayList = `<ul class="tt-days">${days.map(d => `<li class="${d.iso === today ? 'today' : ''}"><h3>${dayLabel(d.iso)}${d.iso === today ? ' <span class="label draft">今日</span>' : ''}</h3>${byDay[d.iso].length ? byDay[d.iso].map(s => `<div class="tt-day-row"><span class="tt-period">${s.period ? `${s.period}限` : '—'}</span>${cell(s)}</div>`).join('') : '<p class="tt-off">授業なし</p>'}</li>`).join('')}</ul>`;
  const noPeriod = days.flatMap(d => byDay[d.iso].filter(s => !s.period).map(s => ({...s, w: d.w})));
  const unset = courses
    .map((c, i) => ({c, i}))
    .filter(({i}) => !courseConfig(i).weekday && !(typeof removedCourse === 'function' && removedCourse(i)));
  const tools = `<span class="week-nav"><button class="btn btn-sm" data-week="-1" aria-label="前の週">◀</button><button class="btn btn-sm" data-week="0">今週</button><button class="btn btn-sm" data-week="1" aria-label="次の週">▶</button></span>`;
  return (
    panel(
      `時間割 ${dayLabel(days[0].iso)}〜${dayLabel(days.at(-1).iso)}`,
      `<div class="tt-wrap"><table class="timetable"><thead><tr><th scope="col"><span class="sr-only">時限</span></th>${days.map(d => `<th scope="col" class="${d.iso === today ? 'today' : ''}">${dayLabel(d.iso)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>${dayList}${noPeriod.length ? `<p class="muted" style="margin-top:10px">時限が未設定：${noPeriod.map(s => `${s.w} ${cell(s)}`).join(' ')}</p>` : ''}${state.cubics?.unmatched?.length ? `<p class="muted" style="margin-top:10px">CUBICS にあって saboro に登録されていない授業：${state.cubics.unmatched.map(u => `${esc(u.label)}（${esc(u.weekday || '')}${u.period ? u.period + '限' : ''}${u.room ? '・' + esc(u.room) : ''}）`).join('、')}</p>` : ''}${state.cubics?.fetchedAt ? `<p class="muted" style="margin-top:6px">教室・休講・補講は CUBICS の時間割から反映（${when(state.cubics.fetchedAt)} 確認）</p>` : ''}<p class="muted" style="margin:10px 0 0">授業を選ぶと、教室・授業形式・出席を記録できます。</p><details class="help"><summary>情報の出どころ</summary><p>曜日・時限・教室・休講・補講は CUBICS の時間割（なければ manabo の表記やガイダンス資料）、日付は大学の学年暦から自動で設定します。</p></details>`,
      {tools}
    ) +
    panel(
      '授業の設定',
      `${unset.length ? `<p class="muted">曜日が未設定の授業：${unset.map(({c}) => esc(c)).join('、')}</p>` : ''}<details id="coursecfg-details"${unset.length ? ' open' : ''}><summary>授業ごとの曜日・時限・教室・授業形式（${courses.length}件。「—」は未設定）</summary><table class="table-default table-stack" style="margin-top:10px"><thead><tr><th scope="col">授業名</th><th scope="col">曜日・時限</th><th scope="col">教室</th><th scope="col">授業形式</th></tr></thead><tbody>${courses
        .map((c, i) => {
          if (typeof removedCourse === 'function' && removedCourse(i)) return '';
          const cfg = courseConfig(i);
          return `<tr><td class="stack-head"><button class="linklike" data-coursecfg="${i}">${esc(c)}</button></td><td data-label="曜日・時限">${cfg.weekday ? `${esc(cfg.weekday)}曜${cfg.period ? ` ${cfg.period}限` : ''}${cfg.slotFrom ? ` <span class="muted">（${cfg.slotFrom}）</span>` : ''}` : '<span class="muted">—</span>'}</td><td data-label="教室"${cfg.room ? '' : ' class="unset"'}>${esc(cfg.room) || '<span class="muted">—</span>'}${cfg.roomFrom ? ` <span class="muted">（${cfg.roomFrom}）</span>` : ''}</td><td data-label="授業形式"${modeLabel(cfg.mode) ? '' : ' class="unset"'}>${modeLabel(cfg.mode) || '<span class="muted">—</span>'}${cfg.modeFrom ? ` <span class="muted">（${cfg.modeFrom === 'CUBICS' ? 'CUBICSから推定' : '資料'}）</span>` : ''}</td></tr>`;
        })
        .join('')}</tbody></table></details>`
    )
  );
}
// 出席の集計（過去の回で休講以外、記録がないものは「未記録」。オンデマンドの回は出席を取らないので、記録がなくても未記録にしない）
function attendanceSummary(i) {
  const dates = courseDates(i),
    today = todayISO(),
    out = {出席: 0, 遅刻: 0, 欠席: 0, 公欠: 0, 未記録: 0, total: Object.keys(dates).length};
  for (const r of Object.keys(dates)) {
    const info = sessionInfo(i, r);
    if (info.mode === '休講') continue;
    if (info.attendance) out[info.attendance]++;
    else if (dates[r] <= today && info.mode !== 'オンデマンド') out.未記録++;
  }
  return out;
}
// 出席状況：記録（出席・遅刻・公欠）をまとめ、判断に使う欠席・未記録・残りを中心に出す
function attendanceView() {
  const rows = courses
    .map((c, i) => {
      if (typeof removedCourse === 'function' && removedCourse(i)) return '';
      const s = attendanceSummary(i),
        limit = courseConfig(i).limit,
        left = limit == null ? null : limit - s.欠席;
      return `<tr class="${left != null && left <= 1 ? 'warn-row' : ''}"><td class="stack-head"><button class="linklike" data-attendance="${i}">${esc(c)}</button></td><td class="num" data-label="欠席">${s.欠席}</td><td class="num" data-label="未記録">${s.未記録 ? `<span class="attn">${s.未記録}</span>` : 0}</td><td class="num" data-label="残り">${left == null ? '<span class="muted">上限未設定</span>' : left < 0 ? `<b class="deadline overdue">${-left}回超過</b>` : left <= 1 ? `<b class="deadline urgent">あと${left}回</b>` : `あと${left}回`}${limit == null ? '' : ` <span class="muted">（上限${limit}回${courseConfig(i).fromInfo.limit ? '・資料' : ''}）</span>`}</td><td class="num muted" data-label="記録">出${s.出席}・遅${s.遅刻}・公${s.公欠}</td></tr>`;
    })
    .join('');
  return panel(
    '出席状況',
    `<table class="table-default table-stack"><thead><tr><th scope="col">授業名</th><th scope="col" class="num">欠席</th><th scope="col" class="num">未記録</th><th scope="col" class="num">残り</th><th scope="col" class="num">記録</th></tr></thead><tbody>${rows}</tbody></table><p class="muted" style="margin:10px 0 0">授業名を選ぶと、各回の出席をまとめて記録できます。</p><details class="help"><summary>数え方</summary><p>「未記録」は過去の回で出席を入れていない数です（オンデマンドの回は数えません）。欠席の上限はガイダンス資料にあれば自動で入り（「資料」）、なければ授業名から設定できます。遅刻を欠席に換算するかは授業によって違うため、別に数えています。</p></details>`
  );
}
// ホームの「今日の授業」。今日がなければ 7 日先までの次の授業日を出す
function todayPanel() {
  const today = todayISO();
  let iso = today,
    list = sessionsOn(today).filter(s => s.round || s.makeup);
  for (let k = 1; !list.length && k <= 7; k++) {
    iso = addDays(today, k);
    list = sessionsOn(iso).filter(s => s.round || s.makeup);
  }
  if (!list.length) return '';
  return panel(
    iso === today ? '今日の授業' : `次の授業 ${dayLabel(iso)}`,
    `<ul class="tasklist">${list
      .map(s => {
        const info = sessionInfo(s.i, s.round);
        if (s.makeup)
          return `<li><div class="task"><span class="task-main"><span class="task-title">${s.period ? `${s.period}限 ` : ''}${esc(courses[s.i])}</span><span class="meta">補講${s.room ? ` · ${esc(s.room)}` : ''}</span></span><span class="right"><span class="label mode-makeup">補講</span></span></div></li>`;
        const mats = roundMaterials(s.i, s.round),
          extra = [
            info.zoom
              ? `<a href="${esc(info.zoom)}" target="_blank" rel="noopener">Zoom</a>${info.pass ? ` パスコード <code>${esc(info.pass)}</code>` : ''}`
              : '',
            ...mats.map(m => (typeof materialLink === 'function' ? materialLink(m) : esc(m.name))),
            typeof manaboLink === 'function' ? manaboLink(s.i, 'manabo') : ''
          ].filter(Boolean);
        return `<li><button class="task" data-session="${s.i}:${s.round}"><span class="task-main"><span class="task-title">${s.period ? `${s.period}限 ` : ''}${esc(courses[s.i])}</span><span class="meta">第${s.round}回${info.room ? ` · ${esc(info.room)}` : ''}</span></span><span class="right">${modeLabel(info.mode)}${markLabel(info.attendance)}</span></button>${extra.length ? `<div class="materials" style="padding:2px 12px 8px">${extra.join(' ')}</div>` : ''}</li>`;
      })
      .join('')}</ul>`,
    {flush: true, tools: '<button class="linklike" data-view="timetable">時間割へ</button>'}
  );
}
const options = (list, cur, blank) =>
  `<option value="">${blank}</option>${list.map(v => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('')}`;
function openSession(i, r) {
  const dates = courseDates(i),
    cfg = courseConfig(i),
    s = session(i, r);
  const official = sessionInfo(i, r).official;
  openDrawer(
    `${courses[i]} 第${r}回`,
    `${official ? `<div class="alert ${official === '休講' ? 'alert-warning' : 'alert-info'}">CUBICS：この回は${esc(official)}です</div>` : ''}<p class="drawer-label">${dates[r] ? dayLabel(dates[r]) : '日付未設定'}${cfg.weekday ? ` · ${esc(cfg.weekday)}曜${cfg.period ? ` ${cfg.period}限` : ''}` : ''}</p><div class="field"><label for="ss-mode">授業形式</label><select class="form-control" id="ss-mode">${options(
      MODES,
      s.mode,
      (() => {
        const p = plannedMode(i, +r);
        return p ? `資料の記載（${p.mode}）` : `授業の既定（${cfg.mode || '未設定'}）`;
      })()
    )}</select><small>休講を選ぶと出席の集計から外れます。${(() => {
      const p = plannedMode(i, +r);
      return p ? `<span style="display:block">${esc(p.file)}：「${esc(p.evidence)}」</span>` : '';
    })()}</small></div><div class="field"><label for="ss-room">教室</label><input class="form-control" id="ss-room" value="${esc(s.room || '')}" placeholder="授業の既定（${esc(cfg.room || '未設定')}）"></div><div class="field"><label for="ss-att">出席</label><select class="form-control" id="ss-att">${options(MARKS, s.attendance, '未記録')}</select></div><div class="field"><label for="ss-note">メモ</label><input class="form-control" id="ss-note" value="${esc(s.note || '')}" maxlength="200"></div><div class="actions"><button class="btn btn-primary" id="ss-save">保存</button><button class="btn" id="ss-course">授業の設定を変更</button>${typeof manaboLink === 'function' ? manaboLink(i, 'manabo で開く', 'btn') : ''}</div>`,
    'ss-att',
    `session:${i}.${r}`
  );
  const val = id => document.getElementById(id).value;
  document.getElementById('ss-save').onclick = () => {
    saveTimetable({
      course: courses[i],
      round: r,
      values: {
        mode: val('ss-mode'),
        room: val('ss-room').trim(),
        attendance: val('ss-att'),
        note: val('ss-note').trim()
      }
    });
    close(true);
    toast('保存しました');
  };
  document.getElementById('ss-course').onclick = () => openCourseConfig(i);
}
function openCourseConfig(i) {
  const own = state.timetable?.[courses[i]] || {},
    cfg = courseConfig(i);
  openDrawer(
    `${courses[i]} の設定`,
    `${infoRows(i)}<h3>自分で設定する</h3><div class="field"><label for="cc-weekday">曜日</label><select class="form-control" id="cc-weekday">${options(WEEKDAYS, own.weekday, cfg.auto ? `${cfg.slotFrom} から取得（${cfg.weekday}曜）` : '未設定')}</select></div><div class="field"><label for="cc-period">時限</label><select class="form-control" id="cc-period"><option value="">${cfg.auto && cfg.period ? `${cfg.slotFrom} から取得（${cfg.period}限）` : '未設定'}</option>${[1, 2, 3, 4, 5, 6, 7].map(p => `<option value="${p}"${own.period === p ? ' selected' : ''}>${p}限</option>`).join('')}</select></div><div class="field"><label for="cc-room">教室</label><input class="form-control" id="cc-room" value="${esc(own.room || '')}" placeholder="例：0803"></div><div class="field"><label for="cc-mode">授業形式（既定）</label><select class="form-control" id="cc-mode">${options(MODES.slice(0, 3), own.mode, cfg.autoMode ? `自動（${cfg.autoMode}）` : '未設定')}</select><small>回ごとに違う場合は、時間割でその回を選んで変更します。</small></div><div class="field"><label for="cc-limit">欠席の上限（回）</label><input class="form-control" id="cc-limit" type="number" min="0" max="15" value="${own.limit ?? ''}" style="max-width:120px"><small>シラバスや初回の説明で確認した回数を入れると、出席状況で残りを表示します。</small></div>${state.features?.includes('aipolicy') ? `<div class="field"><label for="cc-ai">AI の利用</label><select class="form-control" id="cc-ai"><option value="">自動（回ごとに、その回の授業資料から判断）</option><option value="禁止"${own.ai === '禁止' ? ' selected' : ''}>全回 禁止（saboro から提出しない）</option><option value="許可"${own.ai === '許可' ? ' selected' : ''}>全回 許可（自動で作成・提出）</option></select></div>` : ''}<div class="actions"><button class="btn btn-primary" id="cc-save">保存</button></div>`,
    'cc-room',
    `course:${i}`
  );
  const val = id => document.getElementById(id).value;
  document.getElementById('cc-save').onclick = () => {
    const limit = val('cc-limit');
    saveTimetable({
      course: courses[i],
      values: {
        weekday: val('cc-weekday'),
        period: val('cc-period') ? +val('cc-period') : null,
        room: val('cc-room').trim(),
        mode: val('cc-mode'),
        limit: limit === '' ? null : Math.max(0, Math.min(15, Math.round(+limit))),
        ...(document.getElementById('cc-ai') ? {ai: val('cc-ai')} : {})
      }
    });
    close(true);
    toast('保存しました');
  };
}
function openAttendance(i) {
  const dates = courseDates(i),
    rounds = Object.keys(dates)
      .map(Number)
      .sort((a, b) => a - b),
    today = todayISO();
  openDrawer(
    `${courses[i]} の出席`,
    rounds.length
      ? `<table class="table-default"><thead><tr><th scope="col">回</th><th scope="col">日付</th><th scope="col">形式</th><th scope="col">出席</th></tr></thead><tbody>${rounds
          .map(r => {
            const info = sessionInfo(i, r);
            return `<tr><td>第${r}回</td><td>${dayLabel(dates[r])}</td><td>${modeLabel(info.mode) || '<span class="muted">—</span>'}</td><td>${info.mode === '休講' ? '<span class="muted">休講</span>' : `<select class="form-control" data-mark="${r}" aria-label="第${r}回の出席"${dates[r] > today && !info.attendance ? ' style="color:#767676"' : ''}>${options(MARKS, session(i, r).attendance, '未記録')}</select>`}</td></tr>`;
          })
          .join('')}</tbody></table><p class="muted" style="margin-top:10px">選ぶとすぐに保存されます。</p>`
      : '<p class="muted">曜日が未設定のため、授業日が分かりません。時間割の「授業の設定」で曜日を設定してください。</p>',
    undefined,
    `att:${i}`
  );
  document.querySelectorAll('[data-mark]').forEach(
    e =>
      (e.onchange = () => {
        saveTimetable({course: courses[i], round: +e.dataset.mark, values: {attendance: e.value}});
        openAttendance(i);
      })
  );
}
function bindTimetable() {
  document.querySelectorAll('[data-week]').forEach(
    e =>
      (e.onclick = () => {
        weekOffset = +e.dataset.week === 0 ? 0 : weekOffset + +e.dataset.week;
        render();
      })
  );
  document.querySelectorAll('[data-session]').forEach(
    e =>
      (e.onclick = () => {
        const [i, r] = e.dataset.session.split(':').map(Number);
        openSession(i, r);
      })
  );
  document
    .querySelectorAll('[data-coursecfg]')
    .forEach(e => (e.onclick = () => openCourseConfig(+e.dataset.coursecfg)));
  document
    .querySelectorAll('[data-attendance]')
    .forEach(e => (e.onclick = () => openAttendance(+e.dataset.attendance)));
}
render();
