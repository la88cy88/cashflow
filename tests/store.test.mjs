import test from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../js/store.js';

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

let backing;
function reset() {
  backing = makeStorage();
  store.setStorageForTests(backing);
}

const samplePlan = (over = {}) => ({
  date: '2026-11-09',
  salary: 300,
  startTime: '08:30',
  endTime: '17:30',
  breakMinutes: 0,
  breakStart: '12:00',
  confirmed: true,
  ...over
});

test('① 偏好默认值与脏数据回退', () => {
  reset();
  assert.deepEqual(store.getPrefs(), { theme: 'auto', animations: true, currency: '¥' });

  backing.setItem('dgr:v1:prefs', JSON.stringify({ theme: 'neon', animations: 'yes', currency: 42 }));
  assert.deepEqual(store.getPrefs(), { theme: 'auto', animations: true, currency: '¥' });

  backing.setItem('dgr:v1:prefs', '{not json');
  assert.deepEqual(store.getPrefs(), { theme: 'auto', animations: true, currency: '¥' });

  assert.deepEqual(store.savePrefs({ theme: 'dark' }), {
    theme: 'dark',
    animations: true,
    currency: '¥'
  });
  assert.equal(store.getPrefs().theme, 'dark');
});

test('② 默认模板校验与保存', () => {
  reset();
  assert.equal(store.getDefaults().salary, 300);
  assert.equal(store.getDefaults().startTime, '08:30');

  backing.setItem(
    'dgr:v1:defaults',
    JSON.stringify({ salary: -5, startTime: '99:99', breakMinutes: -10 })
  );
  assert.equal(store.getDefaults().salary, 300);
  assert.equal(store.getDefaults().startTime, '08:30');
  assert.equal(store.getDefaults().breakMinutes, 0);

  store.saveDefaults({ salary: 500, startTime: '9:00', endTime: '18:00', breakMinutes: 45, breakStart: '12:30' });
  assert.deepEqual(store.getDefaults(), {
    salary: 500,
    startTime: '09:00',
    endTime: '18:00',
    breakMinutes: 45,
    breakStart: '12:30'
  });
});

test('③ 每日计划按日期隔离，互不覆盖', () => {
  reset();
  store.savePlan('2026-11-08', samplePlan({ date: '2026-11-08', salary: 200 }));
  store.savePlan('2026-11-09', samplePlan({ salary: 300 }));

  assert.equal(store.getPlan('2026-11-08').salary, 200);
  assert.equal(store.getPlan('2026-11-09').salary, 300);
  assert.equal(Object.keys(store.getPlans()).length, 2);

  store.savePlan('2026-11-08', samplePlan({ date: '2026-11-08', salary: 250 }));
  assert.equal(store.getPlan('2026-11-08').salary, 250);
  assert.equal(store.getPlan('2026-11-09').salary, 300);
  assert.equal(store.savePlan('bad-date', samplePlan()), false);
});

test('④ ensurePlan 沿用默认设置，且不会覆盖已有计划', () => {
  reset();
  store.saveDefaults({ salary: 480, startTime: '09:30', endTime: '19:00', breakMinutes: 60, breakStart: '12:30' });

  const first = store.ensurePlan('2026-11-09');
  assert.equal(first.created, true);
  assert.equal(first.plan.salary, 480);
  assert.equal(first.plan.startTime, '09:30');
  assert.equal(first.plan.confirmed, false);

  store.savePlan('2026-11-09', samplePlan({ salary: 999 }));
  const second = store.ensurePlan('2026-11-09');
  assert.equal(second.created, false);
  assert.equal(second.plan.salary, 999);
});

