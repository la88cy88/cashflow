/**
 * DOM 层：只负责渲染与交互控件，不持有业务状态。
 * 所有写 DOM 的操作都做 diff，配合 requestAnimationFrame 高频调用也不会产生多余写入。
 */

import {
  buildSchedule,
  STATUS_META,
  formatCurrency,
  formatPercent,
  formatWorkDuration
} from './engine.js';
import {
  longDateOfKey,
  shortDateOfKey,
  weekdayOfKey,
  timeOfDayOfTs,
  formatDuration
} from './time.js';
import { RollingNumber } from './number.js';

const $ = (id) => document.getElementById(id);

function setText(el, value) {
  const next = String(value ?? '');
  if (el.textContent !== next) el.textContent = next;
}

function setAttr(el, name, value) {
  const next = String(value);
  if (el.getAttribute(name) !== next) el.setAttribute(name, next);
}

function setHidden(el, hidden) {
  el.classList.toggle('is-hidden', Boolean(hidden));
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

export function createUI() {
  const els = {
    // 首页
    heroDate: $('heroDate'),
    heroWeek: $('heroWeek'),
    heroClock: $('heroClock'),
    crossdayBanner: $('crossdayBanner'),
    crossdayText: $('crossdayText'),
    statusPill: $('statusPill'),
    statusLabel: $('statusLabel'),
    amountRoot: $('amountRoot'),
    goalAmount: $('goalAmount'),
    percentText: $('percentText'),
    progressTrack: $('progressTrack'),
    progressFill: $('progressFill'),
    progressCoin: $('progressCoin'),
    elapsedText: $('elapsedText'),
    remainingText: $('remainingText'),
    startText: $('startText'),
    endText: $('endText'),
    breakText: $('breakText'),
    errorBox: $('errorBox'),
    warningBox: $('warningBox'),
    rateHour: $('rateHour'),
    rateMinute: $('rateMinute'),
    rateSecond: $('rateSecond'),
    totalDuration: $('totalDuration'),
    quoteText: $('quoteText'),
    planHint: $('planHint'),
    // 概览
    summaryTotal: $('summaryTotal'),
    summaryDays: $('summaryDays'),
    historyList: $('historyList'),
    fileImport: $('fileImport'),
    // 设置
    themeSegmented: $('themeSegmented'),
    animSwitch: $('animSwitch'),
    defaultsSummary: $('defaultsSummary'),
    settingsPlanSummary: $('settingsPlanSummary'),
    // 计划面板
    planBackdrop: $('planBackdrop'),
    planSheet: $('planSheet'),
    planTitle: $('planTitle'),
    sheetDate: $('sheetDate'),
    sheetNote: $('sheetNote'),
    currencyPrefix: $('currencyPrefix'),
    fSalary: $('fSalary'),
    fStart: $('fStart'),
    fEnd: $('fEnd'),
    fBreakMinutes: $('fBreakMinutes'),
    fBreakStart: $('fBreakStart'),
    planPreview: $('planPreview'),
    btnSaveToday: $('btnSaveToday'),
    btnSaveDefault: $('btnSaveDefault'),
    btnRestoreDefault: $('btnRestoreDefault'),
    // 确认框 / 提示
    confirmBackdrop: $('confirmBackdrop'),
    confirmDialog: $('confirmDialog'),
    confirmTitle: $('confirmTitle'),
    confirmBody: $('confirmBody'),
    confirmCancel: $('confirmCancel'),
    confirmOk: $('confirmOk'),
    toast: $('toast'),
    fxLayer: $('fxLayer'),
    updateBar: $('updateBar'),
    btnApplyUpdate: $('btnApplyUpdate'),
    // 动作按钮
    btnQuickSettings: $('btnQuickSettings'),
    btnEditPlan: $('btnEditPlan'),
    btnOpenPlanFromSettings: $('btnOpenPlanFromSettings'),
    btnEditDefaults: $('btnEditDefaults'),
    btnPlanCancel: $('btnPlanCancel'),
    btnPlanSave: $('btnPlanSave'),
    btnRefreshQuote: $('btnRefreshQuote'),
    btnExport: $('btnExport'),
    btnImport: $('btnImport'),
    btnClearAll: $('btnClearAll'),
    // 导航
    views: {
      home: $('view-home'),
      overview: $('view-overview'),
      settings: $('view-settings')
    },
    tabs: Array.from(document.querySelectorAll('.tab'))
  };

  const amount = new RollingNumber(els.amountRoot);
  let sheetMode = 'today';
  let sheetDateKey = '';
  let currency = '¥';
  let toastTimer = null;
  let confirmResolve = null;

  /* ------------------------------ 首页渲染 ------------------------------ */

  function render(snap, ctx) {
    const { prefs, activeDateKey, systemDateKey } = ctx;
    currency = prefs.currency;

    setText(els.heroDate, shortDateOfKey(activeDateKey));
    setText(els.heroWeek, weekdayOfKey(activeDateKey));
    setText(els.heroClock, timeOfDayOfTs(snap.now));

    const crossday = activeDateKey !== systemDateKey;
    setHidden(els.crossdayBanner, !crossday);
    if (crossday) {
      setText(
        els.crossdayText,
        `${shortDateOfKey(activeDateKey)} 的跨日班次进行中，下班后自动切换到新的一天`
      );
    }

    if (!snap.ok) {
      amount.update(`${prefs.currency}0.000000`, false);
      setText(els.statusLabel, STATUS_META.invalid.label);
      setAttr(els.statusPill, 'data-status', 'invalid');
      setText(els.errorBox, snap.errors.join('；'));
      setHidden(els.errorBox, false);
      setHidden(els.warningBox, true);
      setText(els.goalAmount, `${prefs.currency}—`);
      setText(els.percentText, '—');
      els.progressFill.style.width = '0%';
      els.progressCoin.style.left = '2%';
      setText(els.elapsedText, '00:00:00');
      setText(els.remainingText, '00:00:00');
      for (const el of [els.rateHour, els.rateMinute, els.rateSecond, els.totalDuration]) {
        setText(el, '—');
      }
      setText(els.startText, '--:--');
      setText(els.endText, '--:--');
      setText(els.breakText, '—');
      return;
    }

    setHidden(els.errorBox, true);

    const text = formatCurrency(snap.earned, prefs.currency, 6);
    const scale = text.length > 12 ? Math.max(0.6, 12 / text.length) : 1;
    const scaleStr = scale.toFixed(3);
    if (els.amountRoot.style.getPropertyValue('--amount-scale') !== scaleStr) {
      els.amountRoot.style.setProperty('--amount-scale', scaleStr);
    }
    amount.update(text, prefs.animations);

    setText(els.statusLabel, STATUS_META[snap.status].label);
    setAttr(els.statusPill, 'data-status', snap.status);
    setText(els.goalAmount, `${prefs.currency}${snap.salary.toFixed(2)}`);
    setText(els.percentText, formatPercent(snap.percent));

    els.progressFill.style.width = `${snap.percent.toFixed(4)}%`;
    els.progressCoin.style.left = `${Math.max(2, Math.min(98, snap.percent)).toFixed(3)}%`;
    setText(els.elapsedText, formatWorkDuration(snap.elapsedMs));
    setText(els.remainingText, formatWorkDuration(snap.remainingMs));

    setText(els.startText, snap.plan.startTime);
    setText(els.endText, snap.crossesMidnight ? `${snap.plan.endTime} 次日` : snap.plan.endTime);
    setText(els.breakText, snap.plan.breakMinutes ? `${snap.plan.breakMinutes} 分` : '无');

    setText(els.rateHour, `${prefs.currency}${snap.perHour.toFixed(2)}`);
    setText(els.rateMinute, `${prefs.currency}${snap.perMinute.toFixed(4)}`);
    setText(els.rateSecond, `${prefs.currency}${snap.perSecond.toFixed(6)}`);
    setText(els.totalDuration, formatWorkDuration(snap.totalEffectiveMs));

    const warnings = snap.warnings || [];
    setHidden(els.warningBox, warnings.length === 0);
    if (warnings.length) setText(els.warningBox, warnings.join('；'));
  }

  function setQuote(text) {
    setText(els.quoteText, text);
  }

  function setPlanHint(text) {
    setText(els.planHint, text);
  }

  /* ------------------------------ 视图切换 ------------------------------ */

  function setView(name) {
    for (const [key, view] of Object.entries(els.views)) {
      const active = key === name;
      view.hidden = !active;
      view.classList.toggle('is-active', active);
    }
    for (const tab of els.tabs) {
      const active = tab.dataset.view === name;
      tab.classList.toggle('is-active', active);
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    window.scrollTo(0, 0);
  }

  /* ------------------------------ 概览 ------------------------------ */

  function renderOverview(history, prefs) {
    const total = history.reduce((sum, item) => sum + (Number(item.salary) || 0), 0);
    setText(els.summaryTotal, `${prefs.currency}${total.toFixed(2)}`);
    setText(els.summaryDays, `共 ${history.length} 天记录 · 仅显示最近 7 天`);

    if (!history.length) {
      els.historyList.replaceChildren(node('div', 'list__empty', '还没有记录，先去首页设置今日计划吧'));
      return;
    }
    const rows = history.map((h) => {
      const row = node('div', 'history-item');
      const detail = `${h.startTime}–${h.endTime}${h.crossesMidnight ? '（次日）' : ''} · 有效 ${formatDuration(
        h.effectiveMs
      ).slice(0, 5)}`;
      row.append(
        node('div', 'history-item__date', shortDateOfKey(h.date)),
        node('div', 'history-item__detail', detail),
        node('div', 'history-item__amount', `${prefs.currency}${Number(h.salary).toFixed(2)}`)
      );
      return row;
    });
    els.historyList.replaceChildren(...rows);
  }

  /* ------------------------------ 设置 ------------------------------ */

  function renderSettings(prefs, defaults, plan) {
    setText(els.defaultsSummary, `${defaults.startTime}–${defaults.endTime} · ${prefs.currency}${defaults.salary}`);
    setText(
      els.settingsPlanSummary,
      plan ? `${plan.startTime}–${plan.endTime} · ${prefs.currency}${plan.salary}` : '—'
    );
    for (const btn of els.themeSegmented.querySelectorAll('button')) {
      btn.classList.toggle('is-active', btn.dataset.themeValue === prefs.theme);
    }
    setAttr(els.animSwitch, 'aria-checked', String(prefs.animations));
  }

  /* ------------------------------ 计划面板 ------------------------------ */

  function readPlanForm() {
    return {
      date: sheetDateKey,
      salary: els.fSalary.value.trim(),
      startTime: els.fStart.value,
      endTime: els.fEnd.value,
      breakMinutes: els.fBreakMinutes.value.trim() === '' ? 0 : els.fBreakMinutes.value.trim(),
      breakStart: els.fBreakStart.value,
      confirmed: true,
      updatedAt: Date.now()
    };
  }

  function fillPlanForm(data, dateKey) {
    els.fSalary.value = data.salary ?? '';
    els.fStart.value = data.startTime || '08:30';
    els.fEnd.value = data.endTime || '17:30';
    els.fBreakMinutes.value = data.breakMinutes ?? 0;
    els.fBreakStart.value = data.breakStart || '12:00';
    sheetDateKey = dateKey;
    updatePreview();
  }

  function previewLine(label, value) {
    const line = node('div');
    line.append(document.createTextNode(label), node('b', null, value));
    return line;
  }

  /** 表单实时预览；返回计划是否有效 */
  function updatePreview() {
    const schedule = buildSchedule(readPlanForm());
    if (!schedule.ok) {
      els.planPreview.classList.add('is-error');
      setText(els.planPreview, `⚠️ ${schedule.errors.join('；')}`);
      return false;
    }
    els.planPreview.classList.remove('is-error');
    const hours = schedule.totalEffectiveMs / 3_600_000;
    const lines = [
      previewLine('有效工作时长：', formatDuration(schedule.totalEffectiveMs)),
      previewLine('折合每小时：', `${currency}${(schedule.plan.salary / hours).toFixed(2)}`)
    ];
    if (schedule.crossesMidnight) lines.push(node('div', null, '已识别为跨日班次，下班时间在次日'));
    if (schedule.breakRange) lines.push(node('div', null, `午休 ${schedule.plan.breakMinutes} 分钟不计薪`));
    if (schedule.warnings.length) lines.push(node('div', null, `注意：${schedule.warnings.join('；')}`));
    els.planPreview.replaceChildren(...lines);
    return true;
  }

  function openPlanSheet(mode, data, dateKey, prefsCurrency) {
    sheetMode = mode;
    currency = prefsCurrency;
    const isToday = mode === 'today';
    setText(els.planTitle, isToday ? '今日计划' : '默认计划');
    setText(
      els.sheetDate,
      isToday ? `${longDateOfKey(dateKey)} · ${weekdayOfKey(dateKey)}` : '应用于以后新的一天'
    );
    setText(els.btnSaveToday, isToday ? '保存今日计划' : '保存默认设置');
    setHidden(els.btnSaveDefault, !isToday);
    setText(els.btnRestoreDefault, isToday ? '恢复默认设置' : '恢复出厂设置');
    setText(els.currencyPrefix, prefsCurrency);
    setText(
      els.sheetNote,
      isToday
        ? '保存后立即按真实时间重新结算。工作已开始时，修改会弹出二次确认。'
        : '默认设置只影响以后新的一天，不会改动已经保存的每日计划。'
    );
    els.planBackdrop.hidden = false;
    els.planSheet.hidden = false;
    document.body.style.overflow = 'hidden';
    fillPlanForm(data, dateKey);
    window.setTimeout(() => els.fSalary.focus({ preventScroll: true }), 260);
  }

  function closePlanSheet() {
    els.planBackdrop.hidden = true;
    els.planSheet.hidden = true;
    document.body.style.overflow = '';
  }

  /* ------------------------------ 确认框 ------------------------------ */

  function showConfirm({ title, body, okText = '确认' }) {
    return new Promise((resolve) => {
      if (confirmResolve) confirmResolve(false);
      confirmResolve = resolve;
      setText(els.confirmTitle, title);
      setText(els.confirmBody, body);
      setText(els.confirmOk, okText);
      els.confirmBackdrop.hidden = false;
      els.confirmDialog.hidden = false;
    });
  }

  function resolveConfirm(value) {
    els.confirmBackdrop.hidden = true;
    els.confirmDialog.hidden = true;
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(value);
  }

  /* ------------------------------ 杂项 ------------------------------ */

  function showToast(text) {
    setText(els.toast, text);
    els.toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove('is-visible'), 2200);
  }

  function showUpdateBar() {
    els.updateBar.classList.remove('is-hidden');
  }

  function hideUpdateBar() {
    els.updateBar.classList.add('is-hidden');
  }

  return {
    els,
    render,
    setQuote,
    setPlanHint,
    setView,
    renderOverview,
    renderSettings,
    readPlanForm,
    fillPlanForm,
    updatePreview,
    openPlanSheet,
    closePlanSheet,
    showConfirm,
    resolveConfirm,
    showToast,
    showUpdateBar,
    hideUpdateBar,
    isConfirmOpen: () => confirmResolve !== null,
    get sheetMode() {
      return sheetMode;
    },
    get sheetDateKey() {
      return sheetDateKey;
    }
  };
}
