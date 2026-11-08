// Variables used by Scriptable. These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: yensign.circle;

/**
 * 打工人现金流 · iPhone 桌面 / 锁屏小组件（Scriptable 单文件脚本）
 *
 * 与网页版 https://la88cy88.github.io/cashflow/ 使用完全相同的计算模型：
 *   今日实时工资 = 今日工资 × 已完成有效工作毫秒 ÷ 有效工作总毫秒
 * 每次小组件刷新都用 Date.now() 现场重算，不累加、不缓存金额。
 * 因此锁屏、重启、跨天、跨时区后看到的数字都是那一刻的正确值。
 *
 * 支持尺寸：
 *   主屏幕  small / medium / large / extraLarge
 *   锁屏    accessoryRectangular / accessoryCircular / accessoryInline（iOS 16+，含 iOS 27）
 *
 * 数据来源（三选一，按优先级）：
 *   1. 网页版「同步到小组件」按钮通过 URL scheme 推送今日计划
 *   2. 在 Scriptable 里直接运行本脚本，用表单编辑今日计划
 *   3. 脚本顶部 INITIAL_DEFAULT 里的内置默认计划
 * 计划保存在 Scriptable 自己的文档目录，不联网、不上传。
 *
 * 注意：小组件刷新由 iOS 决定（通常几分钟一次），数字不会像网页版那样每帧跳动；
 *       但每次刷新都是精确值，并且「距下班」用系统计时器持续走动。
 */

const PWA_URL = 'https://la88cy88.github.io/cashflow/';
const SYNC_PREFIX = 'CFLOW1:';
const STATE_FILE = 'cashflow-widget-state.json';
const REFRESH_MS = 60 * 1000; // 请求 1 分钟后刷新，实际由系统调度
const KEEP_DAYS = 400;
const USE_ACCESSORY_BACKGROUND = true;

/** 首次使用、且没有同步过网页版计划时的兜底计划 */
const INITIAL_DEFAULT = {
  salary: 300,
  startTime: '08:30',
  endTime: '17:30',
  breakMinutes: 0,
  breakStart: '12:00'
};

const STATUS_LABEL = {
  before: '准备上班',
  working: '正在努力赚钱',
  break: '午休中 · 暂停计薪',
  done: '今日工资到账',
  invalid: '请先检查今日计划'
};

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/* ==================================================================
   1. 时间工具 —— 只存「日期键 + 钟表时间」，每次按设备本地时区现场解析
   ================================================================== */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateKeyOf(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dateKeyOfTs(ts) {
  return dateKeyOf(new Date(ts));
}

function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key == null ? '' : key));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function shiftDateKey(key, days) {
  const dt = parseDateKey(key);
  if (!dt) return null;
  dt.setDate(dt.getDate() + days);
  return dateKeyOf(dt);
}

function parseClock(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function canonicalClock(value) {
  const p = parseClock(value);
  return p ? `${pad2(p.hour)}:${pad2(p.minute)}` : null;
}

function atClock(dateKey, clock, dayOffset) {
  const base = parseDateKey(dateKey);
  const t = parseClock(clock);
  const off = dayOffset || 0;
  if (!base || !t) return null;
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + off,
    t.hour,
    t.minute,
    0,
    0
  ).getTime();
}

function clockOfTs(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / SECOND_MS));
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
}

function formatMoney(value, decimals) {
  const digits = decimals == null ? 6 : decimals;
  const n = Number.isFinite(value) ? Math.max(0, value) : 0;
  return n.toFixed(digits);
}

/* ==================================================================
   2. 计算引擎 —— 与 js/engine.js 逐行等价（纯函数，可注入 now 以便测试）
   ================================================================== */

