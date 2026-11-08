/**
 * 实时工资计算引擎 —— 纯函数，零 DOM 依赖，可直接在 Node 中测试。
 *
 * 唯一真值来源：f(计划, Date.now())。
 * 不使用 setInterval 累加、不缓存金额、不依赖页面存活时间。
 * 因此刷新、锁屏、切后台、重开页面、时区变化后，金额一律按真实时间重新计算。
 *
 * 时间轴模型：
 *   班次 = [startTs, endTs)（endTs <= startTs 时视为次日，即跨午夜班）
 *   午休 = [breakStart, breakEnd) 是时间轴上的「空洞」
 *   有效工作段 = 班次 减去 午休（最多两段）
 *   已完成有效毫秒 = Σ overlap([startTs, now], 每个工作段)
 */

import {
  atClock,
  canonicalClock,
  parseDateKey,
  pad2,
  SECOND_MS,
  MINUTE_MS,
  HOUR_MS
} from './time.js';

export const MILESTONES = [25, 50, 75, 100];

export const STATUS_META = {
  before: { label: '准备上班', hint: '还没到上班时间，先喝口水吧', icon: '☕' },
  working: { label: '正在努力赚钱', hint: '时间正在一分一秒地变成钱', icon: '💪' },
  break: { label: '休息一下', hint: '午休中，工资暂停增长', icon: '🍵' },
  done: { label: '今日工资到账', hint: '今天辛苦了，钱已经全部赚到手', icon: '🎉' },
  invalid: { label: '计划待修正', hint: '请先检查今日计划设置', icon: '⚠️' }
};

const PLAN_DEFAULTS = {
  date: '',
  salary: 300,
  startTime: '08:30',
  endTime: '17:30',
  breakMinutes: 0,
  breakStart: '12:00',
  confirmed: false,
  updatedAt: 0
};

export const DEFAULT_TEMPLATE = Object.freeze({
  salary: 300,
  startTime: '08:30',
  endTime: '17:30',
  breakMinutes: 0,
  breakStart: '12:00'
});

/**
 * 校验并规范化一份每日计划。
 * @returns {{ok:boolean, errors:string[], plan:object|null}}
 */
export function normalizePlan(raw) {
  const src = { ...PLAN_DEFAULTS, ...(raw || {}) };
  const errors = [];

  const date = String(src.date ?? '');
  if (!parseDateKey(date)) errors.push('日期无效');

  const salary = Number(src.salary);
  if (!Number.isFinite(salary) || salary <= 0) {
    errors.push('今日工资必须是大于 0 的数字');
  } else if (salary > 1_000_000_000) {
    errors.push('今日工资数值过大');
  }

  const startTime = canonicalClock(src.startTime);
  const endTime = canonicalClock(src.endTime);
  const breakStart = canonicalClock(src.breakStart ?? '12:00');
  if (!startTime) errors.push('上班时间格式无效（应为 HH:mm）');
  if (!endTime) errors.push('下班时间格式无效（应为 HH:mm）');
  if (!breakStart) errors.push('午休开始时间格式无效（应为 HH:mm）');

  const breakMinutes = Number(src.breakMinutes);
  if (!Number.isFinite(breakMinutes) || breakMinutes < 0 || !Number.isInteger(breakMinutes)) {
    errors.push('午休时长必须是非负整数分钟');
  } else if (breakMinutes > 24 * 60) {
    errors.push('午休时长不能超过 24 小时');
  }

  if (errors.length) return { ok: false, errors, plan: null };

  return {
    ok: true,
    errors: [],
    plan: {
      date,
      salary,
      startTime,
      endTime,
      breakStart,
      breakMinutes: Math.trunc(breakMinutes),
      confirmed: Boolean(src.confirmed),
      updatedAt: Number(src.updatedAt) || 0
    }
  };
}

/**
 * 把计划编译成一条绝对时间轴（依赖设备当前本地时区）。
 * @returns 成功时包含 segments / totalEffectiveMs；失败时包含 errors + reason
 */
