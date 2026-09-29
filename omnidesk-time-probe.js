/*
 * omnidesk-time-probe.js
 *
 * Прогон на сегодня: какие события страница обращения Omnidesk вообще отдаёт,
 * и какие идентификаторы при этом видны. Длительности не считает и никуда не отправляет.
 *
 * Основан на omnidesk-case-probe.js (диагностика страницы обращения):
 *   те же глобальные переменные, тот же запасной разбор URL, тот же приём «ошибка пробы
 *   не должна ломать Omnidesk». Селекторы категории в примерах Omnidesk не заданы,
 *   поэтому поля формы только перечисляются, а какое из них — категория, решает человек.
 *
 * Как запустить: вставить файл целиком в консоль на открытом обращении
 * либо подключить так же, как пробу, через
 * «Настройки → Отображение внешних данных → Страница обращения».
 *
 * В консоли: __timeprobe.report(), __timeprobe.scan(), __timeprobe.probeOutbound(), __timeprobe.copy().
 * Пороги короткие специально для прогона. Боевые значения — в файле проверки, не здесь.
 *
 * Кнопка закрытия обращения пишет case_close. Если страница сразу открывает другое
 * обращение, метка сохраняется в sessionStorage и попадает в журнал уже новой страницы.
 */
(function () {
  'use strict';

  if (window.__timeprobe && window.__timeprobe.active) {
    try { console.warn('[timeprobe] уже запущен. Чтобы подхватить новую версию с case_close, обновите страницу.'); } catch (e) { /* ничего */ }
    return;
  }

  var IDLE_MS = 45 * 1000;
  var HEARTBEAT_MS = 15 * 1000;
  var POLL_MS = 1000;
  var LOG_LIMIT = 200;
  var CASE_URL_RE = /\/cases\/record\/(\d+-\d+)/;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function hhmmss(d) {
    d = d || new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function safe(fn, label) {
    try { return fn(); } catch (e) {
      try { console.warn('[timeprobe] ошибка в ' + label + ':', e); } catch (_) { /* ничего */ }
      return undefined;
    }
  }

  function looksSensitive(s) {
    if (!s) return false;
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(s)) return true;
    if (/(?:\+?\d[\d\s()\-]{8,}\d)/.test(s)) return true;
    return false;
  }

  function clip(s, n) {
    s = (s === undefined || s === null) ? '' : String(s).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (looksSensitive(s)) return '[redacted]';
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function readGlobals() {
    var g = {};
    try { g.CurrentCaseId = CurrentCaseId; } catch (e) { g.CurrentCaseId = undefined; }
    try { g.CurrentUserId = CurrentUserId; } catch (e) { g.CurrentUserId = undefined; }
    try { g.CurrentStaffId = CurrentStaffId; } catch (e) { g.CurrentStaffId = undefined; }
    try { g.CurrentClientId = CurrentClientId; } catch (e) { g.CurrentClientId = undefined; }
    return g;
  }

  function present(v) {
    return !(v === undefined || v === null || String(v) === '' || String(v) === '0');
  }

  function getCaseInfo() {
    var g = readGlobals();
    var number = null;
    try {
      var m = CASE_URL_RE.exec(location.pathname + location.hash);
      if (m) number = m[1];
    } catch (e) { /* ничего */ }
    if (present(g.CurrentCaseId)) return { id: String(g.CurrentCaseId), source: 'CurrentCaseId', number: number };
    if (number) return { id: number, source: 'URL', number: number };
    return { id: null, source: null, number: number };
  }

  function tabId() {
    try {
      var id = sessionStorage.getItem('timeprobe.tabId');
      if (!id) {
        id = Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36);
        sessionStorage.setItem('timeprobe.tabId', id);
      }
      return id;
    } catch (e) {
      return 'no-storage';
    }
  }

  var state = {
    tabId: tabId(),
    startedAt: new Date().toISOString(),
    events: [],
    lastInput: Date.now(),
    activity: 'active',
    lastCaseId: null,
    closedFor: null,
    heartbeatTimer: null,
    pollTimer: null,
    idleTimer: null,
    previousPage: null,
    caseClosed: false
  };

  function snapshot() {
    var g = readGlobals();
    var info = getCaseInfo();
    var focused = false;
    var visibility = 'unknown';
    try { focused = document.hasFocus(); } catch (e) { /* ничего */ }
    try { visibility = document.visibilityState || 'unknown'; } catch (e) { /* ничего */ }
    return {
      case_id: info.id,
      case_id_source: info.source,
      case_number: info.number,
      staff_id_present: present(g.CurrentStaffId),
      user_id_present: present(g.CurrentUserId),
      client_id_present: present(g.CurrentClientId),
      tab_id: state.tabId,
      visibility: visibility,
      focused: focused,
      activity: state.activity,
      ms_since_input: Date.now() - state.lastInput
    };
  }

  function emit(name, extra) {
    var row = snapshot();
    row.event = name;
    row.ts = hhmmss();
    row.iso = new Date().toISOString();
    if (extra) {
      Object.keys(extra).forEach(function (k) { row[k] = extra[k]; });
    }
    state.events.push(row);
    while (state.events.length > LOG_LIMIT) state.events.shift();
    if (name === 'case_close' && row.reason !== 'carried') state.caseClosed = true;
    try { console.log('[timeprobe]', row.ts, name, row); } catch (e) { /* ничего */ }
    safe(renderPanel, 'renderPanel');
    return row;
  }

  function saveCloseMark() {
    var marks = [];
    var i;
    for (i = 0; i < state.events.length; i++) {
      if (state.events[i].event === 'case_close' && state.events[i].reason !== 'carried') marks.push(state.events[i]);
    }
    if (!marks.length) return;
    try {
      sessionStorage.setItem('timeprobe.carry', JSON.stringify({
        tab_id: state.tabId,
        href: location.pathname,
        case_id: state.lastCaseId,
        events: marks.slice(-5)
      }));
    } catch (e) { /* ничего */ }
  }

  function loadCarry() {
    var raw = null;
    try { raw = sessionStorage.getItem('timeprobe.carry'); } catch (e) { return; }
    if (!raw) return;
    try { sessionStorage.removeItem('timeprobe.carry'); } catch (e) { /* ничего */ }
    var saved = null;
    try { saved = JSON.parse(raw); } catch (e) { return; }
    if (!saved || saved.tab_id !== state.tabId || !saved.events) return;
    state.previousPage = saved;
  }

  function replayCarry() {
    var saved = state.previousPage;
    if (!saved || !saved.events) return;
    saved.events.forEach(function (ev) {
      if (!ev || ev.event !== 'case_close') return;
      emit('case_close', {
        reason: 'carried',
        case_id: ev.case_id,
        case_number: ev.case_number,
        closed_at: ev.iso,
        control: ev.control,
        from_href: saved.href
      });
    });
  }

  function looksLikeClose(text) {
    return /закры|close|resolve|заверш/i.test(text || '');
  }

  function uiLabel(node) {
    var bits = [];
    try {
      if (node.getAttribute) {
        bits.push(node.getAttribute('aria-label') || '');
        bits.push(node.getAttribute('title') || '');
      }
    } catch (e) { /* ничего */ }
    bits.push(node.innerText || node.textContent || node.value || '');
    return clip(bits.join(' '), 80);
  }

  function clickControl(node) {
    var n = node;
    var i;
    for (i = 0; n && i < 6; i++) {
      try { if (n.closest && n.closest('#timeprobe-box')) return null; } catch (e) { /* ничего */ }
      if (n.id === 'timeprobe-box') return null;
      var tag = (n.tagName || '').toLowerCase();
      var role = '';
      try { role = (n.getAttribute && n.getAttribute('role')) || ''; } catch (e) { role = ''; }
      if (tag === 'button' || tag === 'a' || tag === 'option' || role === 'button' || role === 'menuitem' || role === 'option') return n;
      n = n.parentElement;
    }
    return null;
  }

  function onCloseClick(ev) {
    var node = clickControl(ev.target);
    if (!node) return;
    var text = uiLabel(node);
    var blob = [node.id || '', node.name || '', typeof node.className === 'string' ? node.className : '', text].join(' ');
    if (!looksLikeClose(blob)) return;
    emit('case_close', {
      reason: 'ui',
      control: {
        tag: (node.tagName || '').toLowerCase(),
        id: node.id || '',
        name: node.name || '',
        text: text
      }
    });
    saveCloseMark();
  }

  function onCloseChange(ev) {
    var node = ev.target;
    if (!node || (node.tagName || '').toLowerCase() !== 'select') return;
    var text = '';
    try {
      if (node.options && node.selectedIndex >= 0 && node.options[node.selectedIndex]) {
        text = clip(node.options[node.selectedIndex].textContent, 80);
      }
    } catch (e) { return; }
    var blob = [node.id || '', node.name || '', text].join(' ');
    if (!looksLikeClose(blob)) return;
    emit('case_close', {
      reason: 'status',
      control: { tag: 'select', id: node.id || '', name: node.name || '', text: text }
    });
    saveCloseMark();
  }

  function markInput() {
    state.lastInput = Date.now();
    if (state.activity !== 'active') {
      state.activity = 'active';
      emit('active');
    }
  }

  function checkIdle() {
    if (state.activity === 'active' && Date.now() - state.lastInput >= IDLE_MS) {
      state.activity = 'idle';
      emit('idle', { idle_ms: IDLE_MS });
    }
  }

  function labelText(node) {
    try {
      if (!node.id) return '';
      var esc = (window.CSS && CSS.escape) ? CSS.escape(node.id) : node.id;
      var lab = document.querySelector('label[for="' + esc + '"]');
      return lab ? clip(lab.textContent, 80) : '';
    } catch (e) {
      return '';
    }
  }

  function isMarkupField(id, name, label) {
    return /categor|topic|theme|group|subject|label/i.test([id, name, label].join(' '));
  }

  function describeControl(node) {
    var label = labelText(node);
    var id = node.id || '';
    var name = node.name || '';
    var value = '';
    var keepValue = (node.tagName || '').toLowerCase() === 'select' || isMarkupField(id, name, label);
    if (keepValue) {
      try {
        if (node.options && node.selectedIndex >= 0 && node.options[node.selectedIndex]) {
          value = clip(node.options[node.selectedIndex].textContent, 80);
        } else if (node.type !== 'password' && node.type !== 'hidden') {
          value = clip(node.value, 80);
        }
      } catch (e) { /* ничего */ }
    }
    return {
      tag: (node.tagName || '').toLowerCase(),
      type: node.type || '',
      id: id,
      name: name,
      label: label,
      value: keepValue ? value : '[skipped]'
    };
  }

  function scan() {
    var controls = [];
    var hinted = [];
    safe(function () {
      var nodes = document.querySelectorAll('select, input');
      var i;
      for (i = 0; i < nodes.length && controls.length < 40; i++) {
        var n = nodes[i];
        if (!n || n.type === 'password' || n.type === 'hidden' || n.type === 'file') continue;
        controls.push(describeControl(n));
      }
      var hint = document.querySelectorAll('[id*="categor" i],[id*="topic" i],[id*="theme" i],[id*="group" i],[id*="subject" i],[name*="categor" i],[name*="topic" i],[name*="theme" i]');
      for (i = 0; i < hint.length && hinted.length < 30; i++) {
        hinted.push({
          tag: (hint[i].tagName || '').toLowerCase(),
          id: hint[i].id || '',
          name: hint[i].name || '',
          className: clip(typeof hint[i].className === 'string' ? hint[i].className : '', 120)
        });
      }
    }, 'scan');
    var payload = { controls: controls, hinted: hinted };
    emit('field_scan', { fields: payload });
    return payload;
  }

  function onCase(reason) {
    var info = getCaseInfo();
    var next = info.id;
    var prev = state.lastCaseId;
    if (String(next) === String(prev)) return;
    if (prev !== null) emit('ticket_close', { reason: reason, case_id: prev, next_case_id: next });
    state.lastCaseId = next;
    state.closedFor = null;
    if (next !== null) {
      emit('ticket_open', { reason: reason });
      scan();
    }
  }

  function onPageGone(reason) {
    if (state.closedFor === state.lastCaseId) return;
    state.closedFor = state.lastCaseId;
    emit('ticket_close', { reason: reason });
  }

  function probeOutbound() {
    if (typeof fetch !== 'function') {
      emit('outbound', { result: 'fetch недоступен' });
      return;
    }
    var t0 = Date.now();
    fetch('https://api.github.com/zen', { mode: 'cors', cache: 'no-store', credentials: 'omit' }).then(function (r) {
      emit('outbound', { result: 'ok', status: r.status, ms: Date.now() - t0, note: 'публичный хост, не будущий приёмник' });
    }).catch(function (e) {
      emit('outbound', { result: 'error', error: String(e), ms: Date.now() - t0, note: 'CSP connect-src или CORS. Это не ответ про наш домен.' });
    });
  }

  function report() {
    return {
      generated_at: new Date().toISOString(),
      thresholds: { idle_ms: IDLE_MS, heartbeat_ms: HEARTBEAT_MS, note: 'короткие пороги прогона, не боевые' },
      tab_id: state.tabId,
      started_at: state.startedAt,
      href: location.pathname,
      previous_page: state.previousPage,
      globals_present: (function () {
        var g = readGlobals();
        return {
          CurrentCaseId: present(g.CurrentCaseId),
          CurrentStaffId: present(g.CurrentStaffId),
          CurrentUserId: present(g.CurrentUserId),
          CurrentClientId: present(g.CurrentClientId)
        };
      })(),
      events: state.events
    };
  }

  function copyReport() {
    var text = JSON.stringify(report(), null, 2);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          emit('report_copied');
        }, function () {
          console.log(text);
          emit('report_printed');
        });
        return text;
      }
    } catch (e) { /* ничего */ }
    console.log(text);
    emit('report_printed');
    return text;
  }

  function renderPanel() {
    var box = document.getElementById('timeprobe-box');
    if (!box) return;
    var last = state.events[state.events.length - 1];
    var line = document.getElementById('timeprobe-line');
    if (line) {
      line.textContent = state.events.length + ' событий'
        + (state.caseClosed ? ' · case_close' : '')
        + (last ? ' · последнее ' + last.ts + ' ' + last.event : '')
        + ' · ' + state.activity
        + (snapshot().focused ? ' · focus' : ' · blur')
        + ' · ' + (snapshot().visibility || '');
    }
  }

  function mountPanel() {
    if (document.getElementById('timeprobe-box')) return;
    var css = '#timeprobe-box{position:fixed;right:16px;top:120px;z-index:2147483000;background:#fff;color:#222;border:1px solid #ccc;border-radius:6px;padding:8px 10px;font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;width:280px}#timeprobe-box button{font:inherit;margin-right:6px;margin-top:6px}';
    var style = document.createElement('style');
    style.id = 'timeprobe-style';
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
    var box = document.createElement('div');
    box.id = 'timeprobe-box';
    var title = document.createElement('div');
    title.textContent = 'Прогон времени · tab ' + state.tabId;
    var line = document.createElement('div');
    line.id = 'timeprobe-line';
    var copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Скопировать журнал';
    copyBtn.addEventListener('click', function () { safe(copyReport, 'copy'); });
    var scanBtn = document.createElement('button');
    scanBtn.type = 'button';
    scanBtn.textContent = 'Скан полей';
    scanBtn.addEventListener('click', function () { safe(scan, 'scan click'); });
    box.appendChild(title);
    box.appendChild(line);
    box.appendChild(copyBtn);
    box.appendChild(scanBtn);
    (document.body || document.documentElement).appendChild(box);
  }

  function init() {
    safe(mountPanel, 'mountPanel');
    ['keydown', 'pointerdown', 'mousemove', 'wheel', 'scroll'].forEach(function (name) {
      window.addEventListener(name, function () { safe(markInput, name); }, true);
    });
    document.addEventListener('visibilitychange', function () {
      safe(function () {
        emit(document.visibilityState === 'visible' ? 'visible' : 'hidden');
      }, 'visibilitychange');
    });
    window.addEventListener('focus', function () { safe(function () { emit('focus'); }, 'focus'); });
    window.addEventListener('blur', function () { safe(function () { emit('blur'); }, 'blur'); });
    document.addEventListener('click', function (ev) { safe(function () { onCloseClick(ev); }, 'close click'); }, true);
    document.addEventListener('change', function (ev) { safe(function () { onCloseChange(ev); }, 'close change'); }, true);
    window.addEventListener('pagehide', function () { safe(function () { onPageGone('pagehide'); }, 'pagehide'); });
    window.addEventListener('beforeunload', function () { safe(function () { onPageGone('beforeunload'); }, 'beforeunload'); });

    state.idleTimer = setInterval(function () { safe(checkIdle, 'idle'); }, 1000);
    state.heartbeatTimer = setInterval(function () { safe(function () { emit('heartbeat'); }, 'heartbeat'); }, HEARTBEAT_MS);
    state.pollTimer = setInterval(function () { safe(function () { onCase('poll'); }, 'poll'); }, POLL_MS);

    loadCarry();
    emit('probe_start', { idle_ms: IDLE_MS, heartbeat_ms: HEARTBEAT_MS });
    onCase('init');
    replayCarry();
  }

  window.__timeprobe = {
    active: true,
    state: state,
    report: report,
    copy: copyReport,
    scan: function () { return safe(scan, 'scan'); },
    probeOutbound: function () { safe(probeOutbound, 'outbound'); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { safe(init, 'init'); });
  } else {
    safe(init, 'init');
  }
})();
