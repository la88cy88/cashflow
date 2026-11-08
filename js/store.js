/**
 * 本地持久化层（LocalStorage；不可用时自动降级为内存存储）
 *
 * 数据分四类，按命名空间隔离：
 *   prefs      应用偏好（主题 / 动画 / 货币符号）
 *   defaults   常用模板（跨天沿用）
 *   plans      按 YYYY-MM-DD 隔离的每日计划（互不覆盖）
 *   milestones 按日期记录已播放过的里程碑，避免刷新后重复庆祝
 */

import { dateKeyOfTs, shiftDateKey, parseDateKey, canonicalClock } from './time.js';
import { DEFAULT_TEMPLATE, buildSchedule } from './engine.js';

const NS = 'dgr:v1:';
const K = {
  prefs: `${NS}prefs`,
  defaults: `${NS}defaults`,
  plans: `${NS}plans`,
  milestones: `${NS}milestones`
};

const DEFAULT_PREFS = Object.freeze({
  theme: 'auto', // auto | light | dark
  animations: true,
  currency: '¥'
});

const memoryMap = new Map();
const memoryBackend = {
  getItem: (k) => (memoryMap.has(k) ? memoryMap.get(k) : null),
  setItem: (k, v) => memoryMap.set(k, String(v)),
  removeItem: (k) => memoryMap.delete(k)
};

let injectedStorage = null; // 仅供单元测试注入
let usingFallback = false;

export function setStorageForTests(storage) {
  injectedStorage = storage;
}

export function isStoragePersistent() {
  return !usingFallback || injectedStorage !== null;
}

function backend() {
  if (injectedStorage) return injectedStorage;
  if (usingFallback) return memoryBackend;
  try {
    const ls = globalThis.localStorage;
    if (!ls) throw new Error('localStorage unavailable');
    const probe = `${NS}__probe__`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    usingFallback = true;
    return memoryBackend;
  }
}

function read(key, fallbackValue) {
  try {
    const raw = backend().getItem(key);
    if (raw == null) return fallbackValue;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallbackValue : parsed;
  } catch {
    return fallbackValue;
  }
}