test('⑤ 跨天：跨午夜班次进行中不切换日期，结束后自动切换到新的一天', () => {
  reset();
  const nightShift = samplePlan({
    date: '2026-11-09',
    startTime: '22:00',
    endTime: '06:00'
  });
  store.savePlan('2026-11-09', nightShift);

  const at3am = new Date(2026, 10, 10, 3, 0, 0).getTime();
  assert.equal(store.resolveActiveDateKey(at3am, store.getPlans()), '2026-11-09');

  const at7am = new Date(2026, 10, 10, 7, 0, 0).getTime();
  assert.equal(store.resolveActiveDateKey(at7am, store.getPlans()), '2026-11-10');

  store.savePlan('2026-11-09', samplePlan({ date: '2026-11-09' }));
  assert.equal(store.resolveActiveDateKey(at3am, store.getPlans()), '2026-11-10');
});

test('⑥ 里程碑去重与重置（刷新后不重复庆祝）', () => {
  reset();
  assert.deepEqual(store.getMilestones('2026-11-09'), []);
  store.markMilestone('2026-11-09', 25);
  store.markMilestone('2026-11-09', 25);
  store.markMilestone('2026-11-09', 50);
  assert.deepEqual(store.getMilestones('2026-11-09'), [25, 50]);
  store.markMilestone('2026-11-10', 25);
  assert.deepEqual(store.getMilestones('2026-11-10'), [25]);

  store.resetMilestones('2026-11-09');
  assert.deepEqual(store.getMilestones('2026-11-09'), []);
  assert.deepEqual(store.getMilestones('2026-11-10'), [25]);
});

test('⑦ 导出 / 导入备份往返，且拒绝非法文件', () => {
  reset();
  store.savePrefs({ theme: 'dark', animations: false });
  store.saveDefaults({ salary: 420 });
  store.savePlan('2026-11-09', samplePlan({ salary: 420 }));
  store.markMilestone('2026-11-09', 50);
  const json = store.exportData();

  assert.ok(!/token|password|secret|ghp_/i.test(json), '备份中不应包含凭据字段');
  assert.ok(JSON.parse(json).plans['2026-11-09']);

  reset();
  assert.equal(store.importData('{broken').ok, false);
  assert.equal(store.importData('{"hello":1}').ok, false);

  assert.equal(store.importData(json).ok, true);
  assert.equal(store.getPrefs().theme, 'dark');
  assert.equal(store.getPrefs().animations, false);
  assert.equal(store.getDefaults().salary, 420);
  assert.equal(store.getPlan('2026-11-09').salary, 420);
  assert.deepEqual(store.getMilestones('2026-11-09'), [50]);
});

test('⑧ 自动清理过期计划，避免长期使用时存储膨胀', () => {
  reset();
  store.savePlan('2020-01-01', samplePlan({ date: '2020-01-01' }));
  store.savePlan('2026-11-08', samplePlan({ date: '2026-11-08' }));
  store.savePlan('2026-11-09', samplePlan());
  const now = new Date(2026, 10, 9, 12, 0, 0).getTime();
  assert.equal(store.prunePlans(400, now), 1);
  assert.equal(store.getPlan('2020-01-01'), null);
  assert.ok(store.getPlan('2026-11-09'));
});

test('⑨ 概览按日期倒序并遵守条数上限', () => {
  reset();
  for (const [date, salary] of [
    ['2026-11-05', 100],
    ['2026-11-07', 200],
    ['2026-11-08', 250],
    ['2026-11-09', 300]
  ]) {
    store.savePlan(date, samplePlan({ date, salary }));
  }
  const history = store.getHistory(2, '2026-11-09');
  assert.equal(history.length, 2);
  assert.equal(history[0].date, '2026-11-09');
  assert.equal(history[1].date, '2026-11-08');
  assert.equal(history[0].effectiveMs, 9 * 3_600_000);
  assert.equal(history[0].valid, true);
});

test('⑩ 清空数据后回到初始状态', () => {
  reset();
  store.savePlan('2026-11-09', samplePlan());
  store.savePrefs({ theme: 'dark' });
  store.clearAll();
  assert.equal(store.getPlan('2026-11-09'), null);
  assert.equal(store.getPrefs().theme, 'auto');
  assert.equal(store.getDefaults().salary, 300);
});
