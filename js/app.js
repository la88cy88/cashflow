/**
 * 应用入口：状态编排、真实时间循环、事件绑定、PWA 注册。
 *
 * 刷新策略：
 *   主循环 requestAnimationFrame —— 高频视觉刷新；
 *   1 秒间隔与 visibilitychange / pageshow / focus —— 重新按 Date.now() 校准。
 *   所有路径都只调用 calculate(plan, Date.now())，绝不累加任何金额。
 */

import { calculate, dueMilestones, normalizePlan, DEFAULT_TEMPLATE } from './engine.js';
import * as store from './store.js';
import { dateKeyOfTs, shortDateOfKey } from './time.js';
import { createUI } from './ui.js';
import { pickQuote } from './quotes.js';
import * as fx from './effects.js';

const ui = createUI();
const els = ui.els;

let prefs = store.getPrefs();
let activeDateKey = null;
let plan = null;
let lastStatus = null;
let lastSecond = -1;
let systemDateKey = dateKeyOfTs(Date.now());

// 里程碑记录缓存，避免每帧读 LocalStorage
let firedKey = null;
let firedList = [];

function getFired() {
  if (firedKey !== activeDateKey) {
    firedKey = activeDateKey;
    firedList = store.getMilestones(activeDateKey);
  }
  return firedList;
}

/* ------------------------------ 主题 ------------------------------ */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const theme = prefs.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : prefs.theme;
  document.documentElement.dataset.theme = theme;
  document
    .getElementById('metaThemeColor')
    .setAttribute('content', theme === 'dark' ? '#0b0f16' : '#f2f3f7');
}

if (typeof darkQuery.addEventListener === 'function') {
  darkQuery.addEventListener('change', applyTheme);
} else if (typeof darkQuery.addListener === 'function') {
  darkQuery.addListener(applyTheme);
}

/* ------------------------------ 计划状态 ------------------------------ */

function refreshPlan(now = Date.now()) {
  const key = store.resolveActiveDateKey(now, store.getPlans());
  const result = store.ensurePlan(key, now);
  activeDateKey = key;
  plan = result.plan;
  if (result.created) store.prunePlans(400, now);
  return result.created;
}

function refreshSecondary() {
  ui.renderSettings(prefs, store.getDefaults(), plan);
  ui.renderOverview(store.getHistory(7, activeDateKey), prefs);
  ui.setPlanHint(
    plan.confirmed
      ? `${shortDateOfKey(activeDateKey)} 的计划已保存 · 按真实时间实时结算`
      : '已沿用常用默认计划，点上方按钮可随时调整'
  );
}

/* ------------------------------ 每帧 / 每秒 ------------------------------ */

function checkMilestones(snap) {
  if (!snap.ok) return;
  const due = dueMilestones(snap.percent, getFired());
  if (!due.length) return;
  for (const level of due) {
    store.markMilestone(activeDateKey, level);
    firedList.push(level);
  }
  const top = due[due.length - 1];
  if (top === 100) fx.celebrate(els.fxLayer);
  else {
    fx.playMilestone(top, els.fxLayer);
    fx.pulseProgress(els.progressTrack);
  }
}

function checkRollover(now, systemKey) {
  systemDateKey = systemKey;
  const desired = store.resolveActiveDateKey(now, store.getPlans());
  if (desired === activeDateKey) return;
  const created = refreshPlan(now);
  firedKey = null;
  lastStatus = null;
  refreshSecondary();
  ui.showToast(created ? '已切换到新的一天，自动沿用常用默认计划' : '跨日班次结束，已切换到新的一天');
}

function tick() {
  const now = Date.now();
  const systemKey = dateKeyOfTs(now);
  const snap = calculate(plan, now);

  ui.render(snap, { prefs, activeDateKey, systemDateKey: systemKey });

  if (snap.ok) {
    if (snap.status !== lastStatus) {
      lastStatus = snap.status;
      ui.setQuote(pickQuote(snap.status));
      fx.pulseAmount(els.amountRoot);
    }
  } else if (lastStatus !== 'invalid') {
    lastStatus = 'invalid';
    ui.setQuote(pickQuote('invalid'));
  }

  const second = Math.floor(now / 1000);
  if (second !== lastSecond) {
    lastSecond = second;
    checkMilestones(snap);
    checkRollover(now, systemKey);
  }
}

