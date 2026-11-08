/**
 * Scriptable 小组件脚本测试
 *
 * 用 node:vm 构造一个最小的 Scriptable 运行环境（ListWidget / Color / Font /
 * FileManager / Script ...），真实执行 widget/CashflowWidget.js：
 *   - 验证 6 种 widgetFamily 都能渲染出 widget，且没有运行时异常
 *   - 把脚本内置引擎的结果与网页版 js/engine.js 逐字段对比，确保两边不会算错
 *   - 覆盖同步码解析、状态持久化、非法计划、跨午夜归属
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { calculate as webCalculate, buildSchedule as webBuild } from '../js/engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'widget', 'CashflowWidget.js'), 'utf8');
const D = '2026-11-09';
const HOUR = 3_600_000;
const at = (h, m, day = 9) => new Date(2026, 10, day, h, m, 0, 0).getTime();

/* ---------------------- Scriptable 运行环境模拟 ---------------------- */

function makeNode(kind) {
  const node = {
    kind,
    children: [],
    text: '',
    font: null,
    textColor: null,
    textOpacity: 1,
    size: null,
    backgroundColor: null,
    cornerRadius: 0,
    spacing: 0,
    url: null,
    imageSize: null,
    tintColor: null,
    addText(str) {
      const child = makeNode('text');
      child.text = String(str);
      this.children.push(child);
      return child;
    },
    addDate(date) {
      const child = makeNode('date');
      child.date = date;
      this.children.push(child);
      return child;
    },
    addImage(image) {
      const child = makeNode('image');
      child.image = image;
      this.children.push(child);
      return child;
    },
    addSpacer(length) {
      const child = makeNode('spacer');
      child.length = length;
      this.children.push(child);
      return child;
    },
    addStack() {
      const child = makeNode('stack');
      this.children.push(child);
      return child;
    },
    setPadding() {},
    useDefaultPadding() {},
    layoutHorizontally() {},
    layoutVertically() {},
    topAlignContent() {},
    centerAlignContent() {},
    bottomAlignContent() {},
    leftAlignText() {},
    centerAlignText() {},
    rightAlignText() {},
    applyTimerStyle() {
      this.timerStyle = true;
    },
    applyTimeStyle() {},
    applyDateStyle() {},
    applyRelativeStyle() {},
    applyOffsetStyle() {},
    presentSmall: async () => {},
    presentMedium: async () => {},
    presentLarge: async () => {},
    presentExtraLarge: async () => {},
    presentAccessoryRectangular: async () => {},
    presentAccessoryCircular: async () => {},
    presentAccessoryInline: async () => {}
  };
  return node;
}

function makeContext(options = {}) {
  const files = new Map(options.files || []);
  const fm = {
    documentsDirectory: () => '/scriptable',
    joinPath: (a, b) => `${a}/${b}`,
    fileExists: (p) => files.has(p),
    readString: (p) => files.get(p),
    writeString: (p, text) => files.set(p, text)
  };
  const captured = { widget: null, completed: false, opened: [] };

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    config: {
      runsInWidget: options.runsInWidget ?? true,
      runsInAccessoryWidget: false,
      widgetFamily: options.family || 'small'
    },
    args: { queryParameters: options.query || {} },
    Script: {
      setWidget: (w) => { captured.widget = w; },
      complete: () => { captured.completed = true; },
      name: () => '现金流'
    },
    Color: class Color {
      constructor(hex, alpha) { this.hex = hex; this.alpha = alpha; }
      static dynamic(light, dark) { return { dynamic: true, light, dark }; }
      static white() { return new Color('#ffffff'); }
    },
    Font: new Proxy({}, { get: (_t, prop) => (size) => ({ family: String(prop), size }) }),
    Size: class Size {
      constructor(width, height) { this.width = width; this.height = height; }
    },
    LinearGradient: class LinearGradient {
      constructor() { this.colors = []; this.locations = []; }
    },
    ListWidget: class ListWidget {
      constructor() {
        Object.assign(this, makeNode('widget'));
      }
    },
    FileManager: { local: () => fm, iCloud: () => fm },
    SFSymbol: { named: () => ({ image: { sfSymbol: true } }) },
    Pasteboard: { pasteString: () => options.clipboard || '', copyString: () => {} },
    Safari: {
      open: (url) => captured.opened.push(url),
      openInApp: (url) => captured.opened.push(url)
    },
    Alert: class Alert {
      constructor() { this.fields = []; this.actions = []; }
      addTextField(placeholder, value) { this.fields.push({ placeholder, value }); }
      addAction(title) { this.actions.push(title); return this.actions.length - 1; }
      addCancelAction(title) { this.actions.push(title); }
      async present() { return options.alertIndex ?? -1; }
      textFieldValue(i) { return this.fields[i] ? this.fields[i].value : ''; }
    }
  };
  return { sandbox, files, captured };
}

