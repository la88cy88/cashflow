/**
 * 真实浏览器端到端冒烟测试：node tools/smoke.mjs
 *
 * 用本机 Chrome 的 CDP 协议（零依赖，Node 22 内置 WebSocket）验证：
 * 首屏渲染、计划编辑与保存、二次确认、实时金额增长、刷新恢复、
 * 主题/动画开关、视图切换、多尺寸无横向溢出，并输出响应式截图。
 *
 * 可用 CHROME_PATH 指定浏览器路径；截图输出到 /tmp/wb-cashflow-shots。
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LIVE = Boolean(process.env.SMOKE_URL);
const SHOT_DIR = LIVE ? '/tmp/wb-cashflow-live-shots' : '/tmp/wb-cashflow-shots';
const SERVER_PORT = 4173;
const CDP_PORT = 9333;
const BASE = process.env.SMOKE_URL || `http://127.0.0.1:${SERVER_PORT}`;

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find((p) => p && existsSync(p));

if (!CHROME) {
  console.error('未找到 Chrome/Chromium，可设置 CHROME_PATH 后重试');
  process.exit(2);
}

const notes = [];
const failures = [];
const runtimeErrors = [];

function must(condition, message) {
  if (condition) notes.push(message);
  else failures.push(message);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitForTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {
      /* 服务器还没起来 */
    }
    await sleep(150);
  }
  throw new Error('本地服务器未就绪');
}

let server;
let chrome;
let profile;