function forceTick() {
  lastSecond = -1;
  tick();
}

function frame() {
  tick();
  requestAnimationFrame(frame);
}

/* ------------------------------ 计划编辑 ------------------------------ */

function openTodayPlan() {
  ui.openPlanSheet('today', plan, activeDateKey, prefs.currency);
}

function openDefaultsPlan() {
  ui.openPlanSheet('defaults', store.getDefaults(), activeDateKey, prefs.currency);
}

async function handleSavePlan() {
  if (!ui.updatePreview()) {
    ui.showToast('请先修正计划中的错误');
    return;
  }
  const norm = normalizePlan(ui.readPlanForm());
  if (!norm.ok) {
    ui.showToast(norm.errors[0]);
    return;
  }
  const next = norm.plan;
  const isToday = ui.sheetMode === 'today';

  if (isToday) {
    const snap = calculate(plan, Date.now());
    const started = snap.ok && snap.elapsedMs > 0 && snap.status !== 'before';
    const changed = ['salary', 'startTime', 'endTime', 'breakMinutes', 'breakStart'].some(
      (key) => next[key] !== plan[key]
    );
    if (started && changed) {
      const ok = await ui.showConfirm({
        title: '工作已开始，确认修改？',
        body: '修改工资或上下班时间后，今日收入会立即按新计划重新计算，进度也随之变化。其他日期的记录不受影响。',
        okText: '重新计算'
      });
      if (!ok) return;
    }
    store.savePlan(activeDateKey, next);
    plan = next;
    store.resetMilestones(activeDateKey);
    firedKey = null;
    lastStatus = null;
    ui.closePlanSheet();
    refreshSecondary();
    ui.showToast('今日计划已保存，已按真实时间重新结算');
    forceTick();
  } else {
    store.saveDefaults(next);
    ui.closePlanSheet();
    refreshSecondary();
    ui.showToast('默认设置已保存，新的一天自动沿用');
  }
}

function handleSaveAsDefault() {
  if (!ui.updatePreview()) {
    ui.showToast('请先修正计划中的错误');
    return;
  }
  const norm = normalizePlan(ui.readPlanForm());
  if (!norm.ok) {
    ui.showToast(norm.errors[0]);
    return;
  }
  store.saveDefaults(norm.plan);
  refreshSecondary();
  ui.showToast('已保存为默认值，明天自动沿用');
}

function handleRestore() {
  const data = ui.sheetMode === 'today' ? store.getDefaults() : DEFAULT_TEMPLATE;
  ui.fillPlanForm(data, ui.sheetDateKey);
  ui.showToast('已填入表单，点击保存后生效');
}

/* ------------------------------ 数据管理 ------------------------------ */

