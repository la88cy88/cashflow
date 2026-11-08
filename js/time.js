/**
 * 本地时间工具
 *
 * 关键约定：持久化层只保存 "YYYY-MM-DD" 日期键和 "HH:mm" 钟表时间，
 * 从不保存绝对时间戳。每次计算都按「设备当前本地时区」现场解析。
 * 这样手机跨时区旅行后，当天的计划依然按新的本地时间生效，不会被重置或漂移。
 */

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Date -> 本地日期键 YYYY-MM-DD */
export function dateKeyOf(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 时间戳 -> 本地日期键 */
export function dateKeyOfTs(ts) {
  return dateKeyOf(new Date(ts));
}

/** 严格解析日期键，非法日期（如 2026-02-30）返回 null */
export function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** 日期键加减天数（自动处理月末、闰年、跨年） */
export function shiftDateKey(key, days) {
  const dt = parseDateKey(key);
  if (!dt) return null;
  dt.setDate(dt.getDate() + days);
  return dateKeyOf(dt);
}

/** 解析 HH:mm 或 H:mm，返回 {hour, minute}；非法返回 null */
export function parseClock(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** 规范化为 HH:mm */
export function canonicalClock(value) {
  const p = parseClock(value);
  return p ? `${pad2(p.hour)}:${pad2(p.minute)}` : null;
}

/** 日期键 + 钟表时间 -> 本地时间戳(ms)。dayOffset 可为负，用于跨午夜班次。 */
export function atClock(dateKey, clock, dayOffset = 0) {
  const base = parseDateKey(dateKey);
  const t = parseClock(clock);
  if (!base || !t) return null;
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + dayOffset,
    t.hour,
    t.minute,
    0,
    0
  ).getTime();
}

export function clockOfTs(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function timeOfDayOfTs(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function weekdayOfKey(key) {
  const dt = parseDateKey(key);
  return dt ? WEEKDAYS[dt.getDay()] : '';
}

export function longDateOfKey(key) {
  const dt = parseDateKey(key);
  if (!dt) return '';
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
}

export function shortDateOfKey(key) {
  const dt = parseDateKey(key);
  if (!dt) return '';
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}

/** 毫秒 -> HH:mm:ss（班次最长 24h，小时位两位足够） */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / SECOND_MS));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** 分钟数 -> 便于阅读的中文时长 */
export function formatMinutes(minutes) {
  const n = Math.max(0, Math.round(minutes));
  if (n === 0) return '0 分钟';
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (!h) return `${m} 分钟`;
  if (!m) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}