function write(key, value) {
  try {
    backend().setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ 偏好 ------------------------------ */

export function getPrefs() {
  const p = read(K.prefs, {});
  const theme = ['auto', 'light', 'dark'].includes(p?.theme) ? p.theme : DEFAULT_PREFS.theme;
  return {
    theme,
    animations: typeof p?.animations === 'boolean' ? p.animations : DEFAULT_PREFS.animations,
    currency: typeof p?.currency === 'string' && p.currency.length <= 3 ? p.currency : DEFAULT_PREFS.currency
  };
}

export function savePrefs(patch) {
  const next = { ...getPrefs(), ...(patch || {}) };
  write(K.prefs, next);
  return next;
}

/* ------------------------------ 常用模板 ------------------------------ */

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function sanitizeTemplate(raw) {
  const t = { ...DEFAULT_TEMPLATE, ...(raw || {}) };
  const salary = Number(t.salary);
  return {
    salary: Number.isFinite(salary) && salary > 0 ? salary : DEFAULT_TEMPLATE.salary,
    startTime: canonicalClock(t.startTime) || DEFAULT_TEMPLATE.startTime,
    endTime: canonicalClock(t.endTime) || DEFAULT_TEMPLATE.endTime,
    breakStart: canonicalClock(t.breakStart) || DEFAULT_TEMPLATE.breakStart,
    breakMinutes: clampInt(t.breakMinutes, 0, 24 * 60)
  };
}

export function getDefaults() {
  return sanitizeTemplate(read(K.defaults, null));
}

export function saveDefaults(template) {
  const clean = sanitizeTemplate(template);
  write(K.defaults, clean);
  return clean;
}

export function templateToPlan(template, dateKey, confirmed = false) {
  return {
    ...sanitizeTemplate(template),
    date: dateKey,
    confirmed,
    updatedAt: Date.now()
  };
}

/* ------------------------------ 每日计划 ------------------------------ */

export function getPlans() {
  const raw = read(K.plans, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (parseDateKey(key) && value && typeof value === 'object') out[key] = { ...value, date: key };
  }
  return out;
}

export function getPlan(dateKey) {
  return getPlans()[dateKey] || null;
}

export function savePlan(dateKey, plan) {
  if (!parseDateKey(dateKey)) return false;
  const plans = getPlans();
  plans[dateKey] = { ...plan, date: dateKey };
  return write(K.plans, plans);
}

/** 若该日期还没有计划，用常用模板自动创建（confirmed=false 表示尚未人工确认） */
export function ensurePlan(dateKey, now = Date.now()) {
  const existing = getPlan(dateKey);
  if (existing) return { plan: existing, created: false };
  const plan = templateToPlan(getDefaults(), dateKey, false);
  savePlan(dateKey, plan);
  return { plan, created: true };
}

/**
 * 决定「此刻应该展示哪一天的计划」。
 * 默认展示系统当天；但如果前一天的跨午夜班次此刻仍在进行，就继续显示前一天，
 * 直到该班次结束，避免凌晨 0 点一到就把夜班进度清掉。
 */
export function resolveActiveDateKey(now = Date.now(), plans = getPlans()) {
  const todayKey = dateKeyOfTs(now);
  const yesterdayKey = shiftDateKey(todayKey, -1);
  const yesterday = plans[yesterdayKey];
  if (yesterday) {
    const s = buildSchedule(yesterday);
    if (s.ok && s.crossesMidnight && now >= s.startTs && now < s.endTs) {
      return yesterdayKey;
    }
  }
  return todayKey;
}

/** 只保留最近 keepDays 天的计划，避免长期使用后 LocalStorage 无限膨胀 */
export function prunePlans(keepDays = 400, now = Date.now()) {
  const todayKey = dateKeyOfTs(now);
  const cutoff = shiftDateKey(todayKey, -keepDays);
  if (!cutoff) return 0;
  const plans = getPlans();
  const marks = read(K.milestones, {});
  let removed = 0;
  for (const key of Object.keys(plans)) {
    if (key < cutoff) {
      delete plans[key];
      delete marks[key];
      removed += 1;
    }
  }
  if (removed > 0) {
    write(K.plans, plans);
    write(K.milestones, marks);
  }
  return removed;
}

/* ------------------------------ 里程碑 ------------------------------ */

export function getMilestones(dateKey) {
  const all = read(K.milestones, {});
  const list = all && typeof all === 'object' ? all[dateKey] : null;
  return Array.isArray(list) ? list.filter((n) => Number.isFinite(n)) : [];
}

export function markMilestone(dateKey, level) {
  const all = read(K.milestones, {});
  const bag = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  const list = Array.isArray(bag[dateKey]) ? bag[dateKey] : [];
  if (!list.includes(level)) list.push(level);
  bag[dateKey] = list;
  write(K.milestones, bag);
  return list;
}

export function resetMilestones(dateKey) {
  const all = read(K.milestones, {});
  const bag = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  delete bag[dateKey];
  write(K.milestones, bag);
}

/* ------------------------------ 概览 / 备份 ------------------------------ */

/** 最近 N 天的计划概览（按日期倒序） */
export function getHistory(limit = 7, upToKey = dateKeyOfTs(Date.now())) {
  const plans = getPlans();
  return Object.keys(plans)
    .filter((k) => k <= upToKey)
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, limit)
    .map((key) => {
      const p = plans[key];
      const s = buildSchedule(p);
      return {
        date: key,
        salary: Number(p.salary) || 0,
        startTime: p.startTime,
        endTime: p.endTime,
        breakMinutes: Number(p.breakMinutes) || 0,
        effectiveMs: s.ok ? s.totalEffectiveMs : 0,
        crossesMidnight: s.ok ? s.crossesMidnight : false,
        confirmed: Boolean(p.confirmed),
        valid: s.ok
      };
    });
}

/** 导出全部本地数据（纯用户设置，绝不包含任何凭据） */
export function exportData() {
  return JSON.stringify(
    {
      app: 'dagongren-cashflow',
      version: 1,
      exportedAt: new Date().toISOString(),
      prefs: getPrefs(),
      defaults: getDefaults(),
      plans: getPlans(),
      milestones: read(K.milestones, {})
    },
    null,
    2
  );
}

/** 从备份恢复；返回 {ok, message} */
export function importData(json) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return { ok: false, message: '文件不是有效的 JSON' };
  }
  if (!data || data.app !== 'dagongren-cashflow' || !data.plans || typeof data.plans !== 'object') {
    return { ok: false, message: '这不是本应用导出的备份文件' };
  }
  write(K.defaults, sanitizeTemplate(data.defaults));
  write(K.prefs, { ...getPrefs(), ...(data.prefs || {}) });
  write(K.plans, data.plans);
  write(K.milestones, data.milestones && typeof data.milestones === 'object' ? data.milestones : {});
  return { ok: true, message: '数据已恢复' };
}

/** 仅用于「清空所有本地数据」按钮 */
export function clearAll() {
  for (const key of Object.values(K)) {
    try {
      backend().removeItem(key);
    } catch {
      /* ignore */
    }
  }
}