function handleExport() {
  const blob = new Blob([store.exportData()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cashflow-backup-${dateKeyOfTs(Date.now())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  ui.showToast('备份文件已导出');
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    ui.showToast('读取文件失败');
    event.target.value = '';
    return;
  }
  const ok = await ui.showConfirm({
    title: '从备份恢复？',
    body: '当前设备上的全部计划与设置将被备份文件覆盖，此操作不可撤销。建议先导出一份现有数据。',
    okText: '覆盖恢复'
  });
  if (!ok) {
    event.target.value = '';
    return;
  }
  const result = store.importData(text);
  ui.showToast(result.message);
  event.target.value = '';
  if (result.ok) window.setTimeout(() => location.reload(), 600);
}

async function handleClearAll() {
  const ok = await ui.showConfirm({
    title: '清空所有本地数据？',
    body: '将删除全部每日计划、默认设置、偏好与里程碑记录，且无法恢复。',
    okText: '清空'
  });
  if (!ok) return;
  store.clearAll();
  ui.showToast('已清空，正在重新载入');
  window.setTimeout(() => location.reload(), 500);
}

/* ------------------------------ 事件绑定 ------------------------------ */

for (const tab of els.tabs) {
  tab.addEventListener('click', () => {
    const view = tab.dataset.view;
    ui.setView(view);
    if (view === 'overview') ui.renderOverview(store.getHistory(7, activeDateKey), prefs);
    if (view === 'settings') ui.renderSettings(prefs, store.getDefaults(), plan);
  });
}

els.btnQuickSettings.addEventListener('click', openTodayPlan);
els.btnEditPlan.addEventListener('click', openTodayPlan);
els.btnOpenPlanFromSettings.addEventListener('click', openTodayPlan);
els.btnEditDefaults.addEventListener('click', openDefaultsPlan);
els.btnPlanCancel.addEventListener('click', ui.closePlanSheet);
els.planBackdrop.addEventListener('click', ui.closePlanSheet);
els.btnPlanSave.addEventListener('click', handleSavePlan);
els.btnSaveToday.addEventListener('click', handleSavePlan);
els.btnSaveDefault.addEventListener('click', handleSaveAsDefault);
els.btnRestoreDefault.addEventListener('click', handleRestore);

for (const input of [
  els.fSalary,
  els.fStart,
  els.fEnd,
  els.fBreakMinutes,
  els.fBreakStart
]) {
  input.addEventListener('input', ui.updatePreview);
  input.addEventListener('change', ui.updatePreview);
}

els.confirmCancel.addEventListener('click', () => ui.resolveConfirm(false));
els.confirmBackdrop.addEventListener('click', () => ui.resolveConfirm(false));
els.confirmOk.addEventListener('click', () => ui.resolveConfirm(true));

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (ui.isConfirmOpen()) ui.resolveConfirm(false);
  else if (!els.planSheet.hidden) ui.closePlanSheet();
});

els.btnRefreshQuote.addEventListener('click', () => {
  ui.setQuote(pickQuote(lastStatus && lastStatus !== 'invalid' ? lastStatus : 'working'));
});

for (const btn of els.themeSegmented.querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    prefs = store.savePrefs({ theme: btn.dataset.themeValue });
    applyTheme();
    ui.renderSettings(prefs, store.getDefaults(), plan);
  });
}

els.animSwitch.addEventListener('click', () => {
  prefs = store.savePrefs({ animations: !prefs.animations });
  fx.setEffectsEnabled(prefs.animations);
  ui.renderSettings(prefs, store.getDefaults(), plan);
  ui.showToast(prefs.animations ? '动画已开启' : '动画已关闭，金额仍实时更新');
});

els.btnExport.addEventListener('click', handleExport);
els.btnImport.addEventListener('click', () => els.fileImport.click());
els.fileImport.addEventListener('change', handleImportFile);
els.btnClearAll.addEventListener('click', handleClearAll);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) forceTick();
});
window.addEventListener('pageshow', forceTick);
window.addEventListener('focus', forceTick);
window.addEventListener('online', forceTick);

/* ------------------------------ PWA ------------------------------ */

function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              ui.showUpdateBar();
            }
          });
        });
      })
      .catch(() => {
        /* 离线或不支持时静态页面依然可用 */
      });
  });
}

els.btnApplyUpdate.addEventListener('click', () => {
  const controller = navigator.serviceWorker?.controller;
  if (controller) controller.postMessage({ type: 'SKIP_WAITING' });
  else location.reload();
  ui.hideUpdateBar();
});

/* ------------------------------ 启动 ------------------------------ */

refreshPlan();
applyTheme();
fx.setEffectsEnabled(prefs.animations);
refreshSecondary();
ui.setView('home');

const initial = calculate(plan, Date.now());
ui.setQuote(pickQuote(initial.ok ? initial.status : 'invalid'));

if (!store.isStoragePersistent()) {
  ui.showToast('浏览器禁用了本地存储，本次数据仅在当前页面有效');
}

forceTick();
requestAnimationFrame(frame);
// 校准兜底：仅触发重新计算，不累加金额；后台时省电跳过
window.setInterval(() => {
  if (!document.hidden) forceTick();
}, 1000);
setupServiceWorker();