function load(options = {}) {
  const { sandbox, files, captured } = makeContext(options);
  const bootstrap = /\bawait main\(\);\s*$/;
  assert.match(SOURCE, bootstrap, '脚本末尾必须有 await main() 入口');
  const instrumented = SOURCE.replace(bootstrap, `
globalThis.__cf = {
  calculate, buildSchedule, normalizePlan, buildWidget, snapshot,
  decodeSyncPayload, applySync, readState, writeState, sanitizeState,
  resolveActiveDateKey, ensurePlan, emptyState, formatMoney,
  dateKeyOf, dateKeyOfTs, atClock, STATUS_LABEL
};
`);
  const context = vm.createContext(sandbox);
  vm.runInContext(instrumented, context, { filename: 'CashflowWidget.js' });
  return { cf: sandbox.__cf, files, captured, context };
}

const basePlan = {
  date: D,
  salary: 300,
  startTime: '08:30',
  endTime: '17:30',
  breakMinutes: 0,
  breakStart: '12:00'
};

/* ------------------------------ 测试 ------------------------------ */

test('脚本能在模拟的 Scriptable 环境中加载并导出核心函数', () => {
  const { cf } = load();
  for (const key of ['calculate', 'buildSchedule', 'buildWidget', 'decodeSyncPayload', 'applySync']) {
    assert.equal(typeof cf[key], 'function', `缺少导出 ${key}`);
  }
});

test('小组件引擎与网页版引擎在全部时间边界上逐字段一致', () => {
  const { cf } = load();
  const scenarios = [
    ['上班前', basePlan, at(7, 0)],
    ['刚上班', basePlan, at(8, 30)],
    ['工作中', basePlan, at(13, 0, 9) + 1234],
    ['刚下班', basePlan, at(17, 30)],
    ['下班后很久', basePlan, at(23, 59)],
    ['午休中', { ...basePlan, breakMinutes: 60 }, at(12, 30)],
    ['午休结束', { ...basePlan, breakMinutes: 60 }, at(13, 0)],
    ['跨午夜凌晨', { ...basePlan, startTime: '22:00', endTime: '06:00' }, at(2, 0, 10)],
    ['跨午夜下班后', { ...basePlan, startTime: '22:00', endTime: '06:00' }, at(7, 0, 10)],
    ['改工资', { ...basePlan, salary: 888.88 }, at(13, 0)],
    ['改上下班', { ...basePlan, startTime: '10:00', endTime: '15:00' }, at(13, 0)],
    ['零有效时长', { ...basePlan, breakStart: '08:30', breakMinutes: 600 }, at(13, 0)],
    ['非法工资', { ...basePlan, salary: -1 }, at(13, 0)],
    ['非法时间', { ...basePlan, startTime: '99:00' }, at(13, 0)]
  ];

  for (const [name, plan, now] of scenarios) {
    const a = cf.calculate(plan, now);
    const b = webCalculate(plan, now);
    assert.equal(a.ok, b.ok, `${name}: ok`);
    assert.equal(a.status, b.status, `${name}: status`);
    assert.ok(Math.abs(a.earned - b.earned) < 1e-9, `${name}: earned ${a.earned} vs ${b.earned}`);
    assert.ok(Math.abs(a.percent - b.percent) < 1e-9, `${name}: percent`);
    assert.equal(a.elapsedMs, b.elapsedMs, `${name}: elapsedMs`);
    assert.equal(a.remainingMs, b.remainingMs, `${name}: remainingMs`);
    assert.ok(Math.abs(a.perHour - b.perHour) < 1e-9, `${name}: perHour`);
    assert.deepEqual([...a.errors], [...b.errors], `${name}: errors`);
  }
});

