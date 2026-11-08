import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dateKeyOf,
  dateKeyOfTs,
  parseDateKey,
  shiftDateKey,
  parseClock,
  canonicalClock,
  atClock,
  clockOfTs,
  weekdayOfKey,
  longDateOfKey,
  shortDateOfKey,
  formatDuration,
  formatMinutes
} from '../js/time.js';

test('① 日期键生成与严格解析', () => {
  assert.equal(dateKeyOf(new Date(2026, 10, 9, 23, 59)), '2026-11-09');
  assert.equal(dateKeyOfTs(new Date(2026, 0, 1, 0, 0).getTime()), '2026-01-01');
  assert.ok(parseDateKey('2026-11-09'));
  assert.equal(parseDateKey('2026-02-30'), null, '不存在的日期应被拒绝');
  assert.equal(parseDateKey('2026-13-01'), null);
  assert.equal(parseDateKey('not-a-date'), null);
  assert.equal(parseDateKey(null), null);
});

test('② 日期加减正确处理月末 / 跨年 / 闰年', () => {
  assert.equal(shiftDateKey('2026-11-09', -1), '2026-11-08');
  assert.equal(shiftDateKey('2026-11-01', -1), '2026-10-31');
  assert.equal(shiftDateKey('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDateKey('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftDateKey('2025-02-28', 1), '2025-03-01');
  assert.equal(shiftDateKey('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDateKey('bad', 1), null);
});

test('③ 钟表时间解析与规范化', () => {
  assert.deepEqual(parseClock('08:30'), { hour: 8, minute: 30 });
  assert.deepEqual(parseClock('8:30'), { hour: 8, minute: 30 });
  assert.equal(canonicalClock('8:5'), null);
  assert.equal(canonicalClock('25:00'), null);
  assert.equal(canonicalClock('12:60'), null);
  assert.equal(canonicalClock('abc'), null);
  assert.equal(canonicalClock('00:00'), '00:00');
  assert.equal(canonicalClock('23:59'), '23:59');
});

test('④ atClock 按本地时区解析，支持正负日偏移', () => {
  assert.equal(atClock('2026-11-09', '08:30'), new Date(2026, 10, 9, 8, 30, 0, 0).getTime());
  assert.equal(atClock('2026-11-09', '06:00', 1), new Date(2026, 10, 10, 6, 0, 0, 0).getTime());
  assert.equal(atClock('2026-11-09', '23:00', -1), new Date(2026, 10, 8, 23, 0, 0, 0).getTime());
  assert.equal(atClock('bad', '08:30'), null);
  assert.equal(atClock('2026-11-09', 'bad'), null);
  assert.equal(clockOfTs(new Date(2026, 10, 9, 17, 5).getTime()), '17:05');
});

test('⑤ 时长与分钟格式化', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(3_600_000), '01:00:00');
  assert.equal(formatDuration(4.5 * 3_600_000), '04:30:00');
  assert.equal(formatDuration(9 * 3_600_000 + 59_000), '09:00:59');
  assert.equal(formatDuration(-1), '00:00:00');
  assert.equal(formatMinutes(0), '0 分钟');
  assert.equal(formatMinutes(60), '1 小时');
  assert.equal(formatMinutes(90), '1 小时 30 分钟');
});

test('⑥ 中文日期与星期', () => {
  assert.equal(weekdayOfKey('2026-11-09'), '星期一');
  assert.equal(weekdayOfKey('2026-11-15'), '星期日');
  assert.equal(longDateOfKey('2026-11-09'), '2026年11月9日');
  assert.equal(shortDateOfKey('2026-11-09'), '11月9日');
  assert.equal(weekdayOfKey('bad'), '');
});
