/**
 * 「桌面与锁屏小组件」引导页。
 *
 * 只做三件事：读取网页版当前计划、把 Scriptable 脚本交给用户、生成同步链接。
 * 不联网、不上传任何数据；同步通过 iOS URL scheme 在本机完成。
 */

import * as store from './store.js';
import { calculate, normalizePlan, formatMoney } from './engine.js';
import { weekdayOfKey, formatMinutes } from './time.js';

const SCRIPT_PATH = './widget/CashflowWidget.js';
const SYNC_PREFIX = 'CFLOW1:';
const NAME_KEY = 'cashflow.widget.scriptName';
const DEFAULT_NAME = '现金流';

const $ = (id) => document.getElementById(id);
const els = {
  amount: $('wpAmount'),
  meta: $('wpMeta'),
  status: $('wpStatus'),
  copyScript: $('wpCopyScript'),
  download: $('wpDownload'),
  script: $('wpScript'),
  scriptName: $('wpScriptName'),
  sync: $('wpSync'),
  copyCode: $('wpCopyCode')
};

let scriptText = '';
let statusTimer = 0;

/* ------------------------------ 主题 ------------------------------ */

function applyTheme() {
  const prefs = store.getPrefs();
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = prefs.theme === 'auto' ? (dark ? 'dark' : 'light') : prefs.theme;
  document.documentElement.dataset.theme = theme;
  $('metaThemeColor').setAttribute('content', theme === 'dark' ? '#0b0f16' : '#f2f3f7');
}

applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

/* ------------------------------ 状态提示 ------------------------------ */

function say(message, isError) {
  els.status.textContent = message;
  els.status.hidden = false;
  els.status.classList.toggle('notice--error', Boolean(isError));
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    els.status.hidden = true;
  }, 6000);
}

/* ------------------------------ 当前计划 ------------------------------ */

function currentPlan() {
  const now = Date.now();
  const key = store.resolveActiveDateKey(now, store.getPlans());
  const result = store.ensurePlan(key, now);
  if (result.created) store.prunePlans(400, now);
  const norm = normalizePlan(result.plan);
  return {
    dateKey: key,
    plan: norm.ok ? norm.plan : result.plan,
    defaults: store.getDefaults()
  };
}

function renderPlan() {
  const { dateKey, plan } = currentPlan();
  const snap = calculate(plan, Date.now());
  els.amount.textContent = `¥${formatMoney(plan.salary, 2)}`;
  const parts = [
    `${dateKey} ${weekdayOfKey(dateKey)}`,
    `${plan.startTime}–${plan.endTime}`,
    plan.breakMinutes ? `午休 ${formatMinutes(plan.breakMinutes)}` : '无午休'
  ];
  if (snap.ok) parts.push(`时薪 ¥${formatMoney(snap.perHour, 2)}`);
  els.meta.textContent = parts.join(' · ');
}

function syncPayload() {
  const { dateKey, plan, defaults } = currentPlan();
  return {
    v: 1,
    date: dateKey,
    plan: {
      salary: plan.salary,
      startTime: plan.startTime,
      endTime: plan.endTime,
      breakMinutes: plan.breakMinutes,
      breakStart: plan.breakStart
    },
    defaultPlan: {
      salary: defaults.salary,
      startTime: defaults.startTime,
      endTime: defaults.endTime,
      breakMinutes: defaults.breakMinutes,
      breakStart: defaults.breakStart
    },
    at: Date.now()
  };
}

/* ------------------------------ 剪贴板 ------------------------------ */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function scriptName() {
  const name = els.scriptName.value.trim() || DEFAULT_NAME;
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* 隐私模式下不持久化也不影响本次使用 */
  }
  return name;
}

try {
  const savedName = localStorage.getItem(NAME_KEY);
  if (savedName) els.scriptName.value = savedName;
} catch {
  /* 忽略 */
}
els.scriptName.addEventListener('change', scriptName);

/* ------------------------------ 脚本载入 ------------------------------ */

async function loadScript() {
  try {
    const response = await fetch(SCRIPT_PATH, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    scriptText = await response.text();
    els.script.value = scriptText;
  } catch {
    scriptText = '';
    els.script.value = '脚本载入失败，请点「下载 .js」后用文件方式复制。';
  }
}

els.copyScript.addEventListener('click', async () => {
  if (!scriptText) await loadScript();
  if (!scriptText) {
    say('脚本未载入，请改用「下载 .js」', true);
    return;
  }
  const ok = await copyText(scriptText);
  say(ok ? '脚本已复制，去 Scriptable 新建脚本并粘贴' : '复制失败，可展开下方文本框手动全选复制', !ok);
});

els.download.addEventListener('click', async (event) => {
  if (!scriptText) await loadScript();
  if (!scriptText) return;
  event.preventDefault();
  const blob = new Blob([scriptText], { type: 'text/javascript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'CashflowWidget.js';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  say('脚本已下载，可在「文件」App 里打开并复制内容');
});

/* ------------------------------ 同步 ------------------------------ */

function syncUrl() {
  const name = scriptName();
  const json = JSON.stringify(syncPayload());
  return `scriptable:///run?scriptName=${encodeURIComponent(name)}&cflow=${encodeURIComponent(json)}`;
}

els.sync.addEventListener('click', () => {
  const url = syncUrl();
  say('正在打开 Scriptable… 若没反应，请点「复制同步码」');
  renderPlan();
  // 自定义 URL scheme：交给系统拉起 Scriptable，本机完成，不产生任何网络请求
  window.location.assign(url);
});

els.copyCode.addEventListener('click', async () => {
  const code = `${SYNC_PREFIX}${JSON.stringify(syncPayload())}`;
  const ok = await copyText(code);
  say(ok ? '同步码已复制，去 Scriptable 运行脚本选「从剪贴板导入同步码」' : '复制失败，请重试', !ok);
});

window.addEventListener('pageshow', renderPlan);

renderPlan();
loadScript();