try {
  await mkdir(SHOT_DIR, { recursive: true });
  profile = await mkdtemp(join(tmpdir(), 'wb-cashflow-chrome-'));

  if (!LIVE) {
    server = spawn(process.execPath, ['tools/serve.mjs'], {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, PORT: String(SERVER_PORT) }
    });
  }
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-allow-origins=*',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  if (server) await waitForServer();
  const wsUrl = await waitForTarget();
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  const cdp = new CDP(ws);

  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      runtimeErrors.push(msg.params.entry.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      runtimeErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  /* 1. 首屏渲染 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(1600);

  const firstAmount = await evaluate(cdp, `document.getElementById('amountRoot').textContent`);
  must(/^¥\d+\.\d{6}$/.test(firstAmount), `首屏金额渲染为 6 位小数：${firstAmount}`);
  const statusLabel = await evaluate(cdp, `document.getElementById('statusLabel').textContent`);
  must(statusLabel.length > 0, `工作状态显示：${statusLabel}`);
  const clock = await evaluate(cdp, `document.getElementById('heroClock').textContent`);
  must(/^\d{2}:\d{2}:\d{2}$/.test(clock), `当前时间显示：${clock}`);
  const swStatus = await evaluate(
    cdp,
    `navigator.serviceWorker
      ? navigator.serviceWorker.getRegistration('./').then((r) =>
          r ? (r.active ? 'active' : r.installing ? 'installing' : 'waiting') : 'none'
        )
      : 'unsupported'`
  );
  must(['active', 'installing', 'waiting'].includes(swStatus), `Service Worker 已注册：${swStatus}`);

  /* 2. 打开计划面板、填写并保存 */
  await evaluate(cdp, `document.getElementById('btnEditPlan').click()`);
  await sleep(200);
  must(!(await evaluate(cdp, `document.getElementById('planSheet').hidden`)), '「编辑今日计划」可打开设置面板');

  const preview = await evaluate(cdp, `(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('fSalary', '600');
    set('fStart', '00:00');
    set('fEnd', '23:59');
    set('fBreakMinutes', '0');
    set('fBreakStart', '12:00');
    return document.getElementById('planPreview').textContent;
  })()`);
  must(/有效工作时长/.test(preview), `表单实时预览计算：${preview.slice(0, 46)}`);

  await evaluate(cdp, `document.getElementById('btnSaveToday').click()`);
  await sleep(300);
  must(await evaluate(cdp, `document.getElementById('planSheet').hidden`), '保存后面板自动关闭');
  const goal = await evaluate(cdp, `document.getElementById('goalAmount').textContent`);
  must(goal === '¥600.00', `目标工资已按新计划更新：${goal}`);
  const stored = await evaluate(cdp, `Object.keys(JSON.parse(localStorage.getItem('dgr:v1:plans') || '{}')).length`);
  must(stored >= 1, `每日计划已写入 LocalStorage：${stored} 条`);

  /* 3. 金额随真实时间增长 */
  await sleep(300);
  const amountA = await evaluate(cdp, `document.getElementById('amountRoot').textContent`);
  await sleep(900);
  const amountB = await evaluate(cdp, `document.getElementById('amountRoot').textContent`);
  must(Number.parseFloat(amountB.slice(1)) > Number.parseFloat(amountA.slice(1)), `金额实时增长：${amountA} → ${amountB}`);

  /* 4. 工作中修改计划 -> 二次确认 -> 取消不生效 */
  await evaluate(cdp, `document.getElementById('btnEditPlan').click()`);
  await sleep(150);
  await evaluate(cdp, `(() => {
    const el = document.getElementById('fSalary');
    el.value = '700';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate(cdp, `document.getElementById('btnSaveToday').click()`);
  await sleep(250);
  must(
    !(await evaluate(cdp, `document.getElementById('confirmDialog').hidden`)),
    '工作进行中修改计划会弹出二次确认'
  );
  await evaluate(cdp, `document.getElementById('confirmCancel').click()`);
  await sleep(150);
  must(
    (await evaluate(cdp, `document.getElementById('goalAmount').textContent`)) === '¥600.00',
    '取消确认后原计划保持不变'
  );
  await evaluate(cdp, `document.getElementById('btnPlanCancel').click()`);

  /* 5. 设置项与视图切换 */
  await evaluate(cdp, `document.querySelector('[data-theme-value="dark"]').click()`);
  must((await evaluate(cdp, `document.documentElement.dataset.theme`)) === 'dark', '深色模式切换生效');
  await evaluate(cdp, `document.getElementById('animSwitch').click()`);
  must(
    (await evaluate(cdp, `document.getElementById('animSwitch').getAttribute('aria-checked')`)) === 'false',
    '动画开关可关闭'
  );
  await evaluate(cdp, `document.querySelector('[data-view="overview"]').click()`);
  must(!(await evaluate(cdp, `document.getElementById('view-overview').hidden`)), '「概览」标签可切换');
  await evaluate(cdp, `document.querySelector('[data-view="settings"]').click()`);
  must(!(await evaluate(cdp, `document.getElementById('view-settings').hidden`)), '「设置」标签可切换');
  await evaluate(cdp, `document.querySelector('[data-view="home"]').click()`);

  /* 6. 刷新后按真实时间恢复，不丢进度 */
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  const restoredGoal = await evaluate(cdp, `document.getElementById('goalAmount').textContent`);
  must(restoredGoal === '¥600.00', `刷新后今日计划保留：${restoredGoal}`);
  must((await evaluate(cdp, `document.documentElement.dataset.theme`)) === 'dark', '刷新后主题保留');
  const restoredAmount = await evaluate(cdp, `document.getElementById('amountRoot').textContent`);
  must(
    Number.parseFloat(restoredAmount.slice(1)) >= Number.parseFloat(amountB.slice(1)),
    `刷新后金额按真实时间校正且不回退：${restoredAmount}`
  );

  /* 7. 浅色模式视觉复核 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });
  await evaluate(cdp, `document.querySelector('[data-theme-value="light"]').click()`);
  await sleep(350);
  const lightShot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  });
  await writeFile(join(SHOT_DIR, 'iphone-390-light.png'), Buffer.from(lightShot.data, 'base64'));
  must((await evaluate(cdp, `document.documentElement.dataset.theme`)) === 'light', '浅色模式切换生效');
  await evaluate(cdp, `document.querySelector('[data-theme-value="dark"]').click()`);

  /* 8. iPhone 与桌面尺寸响应式截图 + 横向溢出检查 */
  const viewports = [
    ['iphone-se-320', 320, 568, 2, true],
    ['iphone-390', 390, 844, 2, true],
    ['iphone-promax-430', 430, 932, 2, true],
    ['desktop-1280', 1280, 900, 1, false]
  ];
  for (const [name, width, height, dpr, mobile] of viewports) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile
    });
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(SHOT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'));
    const overflow = await evaluate(
      cdp,
      `document.documentElement.scrollWidth - document.documentElement.clientWidth`
    );
    must(overflow <= 1, `${name} 无横向溢出（溢出 ${overflow}px）`);
  }

  /* 8b. 小组件引导页：渲染、脚本载入、同步入口、iPhone 尺寸 */
  const widgetEntry = await evaluate(
    cdp,
    `(() => {
       const a = document.querySelector('a.list__row[href="./widget.html"]');
       return a ? { found: true, color: getComputedStyle(a).color } : { found: false };
     })()`
  );
  must(widgetEntry.found, '设置页存在小组件入口链接');
  must(
    widgetEntry.found && widgetEntry.color !== 'rgb(0, 0, 238)',
    `入口链接已套用应用内配色：${widgetEntry.color || '—'}`
  );

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });
  await cdp.send('Page.navigate', { url: `${BASE.replace(/\/$/, '')}/widget.html` });
  await sleep(1600);
  const widgetTitle = await evaluate(cdp, `document.title`);
  must(widgetTitle.includes('小组件'), `小组件页标题：${widgetTitle}`);
  const widgetAmount = await evaluate(cdp, `document.getElementById('wpAmount').textContent`);
  must(/^¥\d+\.\d{2}$/.test(widgetAmount), `小组件页读到今日计划：${widgetAmount}`);
  const widgetMeta = await evaluate(cdp, `document.getElementById('wpMeta').textContent`);
  must(/\d{4}-\d{2}-\d{2}/.test(widgetMeta), `小组件页显示日期与班次：${widgetMeta.slice(0, 46)}`);
  const scriptLen = await evaluate(cdp, `document.getElementById('wpScript').value.length`);
  must(scriptLen > 10000, `Scriptable 脚本已载入页面（${scriptLen} 字符）`);
  const syncButtons = await evaluate(
    cdp,
    `Boolean(document.getElementById('wpSync') && document.getElementById('wpCopyScript') && document.getElementById('wpCopyCode'))`
  );
  must(syncButtons, '复制脚本 / 同步 / 复制同步码按钮齐全');
  const widgetShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(SHOT_DIR, 'widget-390.png'), Buffer.from(widgetShot.data, 'base64'));
  const widgetOverflow = await evaluate(
    cdp,
    `document.documentElement.scrollWidth - document.documentElement.clientWidth`
  );
  must(widgetOverflow <= 1, `小组件页无横向溢出（溢出 ${widgetOverflow}px）`);

  must(runtimeErrors.length === 0, `运行期无 JS 异常${runtimeErrors.length ? `：${runtimeErrors.join(' | ').slice(0, 300)}` : ''}`);

  /* 9. 断网后仍能从 Service Worker 缓存打开并计算（先回到干净导航状态） */
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2500);
  let swReady = false;
  for (let i = 0; i < 20; i += 1) {
    const state = await evaluate(
      cdp,
      `navigator.serviceWorker.getRegistration('./').then((r) =>
        r && r.active && navigator.serviceWorker.controller ? 'ready' : 'pending'
      )`
    );
    if (state === 'ready') {
      swReady = true;
      break;
    }
    await sleep(400);
  }
  must(swReady, 'Service Worker 已接管页面（具备离线能力）');
  if (swReady) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0
    });
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(1800);
    const offlineText = await evaluate(cdp, `document.getElementById('amountRoot').textContent`);
    must(/^¥\d+\.\d{6}$/.test(offlineText), `断网后仍可打开并实时计算：${offlineText}`);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
  }

  ws.close();
} catch (error) {
  failures.push(`执行中断：${error.stack || error.message}`);
} finally {
  if (chrome) chrome.kill('SIGTERM');
  if (server) server.kill('SIGTERM');
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
}

for (const note of notes) console.log(`  ✓ ${note}`);
if (runtimeErrors.length) {
  console.log('\n浏览器控制台错误：');
  for (const err of runtimeErrors) console.log(`  ! ${err.slice(0, 260)}`);
}
console.log(`\n截图目录：${SHOT_DIR}`);
if (failures.length) {
  console.error(`\n✖ 冒烟测试失败：${notes.length} 项通过，${failures.length} 项问题`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✅ 真实浏览器冒烟测试全部通过：${notes.length} 项`);