function normalizePlan(raw) {
  const src = Object.assign(
    { date: '', salary: 300, startTime: '08:30', endTime: '17:30', breakMinutes: 0, breakStart: '12:00' },
    raw || {}
  );
  const errors = [];
  const date = String(src.date == null ? '' : src.date);
  if (!parseDateKey(date)) errors.push('日期无效');

  const salary = Number(src.salary);
  if (!Number.isFinite(salary) || salary <= 0) errors.push('今日工资必须是大于 0 的数字');
  else if (salary > 1e9) errors.push('今日工资数值过大');

  const startTime = canonicalClock(src.startTime);
  const endTime = canonicalClock(src.endTime);
  const breakStart = canonicalClock(src.breakStart == null ? '12:00' : src.breakStart);
  if (!startTime) errors.push('上班时间格式无效（应为 HH:mm）');
  if (!endTime) errors.push('下班时间格式无效（应为 HH:mm）');
  if (!breakStart) errors.push('午休开始时间格式无效（应为 HH:mm）');

  const breakMinutes = Number(src.breakMinutes);
  if (!Number.isFinite(breakMinutes) || breakMinutes < 0 || !Number.isInteger(breakMinutes)) {
    errors.push('午休时长必须是非负整数分钟');
  } else if (breakMinutes > 24 * 60) {
    errors.push('午休时长不能超过 24 小时');
  }

  if (errors.length) return { ok: false, errors: errors, plan: null };
  return {
    ok: true,
    errors: [],
    plan: {
      date: date,
      salary: salary,
      startTime: startTime,
      endTime: endTime,
      breakStart: breakStart,
      breakMinutes: Math.trunc(breakMinutes)
    }
  };
}

function buildSchedule(rawPlan) {
  const norm = normalizePlan(rawPlan);
  if (!norm.ok) return { ok: false, errors: norm.errors, reason: 'invalid', warnings: [] };
  const p = norm.plan;

  const startTs = atClock(p.date, p.startTime, 0);
  let endTs = atClock(p.date, p.endTime, 0);
  const crossesMidnight = endTs <= startTs;
  if (crossesMidnight) endTs = atClock(p.date, p.endTime, 1);

  const warnings = [];
  let breakRange = null;

  if (p.breakMinutes > 0) {
    let b1 = atClock(p.date, p.breakStart, 0);
    if (b1 < startTs) b1 = atClock(p.date, p.breakStart, 1);
    if (b1 >= endTs) {
      const earlier = atClock(p.date, p.breakStart, -1);
      if (earlier >= startTs && earlier < endTs) b1 = earlier;
    }
    if (b1 >= startTs && b1 < endTs) {
      const wantedEnd = b1 + p.breakMinutes * MINUTE_MS;
      const b2 = Math.min(wantedEnd, endTs);
      if (b2 > b1) breakRange = [b1, b2];
      if (b2 < wantedEnd) warnings.push('午休超出下班时间，已截断');
    } else {
      warnings.push('午休不在工作时段内，已忽略');
    }
  }

  const segments = [];
  if (!breakRange) {
    segments.push([startTs, endTs]);
  } else {
    if (breakRange[0] > startTs) segments.push([startTs, breakRange[0]]);
    if (breakRange[1] < endTs) segments.push([breakRange[1], endTs]);
  }

  let totalEffectiveMs = 0;
  for (const seg of segments) totalEffectiveMs += seg[1] - seg[0];
  if (totalEffectiveMs <= 0) {
    return {
      ok: false,
      errors: ['有效工作时长为 0，请检查上下班时间与午休设置'],
      reason: 'zero-duration',
      plan: p,
      startTs,
      endTs,
      crossesMidnight,
      breakRange,
      segments,
      totalEffectiveMs: 0,
      warnings
    };
  }

  return {
    ok: true,
    errors: [],
    reason: 'ok',
    plan: p,
    startTs,
    endTs,
    crossesMidnight,
    breakRange,
    segments,
    totalEffectiveMs,
    warnings
  };
}

