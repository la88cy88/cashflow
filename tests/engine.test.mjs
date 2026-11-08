import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculate,
  buildSchedule,
  normalizePlan,
  dueMilestones,
  formatMoney,
  formatCurrency
} from '../js/engine.js';
import { atClock } from '../js/time.js';

const D = '2026-11-09';
const HOUR = 3_600_000;
const ts = (h, m, day = 9, ms = 0) => new Date(2026, 10, day, h, m, 0, ms).getTime();
const plan = (over = {}) => ({
  date: D,
  salary: 300,
  startTime: '08:30',
  endTime: '17:30',
  breakMinutes: 0,
  breakStart: '12:00',
  ...over
});
const near = (actual, expected, eps = 1e-7, msg = '') =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${msg} expected ${actual} ≈ ${expected} (diff ${Math.abs(actual - expected)})`
  );

test('① 当前时间早于上班时间：显示 0，状态「准备上班」', () => {
  const r = calculate(plan(), ts(7, 0));
  assert.equal(r.ok, true);
  assert.equal(r.earned, 0);
  assert.equal(r.percent, 0);
  assert.equal(r.elapsedMs, 0);
  assert.equal(r.remainingMs, 9 * HOUR);
  assert.equal(r.status, 'before');
});

test('② 当前时间晚于下班时间：显示完整工资且永不超过上限', () => {
  const r = calculate(plan(), ts(18, 0));
  assert.equal(r.earned, 300);
  assert.equal(r.percent, 100);
  assert.equal(r.status, 'done');

  const daysLater = calculate(plan(), ts(23, 59, 15));
  assert.equal(daysLater.earned, 300);
  assert.ok(daysLater.earned <= 300);

  const exactlyAtEnd = calculate(plan(), atClock(D, '17:30'));
  assert.equal(exactlyAtEnd.earned, 300);
  assert.equal(exactlyAtEnd.status, 'done');
});

test('③ 班次中点恰好完成 50%', () => {
  const r = calculate(plan(), ts(13, 0));
  near(r.earned, 150);
  near(r.percent, 50);
  near(r.elapsedMs, 4.5 * HOUR, 1);
  near(r.remainingMs, 4.5 * HOUR, 1);
  assert.equal(r.status, 'working');
});

test('④ 毫秒级精度：相邻 1ms 的增量等于每毫秒工资', () => {
  const t = ts(10, 15, 9, 137);
  const a = calculate(plan(), t);
  const b = calculate(plan(), t + 1);
  near(b.earned - a.earned, a.perMillisecond, 1e-12);
  near(a.perMillisecond, 300 / (9 * HOUR), 1e-18);
  assert.equal(formatMoney(b.earned).split('.')[1].length, 6);
});

test('⑤ 幂等：刷新 / 锁屏恢复 / 重新打开得到完全相同结果', () => {
  const t = ts(14, 37, 9, 428);
  const first = calculate(plan(), t);
  for (let i = 0; i < 8; i += 1) {
    assert.deepEqual(calculate(plan(), t), first);
  }
  // 用「先算早时刻再算晚时刻」也不会因为调用顺序产生累积误差
  calculate(plan(), t - 3_600_000);
  assert.deepEqual(calculate(plan(), t), first);
});

test('⑥ 午休期间工资暂停增长，状态为「休息一下」', () => {
  const p = plan({ breakMinutes: 60 }); // 12:00–13:00，有效 8h
  const at12 = calculate(p, ts(12, 0));
  const at1230 = calculate(p, ts(12, 30));
  const at1259 = calculate(p, ts(12, 59, 9, 999));

  near(at12.earned, (300 * 3.5) / 8);
  near(at1230.earned, at12.earned);
  near(at1259.earned, at12.earned);
  assert.equal(at1230.status, 'break');

  const at13 = calculate(p, ts(13, 0));
  near(at13.earned, at12.earned);
  const at14 = calculate(p, ts(14, 0));
  near(at14.earned, (300 * 4.5) / 8);
});

test('⑦ 午休从总工作时长中扣除，工作段被正确拆分', () => {
  const s = buildSchedule(plan({ breakMinutes: 90 }));
  assert.equal(s.ok, true);
  assert.equal(s.totalEffectiveMs, 7.5 * HOUR);
  assert.equal(s.segments.length, 2);
  assert.deepEqual(s.breakRange, [atClock(D, '12:00'), atClock(D, '13:30')]);
});

test('⑧ 跨午夜班次：次日凌晨正确累计，下班后收满', () => {
  const p = plan({ startTime: '22:00', endTime: '06:00' });
  const before = calculate(p, ts(21, 0, 9));
  assert.equal(before.earned, 0);
  assert.equal(before.status, 'before');

  const midnight = calculate(p, ts(2, 0, 10));
  assert.equal(midnight.crossesMidnight, true);
  near(midnight.earned, 150);
  assert.equal(midnight.status, 'working');

  const done = calculate(p, ts(6, 0, 10));
  assert.equal(done.earned, 300);
  assert.equal(done.status, 'done');
});

test('⑨ 跨午夜班次 + 次日午休：时间轴依然准确', () => {
  const p = plan({
    startTime: '22:00',
    endTime: '06:00',
    breakMinutes: 60,
    breakStart: '01:00'
  });
  const r = calculate(p, ts(2, 0, 10));
  near(r.totalEffectiveMs, 7 * HOUR, 1);
  near(r.earned, (300 * 3) / 7);
  assert.equal(r.status, 'working');
  assert.equal(calculate(p, ts(1, 30, 10)).status, 'break');
  assert.equal(calculate(p, ts(6, 0, 10)).earned, 300);
});

test('⑩ 修改工资：按新工资立即重新计算', () => {
  const old = calculate(plan(), ts(13, 0));
  const changed = calculate(plan({ salary: 600 }), ts(13, 0));
  near(old.earned, 150);
  near(changed.earned, 300);
  near(changed.perHour, 600 / 9);
  near(changed.perMillisecond, 600 / (9 * HOUR), 1e-18);
});

test('⑪ 修改上下班时间：工作时长与工资同步重算', () => {
  const normal = calculate(plan(), ts(13, 0));
  const shifted = calculate(plan({ startTime: '09:00', endTime: '18:00' }), ts(13, 0));
  near(normal.percent, 50);
  near(shifted.percent, 400 / 9);
  assert.notEqual(normal.earned, shifted.earned);
  near(shifted.totalEffectiveMs, 9 * HOUR, 1);
});

test('⑫ 上班时间早于当前时间：打开页面即显示已产生的工资', () => {
  const r = calculate(plan(), ts(15, 45));
  near(r.earned, (300 * 7.25) / 9);
  assert.equal(r.status, 'working');
  near(r.elapsedMs, 7.25 * HOUR, 1);
});

test('⑬ 有效时长为 0 / 输入不合法：禁止计算并给出明确提示', () => {
  const zero = calculate(
    plan({ startTime: '12:00', endTime: '17:30', breakMinutes: 600, breakStart: '12:00' }),
    ts(13, 0)
  );
  assert.equal(zero.ok, false);
  assert.equal(zero.reason, 'zero-duration');
  assert.equal(zero.status, 'invalid');
  assert.equal(zero.earned, 0);
  assert.match(zero.errors.join(''), /有效工作时长为 0/);

  const invalid = [
    { salary: 0 },
    { salary: -1 },
    { salary: 'abc' },
    { salary: NaN },
    { salary: Infinity },
    { startTime: '25:00' },
    { endTime: '09:99' },
    { breakMinutes: -5 },
    { breakMinutes: 1.5 },
    { breakMinutes: 2000 },
    { breakStart: '99:00' },
    { date: '2026-02-30' }
  ];
  for (const patch of invalid) {
    const r = calculate(plan(patch), ts(13, 0));
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(patch)}`);
    assert.ok(r.errors.length > 0);
    assert.equal(r.earned, 0);
  }
});