test('金额永不超过今日工资，且每毫秒速率与网页版一致', () => {
  const { cf } = load();
  for (let i = 0; i < 40; i += 1) {
    const now = at(0, 0) + i * 45 * 60 * 1000;
    const r = cf.calculate(basePlan, now);
    assert.ok(r.earned >= 0 && r.earned <= basePlan.salary);
    assert.ok(Math.abs(r.perMillisecond - webCalculate(basePlan, now).perMillisecond) < 1e-18);
  }
});

test('6 种小组件尺寸都能渲染，且带有刷新时间与点击地址', () => {
  const families = [
    'small', 'medium', 'large', 'extraLarge',
    'accessoryRectangular', 'accessoryCircular', 'accessoryInline'
  ];
  for (const family of families) {
    const { cf } = load({ family });
    const w = cf.buildWidget(family);
    assert.equal(w.kind, 'widget', `${family} 应返回 ListWidget`);
    assert.ok(w.url, `${family} 应可点击回到网页版`);
    assert.equal(
      Object.prototype.toString.call(w.refreshAfterDate),
      '[object Date]',
      `${family} 应设置 refreshAfterDate`
    );
    assert.ok(w.children.length > 0, `${family} 不应是空组件`);
    const texts = [];
    const walk = (node) => {
      if (node.kind === 'text') texts.push(node.text);
      for (const child of node.children) walk(child);
    };
    walk(w);
    assert.ok(texts.some((t) => t.includes('¥')), `${family} 应显示金额`);
  }
});

test('锁屏内联小组件只放一个图片和一行文字（符合系统限制）', () => {
  const { cf } = load({ family: 'accessoryInline' });
  const w = cf.buildWidget('accessoryInline');
  assert.ok(w.children.length <= 2, '内联小组件最多一个 image + 一个 text');
  assert.ok(w.children.some((n) => n.kind === 'text'));
});

test('桌面小组件含系统计时器，锁屏小组件不依赖计时器', () => {
  const { cf } = load();
  const medium = cf.buildWidget('medium');
  const find = (node, kind) => {
    if (node.kind === kind) return node;
    for (const child of node.children) {
      const hit = find(child, kind);
      if (hit) return hit;
    }
    return null;
  };
  const timer = find(medium, 'date');
  assert.ok(timer && timer.timerStyle, 'medium 应使用 applyTimerStyle 让倒计时持续走动');
  const rect = cf.buildWidget('accessoryRectangular');
  assert.equal(find(rect, 'date'), null, '锁屏矩形不依赖 WidgetDate');
});

test('同步码能被解析，非法码被拒绝', () => {
  const { cf } = load();
  const payload = {
    v: 1,
    date: D,
    plan: { salary: 456.5, startTime: '09:15', endTime: '18:45', breakMinutes: 30, breakStart: '12:30' },
    defaultPlan: { salary: 456.5, startTime: '09:15', endTime: '18:45', breakMinutes: 30, breakStart: '12:30' }
  };
  const parsed = cf.decodeSyncPayload(encodeURIComponent(JSON.stringify(payload)));
  assert.ok(parsed, '应解析合法同步码');
  assert.equal(parsed.plan.salary, 456.5);
  assert.equal(parsed.plan.startTime, '09:15');
  assert.equal(parsed.defaultPlan.breakMinutes, 30);

  const prefixed = cf.decodeSyncPayload(`CFLOW1:${encodeURIComponent(JSON.stringify(payload))}`);
  assert.ok(prefixed, '带前缀的剪贴板同步码也应可用');

  assert.equal(cf.decodeSyncPayload('not-a-payload'), null);
  assert.equal(cf.decodeSyncPayload(''), null);
  assert.equal(cf.decodeSyncPayload(encodeURIComponent(JSON.stringify({ v: 2, date: D }))), null);
  assert.equal(
    cf.decodeSyncPayload(encodeURIComponent(JSON.stringify({ ...payload, date: '2026-02-30' }))),
    null,
    '非法日期必须拒绝'
  );
});