function calculate(rawPlan, now) {
  const at = now == null ? Date.now() : now;
  const s = buildSchedule(rawPlan);
  if (!s.ok) {
    return {
      ok: false,
      errors: s.errors,
      reason: s.reason,
      now: at,
      earned: 0,
      salary: Number(rawPlan && rawPlan.salary) || 0,
      percent: 0,
      ratio: 0,
      elapsedMs: 0,
      remainingMs: 0,
      totalEffectiveMs: 0,
      perMillisecond: 0,
      perSecond: 0,
      perMinute: 0,
      perHour: 0,
      status: 'invalid',
      warnings: s.warnings || [],
      plan: s.plan || null,
      startTs: 0,
      endTs: 0,
      crossesMidnight: false
    };
  }

  const totalEffectiveMs = s.totalEffectiveMs;
  const salary = s.plan.salary;
  let elapsedMs = 0;
  for (const seg of s.segments) {
    if (at > seg[0]) elapsedMs += Math.min(at, seg[1]) - seg[0];
  }
  elapsedMs = Math.max(0, Math.min(totalEffectiveMs, elapsedMs));

  const ratio = elapsedMs / totalEffectiveMs;
  let earned = ratio <= 0 ? 0 : ratio >= 1 ? salary : salary * ratio;
  earned = Math.max(0, Math.min(salary, earned));

  let status;
  if (at < s.startTs) status = 'before';
  else if (at >= s.endTs) status = 'done';
  else if (s.breakRange && at >= s.breakRange[0] && at < s.breakRange[1]) status = 'break';
  else status = 'working';

  const perMillisecond = salary / totalEffectiveMs;
  return {
    ok: true,
    errors: [],
    reason: 'ok',
    now: at,
    earned,
    salary,
    percent: ratio * 100,
    ratio,
    elapsedMs,
    remainingMs: totalEffectiveMs - elapsedMs,
    totalEffectiveMs,
    perMillisecond,
    perSecond: perMillisecond * SECOND_MS,
    perMinute: perMillisecond * MINUTE_MS,
    perHour: perMillisecond * HOUR_MS,
    status,
    startTs: s.startTs,
    endTs: s.endTs,
    crossesMidnight: s.crossesMidnight,
    warnings: s.warnings,
    plan: s.plan
  };
}

/* ==================================================================
   3. 本地状态 —— Scriptable 文档目录里的一个 JSON 文件
   ================================================================== */

function fileManager() {
  try {
    const fm = FileManager.local();
    if (fm.documentsDirectory()) return fm;
  } catch (e) {
    /* 某些系统下 local() 不可用，退回 iCloud */
  }
  try {
    return FileManager.iCloud();
  } catch (e) {
    return null;
  }
}

function emptyState() {
  return {
    version: 1,
    defaultPlan: Object.assign({}, INITIAL_DEFAULT),
    plans: {},
    updatedAt: 0
  };
}

function sanitizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  const def = normalizePlan(Object.assign({ date: '2000-01-01' }, raw.defaultPlan));
  if (def.ok) {
    state.defaultPlan = {
      salary: def.plan.salary,
      startTime: def.plan.startTime,
      endTime: def.plan.endTime,
      breakMinutes: def.plan.breakMinutes,
      breakStart: def.plan.breakStart
    };
  }
  if (raw.plans && typeof raw.plans === 'object' && !Array.isArray(raw.plans)) {
    for (const key of Object.keys(raw.plans)) {
      if (!parseDateKey(key)) continue;
      const n = normalizePlan(Object.assign({}, raw.plans[key], { date: key }));
      if (n.ok) state.plans[key] = n.plan;
    }
  }
  state.updatedAt = Number(raw.updatedAt) || 0;
  return state;
}

function readState() {
  const fm = fileManager();
  if (!fm) return emptyState();
  try {
    const path = fm.joinPath(fm.documentsDirectory(), STATE_FILE);
    if (!fm.fileExists(path)) return emptyState();
    return sanitizeState(JSON.parse(fm.readString(path)));
  } catch (e) {
    return emptyState();
  }
}

