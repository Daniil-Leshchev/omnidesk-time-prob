(function () {
  'use strict';

  if (window.__timetrack && window.__timetrack.active) {
    try { console.warn('[timetrack] уже запущен. Обновите страницу, чтобы подхватить новый файл.'); } catch (e) { }
    return;
  }

  var SEND_URL = 'https://umschool.net/_jts/api/s/track';
  var IDLE_MS = 2 * 60 * 1000;
  var POLL_MS = 1000;
  var LOG_LIMIT = 200;
  var CASE_URL_RE = /\/cases\/record\/(\d+-\d+)/;
  var LAST_KEY = 'timetrack.lastCase';
  var CLOSE_KEY = 'timetrack.pendingClose';
  var TAB_CLOSE_KEY = 'timetrack.pendingTabClose';
  var LAST_CLOSE_KEY = 'timetrack.lastClose';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function hhmmss(d) {
    d = d || new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function safe(fn, label) {
    try { return fn(); } catch (e) {
      try { console.warn('[timetrack] ошибка в ' + label + ':', e); } catch (_) { }
      return undefined;
    }
  }

  function rid() {
    return Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36);
  }

  function readStore(key) {
    try {
      var raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch (e) { }
  }

  function readGlobals() {
    var g = {};
    try { g.CurrentCaseId = CurrentCaseId; } catch (e) { g.CurrentCaseId = undefined; }
    try { g.CurrentStaffId = CurrentStaffId; } catch (e) { g.CurrentStaffId = undefined; }
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
    } catch (e) { }
    if (present(g.CurrentCaseId)) return { id: String(g.CurrentCaseId), source: 'CurrentCaseId', number: number };
    if (number) return { id: number, source: 'URL', number: number };
    return { id: null, source: null, number: number };
  }

  function staffId() {
    var g = readGlobals();
    return present(g.CurrentStaffId) ? String(g.CurrentStaffId) : null;
  }

  function tabId() {
    try {
      var id = sessionStorage.getItem('timetrack.tabId');
      if (!id) {
        id = rid();
        sessionStorage.setItem('timetrack.tabId', id);
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
    away: null,
    lastCaseId: null,
    tabCloseQueued: false,
    caseClosedId: null,
    closedByButton: null,
    chosenStatus: null
  };

  function flags() {
    var focused = false;
    var visibility = 'unknown';
    try { focused = document.hasFocus(); } catch (e) { }
    try { visibility = document.visibilityState || 'unknown'; } catch (e) { }
    return { visibility: visibility, focused: focused, activity: state.activity };
  }

  function selectedText(select) {
    if (!select || !select.options || select.selectedIndex < 0) return null;
    var text = String(select.options[select.selectedIndex].textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text === 'не назначен') return null;
    return text.slice(0, 80);
  }

  function labelTitle(label) {
    var span = label.querySelector('span.lbl');
    var raw = span ? (span.childNodes[0] && span.childNodes[0].textContent) || span.textContent : '';
    return String(raw || '').replace(/\s+/g, ' ').trim();
  }

  /* Тему диалога берём только у поля с точной подписью «Тема диалога». */
  function readMarkup() {
    var topic = null;
    var labels = document.querySelectorAll('label.rlt.select-lbl');
    var i;
    for (i = 0; i < labels.length; i++) {
      if (labelTitle(labels[i]) === 'Тема диалога') {
        topic = selectedText(labels[i].querySelector('select'));
      }
    }
    return { topic: topic };
  }

  function payload(eventName, extra) {
    var info = getCaseInfo();
    var f = flags();
    var markup = readMarkup();
    var row = {
      event: eventName,
      event_ts: new Date().toISOString(),
      ts: hhmmss(),
      case_id: info.id,
      case_number: info.number,
      staff_id: staffId(),
      tab_id: state.tabId,
      visibility: f.visibility,
      focused: f.focused,
      activity: f.activity,
      omnidesk_host: location.hostname,
      topic: markup.topic
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { row[k] = extra[k]; });
    }
    return row;
  }

  function remember(row) {
    state.events.push(row);
    while (state.events.length > LOG_LIMIT) state.events.shift();
    try { console.log('[timetrack]', row.ts, row.event, row); } catch (e) { }
  }

  function jitsuBody(row) {
    var data = {
      event_ts: row.event_ts,
      case_id: row.case_id,
      case_number: row.case_number,
      staff_id: row.staff_id,
      tab_id: row.tab_id,
      visibility: row.visibility,
      focused: row.focused,
      activity: row.activity,
      omnidesk_host: row.omnidesk_host || null,
      reason: row.reason || null,
      previous_case_id: row.previous_case_id || null,
      next_case_id: row.next_case_id || null,
      mark_id: row.mark_id || null,
      void_mark_id: row.void_mark_id || null,
      topic: row.topic || null
    };
    return {
      type: 'track',
      event: row.event,
      timestamp: row.event_ts,
      sentAt: new Date().toISOString(),
      properties: { event_type: 'event', event_data: JSON.stringify(data) }
    };
  }

  function dispatch(row) {
    remember(row);
    if (!SEND_URL || typeof fetch !== 'function' || row.dispatched) return;
    row.dispatched = true;
    try {
      fetch(SEND_URL, {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jitsuBody(row))
      }).catch(function () { /* сеть не должна ломать страницу */ });
    } catch (e) { }
  }

  function track(eventName, extra) {
    dispatch(payload(eventName, extra));
  }

  function saveLastCase(info) {
    info = info || getCaseInfo();
    if (!info.id) return;
    writeStore(LAST_KEY, {
      tab_id: state.tabId,
      case_id: info.id,
      case_number: info.number
    });
    state.lastCaseId = info.id;
  }

  function sameTab(saved) {
    return !!(saved && saved.tab_id === state.tabId && saved.case_id);
  }

  /* Обновление той же страницы не начинает новую сессию.
     Другой case_id — закрытие старого обращения и открытие нового. */
  function openFromStorage() {
    var info = getCaseInfo();
    var saved = readStore(LAST_KEY);
    if (!info.id) return;
    if (sameTab(saved) && saved.case_id === info.id) {
      state.lastCaseId = info.id;
      return;
    }
    if (sameTab(saved) && saved.case_id !== info.id) {
      if (state.closedByButton !== saved.case_id) {
        track('omnidesk_case_close', {
          reason: 'switch',
          case_id: saved.case_id,
          case_number: saved.case_number,
          next_case_id: info.id
        });
      }
      track('omnidesk_case_open', { reason: 'switch', previous_case_id: saved.case_id });
    } else {
      track('omnidesk_case_open', { reason: 'first' });
    }
    saveLastCase(info);
  }

  function onCasePoll() {
    var info = getCaseInfo();
    var next = info.id;
    var prev = state.lastCaseId;
    if (String(next) === String(prev)) return;
    if (prev) {
      var saved = readStore(LAST_KEY);
      track('omnidesk_case_close', {
        reason: 'switch',
        case_id: prev,
        case_number: saved && saved.case_id === prev ? saved.case_number : null,
        next_case_id: next
      });
    }
    state.lastCaseId = next;
    state.caseClosedId = null;
    if (next) {
      track('omnidesk_case_open', { reason: 'switch', previous_case_id: prev });
      saveLastCase(info);
    }
  }

  function onHidden() {
    if (state.away === 'tab') return;
    state.away = 'tab';
    track('omnidesk_case_tab_leave');
  }

  function onVisible() {
    if (state.away !== 'tab') return;
    state.away = null;
    track('omnidesk_case_tab_return');
  }

  function onBlur() {
    var visibility = 'unknown';
    try { visibility = document.visibilityState; } catch (e) { }
    if (visibility !== 'visible' || state.away === 'tab' || state.away === 'app') return;
    state.away = 'app';
    track('omnidesk_case_app_leave');
  }

  function onFocus() {
    if (state.away !== 'app') return;
    var visibility = 'unknown';
    try { visibility = document.visibilityState; } catch (e) { }
    if (visibility !== 'visible') return;
    state.away = null;
    track('omnidesk_case_app_return');
  }

  function markInput() {
    state.lastInput = Date.now();
    if (state.activity !== 'active') {
      state.activity = 'active';
      track('omnidesk_case_active');
    }
  }

  function checkIdle() {
    if (state.away) return;
    if (state.activity === 'active' && Date.now() - state.lastInput >= IDLE_MS) {
      state.activity = 'idle';
      track('omnidesk_case_idle');
    }
  }

  function looksLikeClose(text) {
    return /закры|close|resolve|заверш/i.test(text || '');
  }

  function isFinishChat(text) {
    return /завершить\s*чат/i.test(text || '');
  }

  function isConfirmFinish(text) {
    return /завершить/i.test(text || '') && !/чат/i.test(text || '');
  }

  function isCancel(text) {
    return /отмен/i.test(text || '');
  }

  function statusKind(text) {
    text = text || '';
    if (/ожидани/i.test(text)) return 'waiting';
    if (/закрыт/i.test(text)) return 'closed';
    if (/открыт/i.test(text)) return 'open';
    return null;
  }

  function statusDialog() {
    var nodes = document.querySelectorAll('div, section, form, [role="dialog"]');
    var best = null;
    var bestLen = 2000;
    var i;
    for (i = 0; i < nodes.length && i < 3000; i++) {
      var t = nodes[i].innerText || '';
      if (t.length < 40 || t.length > 1200) continue;
      if (t.indexOf('Выберите статус') < 0) continue;
      if (t.length < bestLen) {
        best = nodes[i];
        bestLen = t.length;
      }
    }
    return best;
  }

  function buttonLooksOn(node) {
    var pressed = '';
    try { pressed = node.getAttribute('aria-pressed') || node.getAttribute('aria-selected') || ''; } catch (e) { }
    if (pressed === 'true') return true;
    var cls = typeof node.className === 'string' ? node.className : '';
    return /active|selected|current|pressed|checked|btn-on|is-on/i.test(cls);
  }

  function chosenInDialog(dialog) {
    if (!dialog) return state.chosenStatus;
    var buttons = dialog.querySelectorAll('button, [role="button"], a, input[type="button"]');
    var statuses = [];
    var i;
    for (i = 0; i < buttons.length; i++) {
      var kind = statusKind(uiLabel(buttons[i]));
      if (!kind) continue;
      statuses.push({ node: buttons[i], kind: kind });
      if (buttonLooksOn(buttons[i])) return kind;
    }
    if (statuses.length >= 2) {
      var colors = [];
      for (i = 0; i < statuses.length; i++) {
        try { colors.push(window.getComputedStyle(statuses[i].node).backgroundColor || ''); }
        catch (e) { colors.push(''); }
      }
      for (i = 0; i < statuses.length; i++) {
        var n = 0;
        var j;
        for (j = 0; j < colors.length; j++) if (colors[j] && colors[j] === colors[i]) n++;
        if (colors[i] && n === 1) return statuses[i].kind;
      }
    }
    return state.chosenStatus;
  }

  function uiLabel(node) {
    var bits = [];
    try {
      if (node.getAttribute) {
        bits.push(node.getAttribute('aria-label') || '');
        bits.push(node.getAttribute('title') || '');
      }
    } catch (e) { }
    var text = node.innerText || node.textContent || node.value || '';
    bits.push(String(text).replace(/\s+/g, ' ').trim().slice(0, 80));
    return bits.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function clickControl(node) {
    var n = node;
    var i;
    var labeled = null;
    for (i = 0; n && i < 8; i++) {
      try { if (n.closest && n.closest('#timetrack-box')) return null; } catch (e) { }
      if (n.id === 'timetrack-box') return null;
      var tag = (n.tagName || '').toLowerCase();
      var role = '';
      var text = uiLabel(n);
      try { role = (n.getAttribute && n.getAttribute('role')) || ''; } catch (e) { role = ''; }
      if (!labeled && (isFinishChat(text) || isConfirmFinish(text) || isCancel(text) || statusKind(text))) labeled = n;
      if (tag === 'button' || tag === 'a' || tag === 'option' || role === 'button' || role === 'menuitem' || role === 'option') return n;
      n = n.parentElement;
    }
    return labeled;
  }

  /* Метка пишется сразу. Если страница осталась — уходит отсюда.
     Если открылось другое обращение — уходит уже со следующей загрузки, один раз. */
  function queueCaseClose(reason, control) {
    var info = getCaseInfo();
    if (!info.id || state.caseClosedId === info.id) return;
    var mark = payload('omnidesk_case_close', {
      reason: reason,
      mark_id: rid(),
      control: control
    });
    state.caseClosedId = info.id;
    dispatch(mark);
    writeStore(CLOSE_KEY, mark);
    writeStore(LAST_CLOSE_KEY, mark);
  }

  function flushQueuedClose() {
    var pending = readStore(CLOSE_KEY);
    if (!pending) return;
    writeStore(CLOSE_KEY, null);
    state.closedByButton = pending.case_id;
    if (pending.dispatched) return;
    var now = getCaseInfo();
    if (!now.id || pending.case_id !== now.id) pending.reason = pending.reason || 'carried';
    dispatch(pending);
  }

  function replayLastClose() {
    var mark = readStore(LAST_CLOSE_KEY);
    if (!mark || !mark.mark_id) return;
    writeStore(LAST_CLOSE_KEY, null);
    var i;
    for (i = 0; i < state.events.length; i++) {
      if (state.events[i].mark_id === mark.mark_id) return;
    }
    remember(mark);
  }

  function closeControl(node, text) {
    return {
      tag: (node.tagName || '').toLowerCase(),
      id: node.id || '',
      text: text
    };
  }

  function shortLabel(node) {
    if (!node || node.nodeType !== 1) return '';
    var direct = '';
    var i;
    if (node.childNodes) {
      for (i = 0; i < node.childNodes.length; i++) {
        if (node.childNodes[i].nodeType === 3) direct += node.childNodes[i].textContent;
      }
    }
    direct = direct.replace(/\s+/g, ' ').trim();
    if (!direct) direct = String(node.value || '').replace(/\s+/g, ' ').trim();
    if (!direct && node.childNodes && node.childNodes.length === 1) {
      direct = String(node.innerText || '').replace(/\s+/g, ' ').trim();
    }
    if (direct.length > 48) return '';
    return direct;
  }

  function selectedStatusOnPage() {
    if (state.chosenStatus === 'waiting' || state.chosenStatus === 'closed') return state.chosenStatus;
    var nodes = document.querySelectorAll('button, a, span, label, div, input');
    var i;
    for (i = 0; i < nodes.length && i < 2500; i++) {
      var kind = statusKind(shortLabel(nodes[i]));
      if (kind !== 'waiting' && kind !== 'closed') continue;
      if (buttonLooksOn(nodes[i])) return kind;
    }
    return null;
  }

  function anchorStatus(node) {
    if (!node || !node.closest) return null;
    var a = node.closest('a.req-status-closed, a.req-status-waiting, a.req-status-wait, a.req-status-open, .req-status-action a.tab-title');
    if (!a) return null;
    var cls = typeof a.className === 'string' ? a.className : '';
    var text = String(a.textContent || '').replace(/\s+/g, ' ').trim();
    if (/req-status-closed/.test(cls) || /закрыт/i.test(text)) return 'closed';
    if (/req-status-wait/.test(cls) || /ожидани/i.test(text)) return 'waiting';
    if (/req-status-open/.test(cls) || /открыт/i.test(text)) return 'open';
    return null;
  }

  function activeBarStatus() {
    var a = document.querySelector('.req-status-action a.tab-title.active-item, .req-status-action a.tab-title.manual-active');
    return anchorStatus(a);
  }

  function selectedCaseStatus() {
    var fromBar = activeBarStatus();
    if (fromBar === 'waiting' || fromBar === 'closed') return fromBar;
    if (state.chosenStatus === 'waiting' || state.chosenStatus === 'closed') return state.chosenStatus;
    var selects = document.querySelectorAll('select');
    var i, j;
    for (i = 0; i < selects.length; i++) {
      var hasStatus = false;
      for (j = 0; j < selects[i].options.length; j++) {
        if (statusKind(selects[i].options[j].textContent || '')) hasStatus = true;
      }
      if (!hasStatus || selects[i].selectedIndex < 0) continue;
      var kind = statusKind(selects[i].options[selects[i].selectedIndex].textContent || '');
      if (kind === 'waiting' || kind === 'closed') return kind;
    }
    return selectedStatusOnPage();
  }

  function onCloseClick(ev) {
    var fromAnchor = anchorStatus(ev.target);
    if (fromAnchor === 'open') {
      state.chosenStatus = 'open';
      return;
    }
    if (fromAnchor === 'waiting' || fromAnchor === 'closed') {
      state.chosenStatus = fromAnchor;
      if (!statusDialog()) {
        queueCaseClose(fromAnchor, {
          tag: 'a',
          id: 'req-status-' + fromAnchor,
          text: fromAnchor === 'waiting' ? 'в ожидании' : 'закрытое'
        });
      }
      return;
    }
    var save = ev.target.closest && ev.target.closest('.req-form-action input, .req-form-action button, .req-form-action label');
    if (save) {
      var chosen = selectedCaseStatus();
      if (chosen === 'waiting' || chosen === 'closed') {
        queueCaseClose(chosen, { tag: 'input', id: 'req-form-action', text: chosen === 'waiting' ? 'в ожидании' : 'закрытое' });
      }
      return;
    }
    var n = ev.target;
    var i;
    for (i = 0; n && n.nodeType === 1 && i < 8; i++) {
      if (n.id === 'timetrack-box') return;
      try { if (n.closest && n.closest('#timetrack-box')) return; } catch (e) { /* ничего */ }
      var text = shortLabel(n);
      var kind = statusKind(text);
      var dialog = statusDialog();
      if (isFinishChat(text)) {
        state.chosenStatus = null;
        return;
      }
      if (isCancel(text)) {
        state.chosenStatus = null;
        return;
      }
      if (kind === 'open') {
        state.chosenStatus = 'open';
        return;
      }
      if (kind === 'waiting' || kind === 'closed') {
        state.chosenStatus = kind;
        if (!dialog) queueCaseClose(kind, closeControl(n, text));
        return;
      }
      if (isConfirmFinish(text) && dialog) {
        var picked = chosenInDialog(dialog);
        var label = picked === 'waiting' ? 'в ожидании' : picked === 'closed' ? 'закрытое' : text;
        state.chosenStatus = null;
        if (picked === 'open') return;
        queueCaseClose(picked || 'status', closeControl(n, label));
        return;
      }
      if (/^сохранить\b/i.test(text)) {
        var chosen = selectedCaseStatus();
        if (chosen === 'waiting' || chosen === 'closed') {
          queueCaseClose(chosen, closeControl(n, chosen === 'waiting' ? 'в ожидании' : 'закрытое'));
        }
        return;
      }
      n = n.parentElement;
    }
  }

  function onCloseChange(ev) {
    var node = ev.target;
    if (!node || (node.tagName || '').toLowerCase() !== 'select') return;
    var text = '';
    try {
      if (node.options && node.selectedIndex >= 0 && node.options[node.selectedIndex]) {
        text = String(node.options[node.selectedIndex].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      }
    } catch (e) { return; }
    var kind = statusKind(text);
    if (kind === 'open') return;
    var blob = [node.id || '', node.name || '', text].join(' ');
    if (kind !== 'waiting' && kind !== 'closed' && !looksLikeClose(blob)) return;
    queueCaseClose(kind || 'status', { tag: 'select', id: node.id || '', text: text });
  }

  /* pagehide бывает и при переходе, и при крестике.
     Событие уходит сразу. Следующая загрузка той же вкладки его отменяет. */
  function onPageHide() {
    saveLastCase();
    if (state.tabCloseQueued) return;
    var info = getCaseInfo();
    if (!info.id) return;
    state.tabCloseQueued = true;
    var row = payload('omnidesk_case_tab_close', { reason: 'pagehide', mark_id: rid() });
    writeStore(TAB_CLOSE_KEY, row);
    dispatch(row);
  }

  function voidTabCloseIfReturned() {
    var pending = readStore(TAB_CLOSE_KEY);
    if (!pending || pending.tab_id !== state.tabId) return;
    writeStore(TAB_CLOSE_KEY, null);
    track('omnidesk_case_tab_close', {
      reason: 'void',
      mark_id: rid(),
      void_mark_id: pending.mark_id,
      case_id: pending.case_id,
      case_number: pending.case_number,
      event_ts: pending.event_ts
    });
  }

  function report() {
    return {
      generated_at: new Date().toISOString(),
      send_url: SEND_URL || null,
      idle_ms: IDLE_MS,
      tab_id: state.tabId,
      started_at: state.startedAt,
      href: location.pathname,
      events: state.events
    };
  }

  function copyReport() {
    var text = JSON.stringify(report(), null, 2);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () { console.log(text); });
        return text;
      }
    } catch (e) { }
    console.log(text);
    return text;
  }

  function init() {
    ['keydown', 'pointerdown', 'mousemove', 'wheel', 'scroll'].forEach(function (name) {
      window.addEventListener(name, function () { safe(markInput, name); }, true);
    });
    document.addEventListener('visibilitychange', function () {
      safe(function () {
        if (document.visibilityState === 'hidden') onHidden();
        else onVisible();
      }, 'visibility');
    });
    window.addEventListener('blur', function () { safe(onBlur, 'blur'); });
    window.addEventListener('focus', function () { safe(onFocus, 'focus'); });
    document.addEventListener('click', function (ev) { safe(function () { onCloseClick(ev); }, 'close click'); }, true);
    document.addEventListener('submit', function () {
      safe(function () {
        var chosen = selectedCaseStatus();
        if (chosen === 'waiting' || chosen === 'closed') {
          queueCaseClose(chosen, { tag: 'form', id: '', text: chosen === 'waiting' ? 'в ожидании' : 'закрытое' });
        }
      }, 'close submit');
    }, true);
    document.addEventListener('change', function (ev) { safe(function () { onCloseChange(ev); }, 'close change'); }, true);
    window.addEventListener('pagehide', function () { safe(onPageHide, 'pagehide'); });

    state.idleTimer = setInterval(function () { safe(checkIdle, 'idle'); }, 1000);
    state.pollTimer = setInterval(function () { safe(onCasePoll, 'poll'); }, POLL_MS);

    voidTabCloseIfReturned();
    flushQueuedClose();
    replayLastClose();
    openFromStorage();
    saveLastCase();
  }

  window.__timetrack = {
    active: true,
    state: state,
    report: report,
    copy: copyReport
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { safe(init, 'init'); });
  } else {
    safe(init, 'init');
  }
})();