test('同步后计划被持久化，后续计算使用新计划', () => {
  const { cf, files } = load();
  const payload = {
    v: 1,
    date: D,
    plan: { salary: 600, startTime: '08:00', endTime: '16:00', breakMinutes: 0, breakStart: '12:00' },
    defaultPlan: { salary: 600, startTime: '08:00', endTime: '16:00', breakMinutes: 0, breakStart: '12:00' }
  };
  assert.equal(cf.applySync(cf.decodeSyncPayload(encodeURIComponent(JSON.stringify(payload)))), true);
  assert.ok(files.size > 0, '应写入 Scriptable 文档目录');
  const state = cf.readState();
  assert.equal(state.plans[D].salary, 600);
  assert.equal(state.defaultPlan.startTime, '08:00');
  const r = cf.calculate(state.plans[D], at(12, 0));
  assert.ok(Math.abs(r.earned - 300) < 1e-9, '8 小时班上到中午应赚一半');
});

test('损坏或恶意的状态文件会被清洗为合法状态', () => {
  const { cf } = load({
    files: [['/scriptable/cashflow-widget-state.json', '{not json']]
  });
  const state = cf.readState();
  assert.equal(state.defaultPlan.salary, 300);

  const cleaned = cf.sanitizeState({
    defaultPlan: { salary: -5, startTime: '99:00', endTime: '17:30', breakMinutes: 0, breakStart: '12:00' },
    plans: {
      '2026-11-09': { salary: 100, startTime: '09:00', endTime: '18:00', breakMinutes: 0, breakStart: '12:00' },
      'bad-key': { salary: 1 },
      '2026-02-30': { salary: 1 }
    }
  });
  assert.equal(cleaned.defaultPlan.salary, 300, '非法默认计划回退到内置值');
  assert.deepEqual(Object.keys(cleaned.plans), ['2026-11-09'], '非法日期键与非法计划应被过滤');
});

test('跨午夜班次凌晨仍归属前一天，与网页版一致', () => {
  const { cf } = load();
  const night = { ...basePlan, startTime: '22:00', endTime: '06:00' };
  const state = cf.emptyState();
  state.plans['2026-11-08'] = { ...night, date: '2026-11-08' };
  assert.equal(cf.resolveActiveDateKey(state, at(2, 0, 9)), '2026-11-08');
  assert.equal(cf.resolveActiveDateKey(state, at(7, 0, 9)), '2026-11-09');
  assert.equal(webBuild(night).crossesMidnight, true, '网页版也应识别为跨午夜班次');
});

test('零有效时长的计划下，各尺寸仍能渲染且给出明确提示', () => {
  // 午休从上班时刻开始且覆盖整个班次 => 有效工作段为空
  const broken = { ...basePlan, breakStart: '08:30', breakMinutes: 600 };
  const { cf } = load({
    files: [[
      '/scriptable/cashflow-widget-state.json',
      JSON.stringify({ version: 1, defaultPlan: broken, plans: { [D]: broken } })
    ]]
  });
  const r = cf.calculate(cf.readState().plans[D], at(13, 0));
  assert.equal(r.ok, false, '午休长于班次应被判定为无效计划');
  for (const family of ['small', 'medium', 'accessoryRectangular', 'accessoryCircular', 'accessoryInline']) {
    assert.doesNotThrow(() => cf.buildWidget(family), `${family} 不应抛异常`);
  }
  const small = cf.buildWidget('small');
  const texts = [];
  const walk = (node) => {
    if (node.kind === 'text') texts.push(node.text);
    for (const child of node.children) walk(child);
  };
  walk(small);
  assert.ok(texts.some((t) => t.includes('有效工作时长')), '应显示具体错误原因');
});

test('入口在 widget 上下文调用 Script.setWidget 与 Script.complete', async () => {
  const { context, captured } = load({ family: 'small', runsInWidget: true });
  // main 是脚本内的函数声明，在 vm 全局作用域可直接调用
  await vm.runInContext('main()', context);
  assert.ok(captured.widget, '应调用 Script.setWidget');
  assert.equal(captured.completed, true, '应调用 Script.complete');
});