test('⑭ 午休超出下班时间：截断并给出提示，不静默算错', () => {
  const r = calculate(plan({ breakMinutes: 600, breakStart: '16:00' }), ts(13, 0));
  assert.equal(r.ok, true);
  near(r.totalEffectiveMs, 7.5 * HOUR, 1);
  assert.ok(r.warnings.some((w) => w.includes('截断')));
});

test('⑮ 午休时间不在班次内：忽略午休但计算继续', () => {
  const r = calculate(plan({ breakMinutes: 60, breakStart: '07:00' }), ts(13, 0));
  assert.equal(r.ok, true);
  near(r.totalEffectiveMs, 9 * HOUR, 1);
  assert.ok(r.warnings.some((w) => w.includes('忽略')));
});

test('⑯ 速率指标自洽：小时 / 分钟 / 秒 / 毫秒', () => {
  const r = calculate(plan(), ts(11, 0));
  near(r.perHour * (r.totalEffectiveMs / HOUR), 300, 1e-9);
  near((r.perMinute * 60), r.perHour, 1e-9);
  near((r.perSecond * 60), r.perMinute, 1e-9);
  near((r.perMillisecond * 1000), r.perSecond, 1e-12);
  near(r.percent, (r.elapsedMs / r.totalEffectiveMs) * 100, 1e-9);
});