function writeState(state) {
  const fm = fileManager();
  if (!fm) return false;
  try {
    const path = fm.joinPath(fm.documentsDirectory(), STATE_FILE);
    state.updatedAt = Date.now();
    fm.writeString(path, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

function pruneState(state, now) {
  const cutoff = shiftDateKey(dateKeyOfTs(now), -KEEP_DAYS);
  if (!cutoff) return;
  for (const key of Object.keys(state.plans)) {
    if (key < cutoff) delete state.plans[key];
  }
}

/** 与网页版一致：跨午夜班次未结束时，凌晨仍归属前一天 */
function resolveActiveDateKey(state, now) {
  const todayKey = dateKeyOfTs(now);
  const yesterdayKey = shiftDateKey(todayKey, -1);
  const yesterday = state.plans[yesterdayKey];
  if (yesterday) {
    const s = buildSchedule(yesterday);
    if (s.ok && s.crossesMidnight && now >= s.startTs && now < s.endTs) return yesterdayKey;
  }
  return todayKey;
}

function ensurePlan(state, dateKey) {
  if (!state.plans[dateKey]) {
    state.plans[dateKey] = Object.assign({}, state.defaultPlan, { date: dateKey });
    pruneState(state, Date.now());
    writeState(state);
  }
  return state.plans[dateKey];
}

function snapshot(now) {
  const state = readState();
  const dateKey = resolveActiveDateKey(state, now);
  const plan = ensurePlan(state, dateKey);
  return { state, dateKey, plan, result: calculate(plan, now) };
}

/* ==================================================================
   4. 视觉：颜色、字体、通用组件
   ================================================================== */

function color(hex, alpha) {
  return alpha == null ? new Color(hex) : new Color(hex, alpha);
}

function dynamic(lightHex, darkHex) {
  return Color.dynamic(color(lightHex), color(darkHex));
}

const PALETTE = {
  bgTop: dynamic('#FFFFFF', '#14231A'),
  bgBottom: dynamic('#EAF5ED', '#0C1710'),
  text: dynamic('#0D1B13', '#F3F8F4'),
  sub: dynamic('#64756A', '#9DB1A4'),
  green: dynamic('#128A46', '#4ADE80'),
  greenSoft: dynamic('#DFF3E6', '#1E3A29'),
  track: dynamic('#DDE8E0', '#26382D'),
  card: dynamic('#FFFFFF', '#1B2A20')
};

const LOCK_TEXT = color('#FFFFFF');
const LOCK_SUB = color('#FFFFFF', 0.68);
const LOCK_GREEN = color('#5BE58C');
const LOCK_TRACK = color('#FFFFFF', 0.22);

function setText(node, str, opts) {
  const o = opts || {};
  node.font = o.font || Font.systemFont(12);
  node.textColor = o.color || PALETTE.text;
  if (o.opacity != null) node.textOpacity = o.opacity;
  node.minimumScaleFactor = o.scale == null ? 0.6 : o.scale;
  node.lineLimit = o.lines == null ? 1 : o.lines;
  if (o.align === 'center') node.centerAlignText();
  else if (o.align === 'right') node.rightAlignText();
  else node.leftAlignText();
  return node;
}

function addText(parent, str, opts) {
  return setText(parent.addText(str), str, opts);
}

/** 用两个嵌套 stack 画一条圆角进度条 */
function addProgressBar(parent, ratio, width, height, fillColor, trackColor) {
  const bar = parent.addStack();
  bar.layoutHorizontally();
  bar.size = new Size(width, height);
  bar.backgroundColor = trackColor;
  bar.cornerRadius = height / 2;
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = bar.addStack();
  const w = clamped <= 0 ? 0 : Math.max(height, width * clamped);
  filled.size = new Size(Math.min(w, width), height);
  filled.backgroundColor = fillColor;
  filled.cornerRadius = height / 2;
  return bar;
}

function statusIcon(status) {
  if (status === 'done') return '🎉';
  if (status === 'break') return '🍵';
  if (status === 'before') return '☕';
  if (status === 'invalid') return '⚠️';
  return '💪';
}

function money(result, decimals) {
  return `¥${formatMoney(result.earned, decimals)}`;
}

/* ==================================================================
   5. 主屏幕小组件：small / medium / large / extraLarge
   ================================================================== */

function buildHomeWidget(snap, family) {
  const r = snap.result;
  const w = new ListWidget();
  const grad = new LinearGradient();
  grad.colors = [PALETTE.bgTop, PALETTE.bgBottom];
  grad.locations = [0, 1];
  w.backgroundGradient = grad;
  w.url = PWA_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MS);

  const large = family === 'large' || family === 'extraLarge';
  const medium = family === 'medium' || large;
  const pad = large ? 20 : medium ? 16 : 13;
  w.setPadding(pad, pad, pad, pad);
  w.spacing = 4;

  /* 顶部：状态 + 日期 */
  const head = w.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  addText(head, `${statusIcon(r.status)}  ${STATUS_LABEL[r.status] || ''}`, {
    font: Font.semiboldSystemFont(medium ? 12 : 10),
    color: PALETTE.green
  });
  head.addSpacer(null);
  addText(head, `${snap.dateKey.slice(5)}${r.crossesMidnight ? ' 跨日班' : ''}`, {
    font: Font.systemFont(medium ? 11 : 9),
    color: PALETTE.sub,
    align: 'right'
  });

  w.addSpacer(large ? 12 : null);

  /* 核心金额 */
  addText(w, money(r, 6), {
    font: Font.boldMonospacedSystemFont(large ? 40 : medium ? 33 : 21),
    color: PALETTE.text,
    scale: 0.42
  });

  if (!r.ok) {
    addText(w, r.errors[0] || '计划无效', {
      font: Font.systemFont(11),
      color: PALETTE.sub,
      lines: 2,
      scale: 0.7
    });
    return w;
  }

  const meta = w.addStack();
  meta.layoutHorizontally();
  addText(meta, `目标 ¥${formatMoney(r.salary, 2)}`, {
    font: Font.systemFont(medium ? 11 : 9),
    color: PALETTE.sub
  });
  meta.addSpacer(null);
  addText(meta, `${r.percent.toFixed(2)}%`, {
    font: Font.semiboldMonospacedSystemFont(medium ? 13 : 10),
    color: PALETTE.green,
    align: 'right'
  });

  w.addSpacer(medium ? 7 : 4);
  const barWidth = large ? 300 : medium ? 290 : 130;
  addProgressBar(w, r.ratio, barWidth, medium ? 8 : 6, PALETTE.green, PALETTE.track);
  w.addSpacer(medium ? 9 : 5);

  /* 关键：系统计时器由 iOS 持续更新，不需要脚本刷新 */
  const timeRow = w.addStack();
  timeRow.layoutHorizontally();
  timeRow.centerAlignContent();
  addText(timeRow, r.status === 'done' ? '已完成' : '距下班', {
    font: Font.systemFont(medium ? 11 : 9),
    color: PALETTE.sub
  });
  timeRow.addSpacer(4);
  if (r.status === 'done' || r.status === 'invalid') {
    addText(timeRow, formatDuration(r.elapsedMs), {
      font: Font.mediumMonospacedSystemFont(medium ? 13 : 10),
      color: PALETTE.text
    });
  } else {
    const timer = timeRow.addDate(new Date(r.endTs));
    timer.applyTimerStyle();
    timer.font = Font.mediumMonospacedSystemFont(medium ? 13 : 10);
    timer.textColor = PALETTE.text;
  }
  timeRow.addSpacer(null);
  addText(timeRow, `已工作 ${formatDuration(r.elapsedMs).slice(0, 5)}`, {
    font: Font.systemFont(medium ? 11 : 9),
    color: PALETTE.sub,
    align: 'right'
  });

  if (medium) {
    w.addSpacer(null);
    const strip = w.addStack();
    strip.layoutHorizontally();
    strip.setPadding(9, 11, 9, 11);
    strip.backgroundColor = PALETTE.card;
    strip.cornerRadius = 12;
    const cells = large
      ? [
          ['时薪', `¥${formatMoney(r.perHour, 2)}`],
          ['每分钟', `¥${formatMoney(r.perMinute, 4)}`],
          ['每秒', `¥${formatMoney(r.perSecond, 4)}`],
          ['班次', `${r.plan.startTime}–${r.plan.endTime}`]
        ]
      : [
          ['时薪', `¥${formatMoney(r.perHour, 2)}`],
          ['每分钟', `¥${formatMoney(r.perMinute, 4)}`],
          ['班次', `${r.plan.startTime}–${r.plan.endTime}`]
        ];
    for (let i = 0; i < cells.length; i += 1) {
      if (i > 0) strip.addSpacer(null);
      const cell = strip.addStack();
      cell.layoutVertically();
      cell.centerAlignContent();
      addText(cell, cells[i][0], { font: Font.systemFont(9), color: PALETTE.sub, align: 'center' });
      addText(cell, cells[i][1], {
        font: Font.semiboldMonospacedSystemFont(11),
        color: PALETTE.text,
        align: 'center',
        scale: 0.6
      });
    }
  }

  addText(w, `按真实时间重算 · 更新于 ${clockOfTs(Date.now())}`, {
    font: Font.systemFont(large ? 9 : 8),
    color: PALETTE.sub,
    opacity: 0.85,
    align: 'right'
  });
  return w;
}

/* ==================================================================
   6. 锁屏小组件（iOS 16+ / iOS 27）：矩形、圆形、内联
   ================================================================== */

function accessoryBase() {
  const w = new ListWidget();
  w.url = PWA_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MS);
  if (USE_ACCESSORY_BACKGROUND) {
    try {
      w.addAccessoryWidgetBackground = true;
    } catch (e) {
      /* 旧版 Scriptable 没有该属性，忽略即可 */
    }
  }
  return w;
}

function buildRectangular(snap) {
  const r = snap.result;
  const w = accessoryBase();
  w.setPadding(2, 4, 2, 4);
  w.spacing = 5;

  const top = w.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  addText(top, money(r, 4), {
    font: Font.boldMonospacedSystemFont(17),
    color: LOCK_TEXT,
    scale: 0.55
  });
  top.addSpacer(null);
  addText(top, `${r.percent.toFixed(1)}%`, {
    font: Font.semiboldMonospacedSystemFont(13),
    color: LOCK_GREEN,
    align: 'right'
  });

  const bottom = w.addStack();
  bottom.layoutHorizontally();
  bottom.centerAlignContent();
  bottom.addSpacer(null);
  addProgressBar(bottom, r.ratio, 84, 5, LOCK_GREEN, LOCK_TRACK);
  bottom.addSpacer(8);
  addText(bottom, r.ok ? `${statusIcon(r.status)} ${STATUS_LABEL[r.status]}` : '计划待修正', {
    font: Font.systemFont(10),
    color: LOCK_SUB,
    align: 'right',
    scale: 0.7
  });
  return w;
}

function buildCircular(snap) {
  const r = snap.result;
  const w = accessoryBase();
  w.setPadding(0, 0, 0, 0);
  w.spacing = 1;
  w.addSpacer(null);
  addText(w, `${Math.round(r.percent)}%`, {
    font: Font.boldMonospacedSystemFont(21),
    color: LOCK_TEXT,
    align: 'center',
    scale: 0.6
  });
  addText(w, money(r, 2), {
    font: Font.mediumMonospacedSystemFont(11),
    color: LOCK_GREEN,
    align: 'center',
    scale: 0.6
  });
  addText(w, r.ok ? STATUS_LABEL[r.status].replace('正在努力赚钱', '赚钱中') : '待设置', {
    font: Font.systemFont(9),
    color: LOCK_SUB,
    align: 'center',
    scale: 0.7
  });
  w.addSpacer(null);
  return w;
}

function buildInline(snap) {
  const r = snap.result;
  const w = accessoryBase();
  /* 内联尺寸只能放「一个图片 + 一行文字」，多余元素会被系统过滤 */
  try {
    const symbol = SFSymbol.named('yensign.circle.fill');
    if (symbol) {
      const img = w.addImage(symbol.image);
      img.imageSize = new Size(13, 13);
      img.tintColor = LOCK_TEXT;
    }
  } catch (e) {
    /* 拿不到 SF Symbol 时只显示文字 */
  }
  addText(w, `${money(r, 2)} · 已赚 ${r.percent.toFixed(1)}% · ${STATUS_LABEL[r.status] || ''}`, {
    font: Font.mediumMonospacedSystemFont(11),
    color: LOCK_TEXT,
    scale: 0.7
  });
  return w;
}

function buildWidget(familyOverride, now) {
  const at = now == null ? Date.now() : now;
  const snap = snapshot(at);
  const family = familyOverride || (config.runsInWidget ? config.widgetFamily : 'medium');
  if (family === 'accessoryInline') return buildInline(snap);
  if (family === 'accessoryCircular') return buildCircular(snap);
  if (family === 'accessoryRectangular') return buildRectangular(snap);
  return buildHomeWidget(snap, family);
}

/* ==================================================================
   7. 与网页版同步：URL scheme / 剪贴板导入
   ================================================================== */

function decodeSyncPayload(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let text = raw;
  if (text.indexOf(SYNC_PREFIX) === 0) text = text.slice(SYNC_PREFIX.length);
  try {
    text = decodeURIComponent(text);
  } catch (e) {
    /* args.queryParameters 可能已经解码过 */
  }
  try {
    const data = JSON.parse(text);
    if (!data || data.v !== 1 || !parseDateKey(data.date)) return null;
    const plan = normalizePlan(Object.assign({}, data.plan, { date: data.date }));
    if (!plan.ok) return null;
    const out = { date: data.date, plan: plan.plan, defaultPlan: null };
    if (data.defaultPlan) {
      const def = normalizePlan(Object.assign({}, data.defaultPlan, { date: data.date }));
      if (def.ok) {
        out.defaultPlan = {
          salary: def.plan.salary,
          startTime: def.plan.startTime,
          endTime: def.plan.endTime,
          breakMinutes: def.plan.breakMinutes,
          breakStart: def.plan.breakStart
        };
      }
    }
    return out;
  } catch (e) {
    return null;
  }
}

function applySync(payload) {
  const state = readState();
  state.plans[payload.date] = payload.plan;
  if (payload.defaultPlan) state.defaultPlan = payload.defaultPlan;
  pruneState(state, Date.now());
  return writeState(state);
}

function queryParameters() {
  try {
    return args.queryParameters || {};
  } catch (e) {
    return {};
  }
}

async function showSyncResult(payload, saved) {
  const a = new Alert();
  a.title = saved ? '✓ 今日计划已同步' : '⚠️ 同步未保存';
  a.message = saved
    ? `${payload.date}\n今日工资 ¥${formatMoney(payload.plan.salary, 2)}\n${payload.plan.startTime} – ${payload.plan.endTime}${
        payload.plan.breakMinutes ? ` · 午休 ${payload.plan.breakMinutes} 分钟` : ''
      }\n\n小组件会在系统下次刷新后更新。`
    : '无法写入 Scriptable 文档目录，请检查 Scriptable 的存储权限。';
  a.addAction('返回网页版');
  a.addAction('预览小组件');
  a.addCancelAction('完成');
  const idx = await a.present();
  if (idx === 0) openPWA();
  if (idx === 1) {
    try {
      await buildWidget('medium').presentMedium();
    } catch (e) {
      /* 预览失败不影响同步结果 */
    }
  }
}

function openPWA() {
  try {
    Safari.open(PWA_URL);
  } catch (e) {
    try {
      Safari.openInApp(PWA_URL, false);
    } catch (e2) {
      /* 环境不支持时用户可手动切回浏览器 */
    }
  }
}

async function handleUrlSync() {
  const q = queryParameters();
  if (!q.cflow && q.edit !== '1') return false;
  if (q.cflow) {
    const payload = decodeSyncPayload(q.cflow);
    if (payload) {
      const saved = applySync(payload);
      await showSyncResult(payload, saved);
      return true;
    }
    const bad = new Alert();
    bad.title = '同步码无法识别';
    bad.message = '请回到网页版「小组件」页，重新点一次「同步到小组件」。';
    bad.addAction('返回网页版');
    bad.addCancelAction('完成');
    const i = await bad.present();
    if (i === 0) openPWA();
    return true;
  }
  return false;
}

function readClipboardSync() {
  try {
    return decodeSyncPayload(Pasteboard.pasteString());
  } catch (e) {
    return null;
  }
}

/* ==================================================================
   8. 在 Scriptable App 里运行：今日计划编辑器
   ================================================================== */

async function alertMessage(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction('好');
  await a.present();
}

async function runEditor() {
  const state = readState();
  const dateKey = resolveActiveDateKey(state, Date.now());
  const plan = ensurePlan(state, dateKey);

  const a = new Alert();
  a.title = `今日计划 · ${dateKey}`;
  a.message = '修改后只对小组件生效。想和网页版保持一致，请用网页版「小组件」页的「同步到小组件」。';
  a.addTextField('今日工资（元）', String(plan.salary));
  a.addTextField('上班时间 HH:mm', plan.startTime);
  a.addTextField('下班时间 HH:mm', plan.endTime);
  a.addTextField('午休分钟（0 = 不休息）', String(plan.breakMinutes));
  a.addTextField('午休开始 HH:mm', plan.breakStart);
  a.addAction('保存今日计划');
  a.addAction('保存并设为默认');
  a.addAction('从剪贴板导入同步码');
  a.addAction('预览小组件');
  a.addCancelAction('取消');
  const idx = await a.present();
  if (idx < 0 || idx === 3) {
    if (idx === 3) {
      try {
        await buildWidget('medium').presentMedium();
      } catch (e) {
        /* 忽略预览异常 */
      }
    }
    return;
  }

  if (idx === 2) {
    const payload = readClipboardSync();
    if (!payload) {
      await alertMessage('未找到同步码', '请先在网页版「小组件」页点「复制同步码」，再回来点这个按钮。');
      return;
    }
    const saved = applySync(payload);
    await alertMessage(
      saved ? '✓ 已导入' : '⚠️ 未能保存',
      saved
        ? `${payload.date} · ¥${formatMoney(payload.plan.salary, 2)} · ${payload.plan.startTime}–${payload.plan.endTime}`
        : '无法写入 Scriptable 文档目录。'
    );
    return;
  }

  const input = {
    date: dateKey,
    salary: a.textFieldValue(0),
    startTime: a.textFieldValue(1),
    endTime: a.textFieldValue(2),
    breakMinutes: a.textFieldValue(3),
    breakStart: a.textFieldValue(4)
  };
  const norm = normalizePlan(input);
  if (!norm.ok) {
    await alertMessage('计划不合法', norm.errors.join('\n'));
    return;
  }
  const schedule = buildSchedule(norm.plan);
  if (!schedule.ok) {
    await alertMessage('计划不合法', schedule.errors.join('\n'));
    return;
  }

  const fresh = readState();
  fresh.plans[dateKey] = norm.plan;
  if (idx === 1) {
    fresh.defaultPlan = {
      salary: norm.plan.salary,
      startTime: norm.plan.startTime,
      endTime: norm.plan.endTime,
      breakMinutes: norm.plan.breakMinutes,
      breakStart: norm.plan.breakStart
    };
  }
  pruneState(fresh, Date.now());
  const saved = writeState(fresh);
  await alertMessage(
    saved ? '✓ 已保存' : '⚠️ 未能保存',
    saved
      ? `${dateKey} · ¥${formatMoney(norm.plan.salary, 2)} · ${norm.plan.startTime}–${norm.plan.endTime}\n小组件会在系统下次刷新后更新。`
      : '无法写入 Scriptable 文档目录。'
  );
}

/* ==================================================================
   9. 入口
   ================================================================== */

async function main() {
  try {
    if (!config.runsInWidget) {
      const handled = await handleUrlSync();
      if (handled) return;
      await runEditor();
      return;
    }
    const w = buildWidget();
    Script.setWidget(w);
  } catch (err) {
    try {
      const fallback = new ListWidget();
      fallback.backgroundColor = color('#111A15');
      addText(fallback, '现金流小组件加载失败', {
        font: Font.systemFont(13),
        color: color('#FFFFFF')
      });
      addText(fallback, String(err && err.message ? err.message : err).slice(0, 80), {
        font: Font.systemFont(10),
        color: color('#FFFFFF', 0.7),
        lines: 2
      });
      if (config.runsInWidget) Script.setWidget(fallback);
    } catch (e) {
      /* 兜底也失败时，让 Scriptable 显示原生错误 */
    }
    console.error(err);
  } finally {
    try {
      Script.complete();
    } catch (e) {
      /* 某些上下文无需显式 complete */
    }
  }
}

await main();