export function buildSchedule(rawPlan) {
  const norm = normalizePlan(rawPlan);
  if (!norm.ok) return { ok: false, errors: norm.errors, reason: 'invalid' };
  const p = norm.plan;

  const startTs = atClock(p.date, p.startTime, 0);
  let endTs = atClock(p.date, p.endTime, 0);
  // 下班钟表时间 <= 上班钟表时间 => 下班在次日（跨午夜班次）
  const crossesMidnight = endTs <= startTs;
  if (crossesMidnight) endTs = atClock(p.date, p.endTime, 1);

  const warnings = [];
  let breakRange = null;

  if (p.breakMinutes > 0) {
    let b1 = atClock(p.date, p.breakStart, 0);
    if (b1 < startTs) b1 = atClock(p.date, p.breakStart, 1);
    // 跨日班次里，午休填在「当天白天」时，回退一天再试
    if (b1 >= endTs) {
      const earlier = atClock(p.date, p.breakStart, -1);
      if (earlier >= startTs && earlier < endTs) b1 = earlier;
    }

    if (b1 >= startTs && b1 < endTs) {
      const wantedEnd = b1 + p.breakMinutes * MINUTE_MS;
      const b2 = Math.min(wantedEnd, endTs);
      if (b2 > b1) breakRange = [b1, b2];
      if (b2 < wantedEnd) warnings.push('午休时段超出下班时间，已按实际可休息时长截断');
    } else {
      warnings.push('午休开始时间不在工作时段内，本次已忽略午休');
    }
  }

  const segments = [];
  if (!breakRange) {
    segments.push([startTs, endTs]);
  } else {
    if (breakRange[0] > startTs) segments.push([startTs, breakRange[0]]);
    if (breakRange[1] < endTs) segments.push([breakRange[1], endTs]);
  }

  const totalEffectiveMs = segments.reduce((sum, [a, b]) => sum + (b - a), 0);
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

/**
 * 计算某一真实时刻的工资快照。
 * @param {object} rawPlan 今日计划
 * @param {number} now     Date.now()（可注入以便测试）
 */
export function calculate(rawPlan, now = Date.now()) {
  const s = buildSchedule(rawPlan);
  if (!s.ok) {
    return {
      ok: false,
      errors: s.errors,
      reason: s.reason,
      now,
      earned: 0,
      salary: Number(rawPlan?.salary) || 0,
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
      plan: s.plan || null
    };
  }

  const { totalEffectiveMs, segments, startTs, endTs, breakRange, plan } = s;
  const salary = plan.salary;

  let elapsedMs = 0;
  for (const [a, b] of segments) {
    if (now > a) elapsedMs += Math.min(now, b) - a;
  }
  elapsedMs = Math.max(0, Math.min(totalEffectiveMs, elapsedMs));

  const ratio = elapsedMs / totalEffectiveMs;
  // 首尾取精确值，避免浮点误差导致 299.99999999999994 之类的显示
  let earned = ratio <= 0 ? 0 : ratio >= 1 ? salary : salary * ratio;
  earned = Math.max(0, Math.min(salary, earned));

  let status;
  if (now < startTs) status = 'before';
  else if (now >= endTs) status = 'done';
  else if (breakRange && now >= breakRange[0] && now < breakRange[1]) status = 'break';
  else status = 'working';

  const perMillisecond = salary / totalEffectiveMs;

  return {
    ok: true,
    errors: [],
    reason: 'ok',
    now,
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
    startTs,
    endTs,
    breakRange,
    crossesMidnight: s.crossesMidnight,
    segments,
    warnings: s.warnings,
    plan
  };
}

/** 返回本次应当触发、但尚未记录过的里程碑 */
export function dueMilestones(percent, fired = []) {
  return MILESTONES.filter((m) => percent >= m && !fired.includes(m));
}

/** 金额格式化：固定 6 位小数，不使用千分位以保证逐位滚动稳定 */
export function formatMoney(value, decimals = 6) {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0;
  return n.toFixed(decimals);
}

/** 带 ¥ 符号的完整金额串 */
export function formatCurrency(value, symbol = '¥', decimals = 6) {
  return `${symbol}${formatMoney(value, decimals)}`;
}

export function formatPercent(percent) {
  const p = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  return `${p.toFixed(2)}%`;
}

/** 速率格式化：每秒可能不足 1 分钱，保留 4~6 位小数 */
export function formatRate(value, digits = 4) {
  const n = Number.isFinite(value) ? Math.max(0, value) : 0;
  return n.toFixed(digits);
}

/** 时长格式化 HH:mm:ss（转发，方便调用方只依赖 engine） */
export function formatWorkDuration(ms) {
  const total = Math.max(0, Math.floor(ms / SECOND_MS));
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
}