test('⑰ 里程碑：只返回尚未触发的档位', () => {
  assert.deepEqual(dueMilestones(24, []), []);
  assert.deepEqual(dueMilestones(25, []), [25]);
  assert.deepEqual(dueMilestones(50, [25]), [50]);
  assert.deepEqual(dueMilestones(100, [25, 50, 75]), [100]);
  assert.deepEqual(dueMilestones(100, [25, 50, 75, 100]), []);
});

test('⑱ 金额格式化：固定 6 位小数且不被浮点误差污染', () => {
  assert.equal(formatMoney(123.456789), '123.456789');
  assert.equal(formatMoney(0), '0.000000');
  assert.equal(formatCurrency(300, '¥'), '¥300.000000');
  assert.equal(formatMoney(299.99999999999994), '300.000000');
});

test('⑲ 时区变化：按设备当前本地时间解释，数据语义不丢', () => {
  const original = process.env.TZ;
  const stamps = [];
  try {
    for (const tz of ['Asia/Shanghai', 'America/New_York', 'Pacific/Auckland', 'UTC']) {
      process.env.TZ = tz;
      const localAfternoon = new Date(2026, 10, 9, 13, 0, 0).getTime();
      const r = calculate(plan(), localAfternoon);
      assert.equal(r.status, 'working', tz);
      near(r.earned, 150, 1e-7, tz);
      near(r.percent, 50, 1e-7, tz);
      assert.equal(r.startTs, atClock(D, '08:30'), tz);
      stamps.push(new Date(2026, 10, 9, 8, 30).getTime());
    }
    assert.ok(new Set(stamps).size > 1, '不同时区的绝对时间戳应当不同');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('⑳ normalizePlan 规范化输入，保留每日独立字段', () => {
  const n = normalizePlan({
    date: D,
    salary: '300.5',
    startTime: '8:30',
    endTime: '17:30',
    breakMinutes: '30',
    breakStart: '9:00'
  });
  assert.equal(n.ok, true);
  assert.equal(n.plan.salary, 300.5);
  assert.equal(n.plan.startTime, '08:30');
  assert.equal(n.plan.breakStart, '09:00');
  assert.equal(n.plan.breakMinutes, 30);
  assert.equal(n.plan.date, D);
  assert.equal(normalizePlan({ date: D, breakStart: '12:0' }).ok, false);
});
