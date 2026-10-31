'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual card/render/onData functions without starting a browser
// or replacing their output with a mocked renderer.
function page(search = '') {
  const elements = new Map();
  const sources = [];
  const clock = { now: 1700000000000 };
  let dateTimeFormatCreations = 0;
  const testIntl = {
    DateTimeFormat: class extends Intl.DateTimeFormat {
      constructor(...args) { super(...args); dateTimeFormatCreations++; }
    },
    RelativeTimeFormat: Intl.RelativeTimeFormat,
  };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    open() { this.onopen?.({ type: 'open' }); }
    fail() { this.onerror?.({ type: 'error' }); }
    send(value) {
      const data = typeof value === 'string' ? value : JSON.stringify(value);
      this.onmessage?.({ data });
    }
    close() { this.closed = true; }
  }
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { innerHTML: '', textContent: '', style: {}, options: [{}], dataset: {},
        classList: {
          toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); },
          add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); },
        }, setAttribute(name, value) { this[name] = String(value); }, addEventListener() {} });
    }
    return elements.get(id);
  };
  const notifications = [];
  function Notification(title, options) { notifications.push({ title, options }); }
  Notification.permission = 'granted';
  // This unit harness stops before the side-panel layout code. Browser checks
  // exercise the real panel, while these stubs keep status/render coverage focused.
  const context = vm.createContext({ console, Intl: testIntl, Date: TestDate, EventSource: FakeEventSource, URLSearchParams, Notification,
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {}, documentElement: { dataset: {} }, body: { classList: { add() {}, toggle() {} } } },
    Image: class {},
    navigator: { languages: ['en'] }, location: { search }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} }, office: null, refreshTip() {},
    renderSide() {}, renderToday() {}, measureBar() {},
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/notification-rules.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/message-format.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/office.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), context);
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const script = html.split('<script>')[1].split('// ---- office view')[0];
  vm.runInContext(script, context);
  return { context, elements, notifications, sources, now: () => clock.now, dateTimeFormatCreations: () => dateTimeFormatCreations,
    setNow: (value) => { clock.now = value; }, run: (code) => vm.runInContext(code, context) };
}

function session(overrides = {}) {
  return { key: 'codex:one', id: 'one', agent: 'codex', project: 'Sample', status: 'tool',
    activity: 'Shell: tests', subagent: false, lastEventAt: 1000, turnStartedAt: 1000,
    pendingRequests: [], needsInput: false, staleAfterMs: 600000, ...overrides };
}

function sendSnapshot(p, sessions) {
  p.context.data = { now: p.now(), sessions };
  p.run('onData(data)');
}

function connectionText(p) {
  return ['connState', 'connTime', 'connNote'].map((id) => p.elements.get(id)?.textContent || '').join(' ');
}

test('dashboard connection and last update stay distinct from stale agent logs', () => {
  const p = page();
  p.run('connect()');
  assert.equal(p.run('state.connection'), 'waiting');
  assert.match(connectionText(p), /Waiting for a valid dashboard update/);
  assert.match(connectionText(p), /No valid data received yet/);

  p.sources[0].open();
  assert.equal(p.run('state.connection'), 'waiting');
  const receivedAt = p.now();
  const snapshot = { now: receivedAt, sessions: [session({ lastEventAt: receivedAt - 11 * 60 * 1000 })] };
  p.sources[0].send(snapshot);
  assert.equal(p.run('state.connection'), 'connected');
  assert.equal(p.run('state.lastUpdateAt'), receivedAt);
  assert.match(connectionText(p), /Connected/);
  assert.match(connectionText(p), /Last data update/);
  assert.match(p.elements.get('connTime').textContent, /\d{1,2}:\d{2}:\d{2}/);
  p.run("state.full = false; state.view = 'list'; render()");
  assert.match(p.elements.get('main').innerHTML, /No new log events/);
  assert.match(p.elements.get('main').innerHTML, /does not mean the task has stopped/);

  const before = p.elements.get('connTime').textContent;
  p.setNow(receivedAt + 8000);
  p.run('tipKey = null; tickTimes()');
  assert.equal(p.run('state.lastUpdateAt'), receivedAt);
  assert.notEqual(p.elements.get('connTime').textContent, before);
  assert.match(p.elements.get('connTime').textContent, /8s/);
});

test('dashboard errors retain the snapshot and only a valid reconnect message clears them', () => {
  const p = page();
  p.run('connect()');
  const source = p.sources[0];
  const pending = session({ needsInput: true, pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose one' }] });
  source.send({ now: p.now(), sessions: [pending] });
  const receivedAt = p.run('state.lastUpdateAt');
  const data = p.run('JSON.stringify(state.data)');
  const prev = p.run('JSON.stringify([...state.prev])');
  const skew = p.run('state.skew');
  const notifications = p.notifications.length;

  source.fail();
  assert.equal(p.run('state.connection'), 'disconnected');
  assert.equal(p.run('state.lastUpdateAt'), receivedAt);
  assert.equal(p.run('JSON.stringify(state.data)'), data);
  assert.equal(p.run('JSON.stringify([...state.prev])'), prev);
  assert.equal(p.run('state.skew'), skew);
  assert.match(connectionText(p), /current agent state is unconfirmed/);

  p.setNow(receivedAt + 5000);
  source.open();
  assert.equal(p.run('state.connection'), 'disconnected');
  assert.equal(p.run('state.lastUpdateAt'), receivedAt);
  source.send({ now: p.now(), sessions: [pending] });
  assert.equal(p.run('state.connection'), 'connected');
  assert.equal(p.run('state.lastUpdateAt'), receivedAt + 5000);
  assert.equal(p.run('state.data.sessions[0].pendingRequests[0].id'), 'q1');
  assert.equal(p.notifications.length, notifications);
});

test('invalid EventSource messages keep the last valid data and wait for a valid update', () => {
  const p = page();
  p.run('connect()');
  const source = p.sources[0];
  source.send({ now: p.now(), sessions: [session()] });
  const receivedAt = p.run('state.lastUpdateAt');
  const data = p.run('JSON.stringify(state.data)');
  const prev = p.run('JSON.stringify([...state.prev])');
  const skew = p.run('state.skew');

  assert.doesNotThrow(() => source.send('{bad json'));
  assert.equal(p.run('state.connection'), 'waiting');
  assert.doesNotThrow(() => source.send({ now: p.now() + 1000, sessions: 'invalid' }));
  assert.equal(p.run('state.connection'), 'waiting');
  assert.equal(p.run('state.lastUpdateAt'), receivedAt);
  assert.equal(p.run('JSON.stringify(state.data)'), data);
  assert.equal(p.run('JSON.stringify([...state.prev])'), prev);
  assert.equal(p.run('state.skew'), skew);
  assert.match(connectionText(p), /Waiting for a valid dashboard update/);
});

test('connection timestamp formatting reuses its locale formatter between preview frames', () => {
  const p = page();
  p.run('connect()');
  p.sources[0].send({ now: p.now(), sessions: [session()] });
  const afterSnapshot = p.dateTimeFormatCreations();
  assert.ok(afterSnapshot > 0);
  for (let i = 0; i < 120; i++) p.run('connectionInfo()');
  assert.equal(p.dateTimeFormatCreations(), afterSnapshot);

  p.run("applyLang('zh-TW')");
  const afterLanguageChange = p.dateTimeFormatCreations();
  assert.equal(afterLanguageChange, afterSnapshot + 1);
  for (let i = 0; i < 120; i++) p.run('connectionInfo()');
  assert.equal(p.dateTimeFormatCreations(), afterLanguageChange);
});

test('card keeps execution state and independently shows the unanswered question', () => {
  const p = page();
  p.context.item = session({ needsInput: true, pendingRequests: [{ id: 'q1', kind: 'question', summary: '<choose & confirm>' }] });
  const html = p.run('card(item, 2000)');
  assert.match(html, /Running/);
  assert.match(html, /Needs your response/);
  assert.match(html, /&lt;choose &amp; confirm&gt;/);
  assert.doesNotMatch(html, /<choose/);
});

test('stale activity stays Running and explicitly says freshness is not task completion', () => {
  const p = page();
  p.context.item = session();
  const html = p.run('card(item, 601000)');
  assert.match(html, /Running/);
  assert.match(html, /No new log events/);
  assert.match(html, /does not mean the task has stopped/);
  assert.doesNotMatch(p.run('card(item, 600999)'), /No new log events/);
});

test('pending work appears only in Needs you, never twice in the working group', () => {
  const p = page();
  p.context.items = [session({ needsInput: true, pendingRequests: [{ id: 'q1', kind: 'approval', summary: 'Approve test run' }] })];
  p.run("state.full = false; state.view = 'list'; state.data.sessions = items; render()");
  const html = p.elements.get('main').innerHTML;
  assert.match(html, /Needs you/);
  assert.equal((html.match(/data-key="codex:one"/g) || []).length, 1);
  assert.doesNotMatch(html, /<h2>Working/);
});

test('unknown sessions remain visible without enabling the idle filter', () => {
  const p = page();
  p.context.items = [session({ status: 'unknown', lastEventAt: null })];
  p.run("state.full = false; state.view = 'list'; state.data.sessions = items; render()");
  assert.match(p.elements.get('main').innerHTML, /Status unknown/);
  assert.match(p.elements.get('main').innerHTML, /Log time unavailable/);
});

test('office uses existing waiting animation while retaining the underlying execution state', () => {
  const p = page();
  let officeItems;
  p.context.office = { setVisible() {}, update(items) { officeItems = items; } };
  p.context.items = [session({ needsInput: true }), session({ key: 'codex:unknown', status: 'unknown' })];
  p.run('state.loaded = true; state.data.sessions = items; render()');
  assert.equal(officeItems.length, 1);
  assert.equal(officeItems[0].status, 'waiting');
  assert.equal(p.context.items[0].status, 'tool');
  assert.match(p.elements.get('officeSignals').innerHTML, /Status unknown/);
});

test('new pending requests notify once even when tools continue running', () => {
  const p = page();
  p.context.data = { now: Date.now(), sessions: [session()] };
  p.run('onData(data)');
  p.context.data = { now: Date.now(), sessions: [session({ needsInput: true, pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose one' }] })] };
  p.run('onData(data); onData(data)');
  assert.equal(p.notifications.length, 1);
  assert.match(p.notifications[0].title, /Waiting for you/);
});

test('completed state describes a turn, not overall task acceptance', () => {
  const p = page();
  p.context.item = session({ status: 'done' });
  assert.match(p.run('card(item, 2000)'), /Turn completed/);
});

test('compact list retains pending requests after turn completion without duplicating groups', () => {
  const p = page('?pip=1');
  p.context.items = [session({ status: 'done', needsInput: true,
    pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Still unanswered' }] }),
    session({ key: 'codex:done', status: 'done' })];
  p.run("state.view = 'list'; state.data.sessions = items; render()");
  const html = p.elements.get('main').innerHTML;
  assert.match(html, /Still unanswered/);
  assert.equal((html.match(/data-key="codex:one"/g) || []).length, 1);
  assert.doesNotMatch(html, /data-key="codex:done"/);
});

test('compact list shows an error-only session with error details and its log time', () => {
  const p = page('?pip=1');
  p.context.items = [session({ status: 'error', error: 'Command failed', lastEventAt: 1000 })];
  p.run("state.view = 'list'; state.data.sessions = items; render()");
  const html = p.elements.get('main').innerHTML;
  assert.match(html, /<h2>Errors/);
  assert.match(html, /data-s="error"/);
  assert.match(html, /Command failed/);
  assert.match(html, /Last log event:/);
});

test('compact list shows an unknown-only session with unavailable log time', () => {
  const p = page('?pip=1');
  p.context.items = [session({ status: 'unknown', lastEventAt: null })];
  p.run("state.view = 'list'; state.data.sessions = items; render()");
  const html = p.elements.get('main').innerHTML;
  assert.match(html, /<h2>Status unknown/);
  assert.match(html, /data-s="unknown"/);
  assert.match(html, /Log time unavailable/);
});

test('compact list keeps pending errors once in Needs you and includes errors, unknown, and working', () => {
  const p = page('?pip=1');
  p.context.items = [
    session({ key: 'codex:pending-error', status: 'error', error: 'Permission denied', needsInput: true,
      pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose a recovery action' }] }),
    session({ key: 'codex:error', status: 'error', error: 'Tool crashed' }),
    session({ key: 'codex:unknown', status: 'unknown', lastEventAt: null }),
    session({ key: 'codex:working', status: 'tool', lastEventAt: 1 }),
    session({ key: 'codex:done', status: 'done' }),
    session({ key: 'codex:idle', status: 'idle' }),
  ];
  p.run("state.view = 'list'; state.data.sessions = items; render()");
  const html = p.elements.get('main').innerHTML;
  const headings = [...html.matchAll(/<h2>(.*?) <span class="n">/g)].map((match) => match[1]);
  assert.deepEqual(headings, ['Needs you', 'Errors', 'Status unknown', 'Working']);
  assert.equal((html.match(/data-key="codex:pending-error"/g) || []).length, 1);
  assert.match(html, /Permission denied/);
  assert.match(html, /Choose a recovery action/);
  assert.match(html, /Log time unavailable/);
  assert.match(html, /No new log events/);
  assert.doesNotMatch(html, /data-key="codex:done"|data-key="codex:idle"/);
});

test('compact page suppresses pending-request notifications while preserving request state', () => {
  const p = page('?pip=1');
  p.context.data = { now: Date.now(), sessions: [session()] };
  p.run('onData(data)');
  p.context.data = { now: Date.now(), sessions: [session({ needsInput: true,
    pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose one' }] })] };
  p.run('onData(data)');
  assert.equal(p.notifications.length, 0);
  assert.equal(p.run('state.data.sessions[0].pendingRequests[0].id'), 'q1');
});

test('error notifications fire once on entry, suppress the initial snapshot, and fire again after recovery', () => {
  const p = page();
  p.context.data = { now: Date.now(), sessions: [session({ status: 'error', error: 'Initial failure' })] };
  p.run('onData(data)');
  assert.equal(p.notifications.length, 0);

  p.context.data = { now: Date.now(), sessions: [session({ status: 'error', error: 'Initial failure' })] };
  p.run('onData(data)');
  p.context.data = { now: Date.now(), sessions: [session({ status: 'error', error: 'Changed while still failing' })] };
  p.run('onData(data)');
  assert.equal(p.notifications.length, 0);

  p.context.data = { now: Date.now(), sessions: [session({ status: 'tool' })] };
  p.run('onData(data)');
  p.context.data = { now: Date.now(), sessions: [session({ status: 'error', error: 'Second failure' })] };
  p.run('onData(data)');
  assert.equal(p.notifications.length, 1);
  assert.equal(p.notifications[0].title, 'Sample: Error');
  assert.equal(p.notifications[0].options.body, 'Second failure');

  p.context.data = { now: Date.now(), sessions: [session({ status: 'error', error: 'Still failing' })] };
  p.run('onData(data)');
  assert.equal(p.notifications.length, 1);

  p.context.data = { now: Date.now(), sessions: [session({ status: 'tool' })] };
  p.run('onData(data)');
  p.context.data = { now: Date.now(), sessions: [session({ status: 'error', error: 'Second failure' })] };
  p.run('onData(data)');
  assert.equal(p.notifications.length, 2);
});

test('error notification combines the error detail and newly pending request summary', () => {
  const p = page();
  p.context.data = { now: Date.now(), sessions: [session()] };
  p.run('onData(data)');
  p.context.data = { now: Date.now(), sessions: [session({ status: 'error', error: 'Process exited with code 1', needsInput: true,
    pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose a recovery action' }] })] };
  p.run('onData(data)');
  assert.equal(p.notifications.length, 1);
  assert.equal(p.notifications[0].title, 'Sample: Error');
  assert.match(p.notifications[0].options.body, /Process exited with code 1/);
  assert.match(p.notifications[0].options.body, /Choose a recovery action/);
});

test('error notification falls back to activity when there is no error detail', () => {
  const p = page();
  p.context.data = { now: Date.now(), sessions: [session()] };
  p.run('onData(data)');
  p.context.data = { now: Date.now(), sessions: [session({ status: 'error', error: '', activity: 'Run: failed command' })] };
  p.run('onData(data)');
  assert.equal(p.notifications.length, 1);
  assert.equal(p.notifications[0].options.body, 'Run: failed command');
});

test('error notifications require granted permission and stay suppressed in PiP and for subagents', () => {
  const denied = page();
  denied.context.data = { now: Date.now(), sessions: [session()] };
  denied.run('onData(data)');
  denied.context.Notification.permission = 'denied';
  denied.context.data = { now: Date.now(), sessions: [session({ status: 'error', error: 'Denied notification' })] };
  denied.run('onData(data)');
  assert.equal(denied.notifications.length, 0);

  const compact = page('?pip=1');
  compact.context.data = { now: Date.now(), sessions: [session()] };
  compact.run('onData(data)');
  compact.context.data = { now: Date.now(), sessions: [session({ status: 'error', error: 'Compact failure' })] };
  compact.run('onData(data)');
  assert.equal(compact.notifications.length, 0);

  const subagent = page();
  subagent.context.data = { now: Date.now(), sessions: [session({ subagent: true })] };
  subagent.run('onData(data)');
  subagent.context.data = { now: Date.now(), sessions: [session({ subagent: true, status: 'error', error: 'Subagent failure' })] };
  subagent.run('onData(data)');
  assert.equal(subagent.notifications.length, 0);
});

test('source diagnostics distinguish an absent source from an empty window and hide raw reasons', () => {
  const p = page();
  p.context.data = {
    now: p.now(),
    sessions: [],
    sources: [
      { agent: 'codex', state: 'missing', lastSuccessAt: null, reason: 'not_found', path: 'C:\\private\\agent-log.jsonl' },
      { agent: 'claude', state: 'empty', lastSuccessAt: p.now() - 60_000, reason: 'no_recent_logs' },
      { agent: 'gemini', state: 'read_error', lastSuccessAt: null, reason: 'reading_denied' },
      { agent: 'omp', state: 'parse_error', lastSuccessAt: p.now() - 20_000, reason: 'invalid_json' },
      { agent: 'dsh', state: 'unavailable', lastSuccessAt: null, reason: 'not_instrumented' },
      { agent: 'grok', state: 'read_error', lastSuccessAt: null, reason: 'C:\\private\\secret error text' },
    ],
  };
  p.run('onData(data)');
  const html = p.elements.get('sourcesPanel')?.innerHTML || '';
  assert.match(html, /Not installed or source path not found/);
  assert.match(html, /No logs in the selected time range/);
  assert.match(html, /Read access was denied/);
  assert.match(html, /Could not parse the log source/);
  assert.match(html, /Unavailable/);
  assert.doesNotMatch(html, /C:\\private|reading_denied|invalid_json|not_instrumented/);

  const legacy = page();
  sendSnapshot(legacy, []);
  assert.match(legacy.elements.get('sourcesPanel')?.innerHTML || '', /Source diagnostics are unavailable/);
});

test('session evidence uses allowlisted event kinds and their own timestamps', () => {
  const p = page();
  assert.equal(p.run('typeof sessionEvidenceHtml'), 'function');
  const eventAt = p.now() - 30 * 60 * 1000;
  const readAt = p.now() - 90 * 60 * 1000;
  const legacyAt = p.now() - 24 * 60 * 60 * 1000;
  const fixture = {
    lastEventAt: legacyAt,
    statusEvidence: { kind: 'assistant_message', at: eventAt },
    sourceHealth: { state: 'ok', lastSuccessAt: readAt, reason: null },
  };
  const html = p.run(`sessionEvidenceHtml(${JSON.stringify(fixture)})`);
  const formatAt = (value) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
  assert.match(html, /Assistant message/);
  assert.ok(html.includes(formatAt(eventAt)), 'the state event shows its original event time');
  assert.ok(html.includes(formatAt(readAt)), 'source health shows the successful content-read time');
  assert.ok(!html.includes(formatAt(legacyAt)), 'lastEventAt does not replace either evidence timestamp');

  const absent = p.run('sessionEvidenceHtml({})');
  assert.match(absent, /No state-event evidence available/);
  assert.match(absent, /Source health unavailable/);
  const unknownKind = p.run(`sessionEvidenceHtml({statusEvidence:{kind:'private raw log text',at:${eventAt}}})`);
  assert.doesNotMatch(unknownKind, /private raw log text/);
  assert.match(unknownKind, /Event type unavailable/);
});

test('source and evidence labels are localized in English and Traditional Chinese with English fallback', () => {
  const p = page();
  assert.equal(p.run('I18N.en.logSources'), 'Log sources');
  assert.equal(p.run('I18N["zh-TW"].logSources'), '記錄來源');
  assert.equal(p.run('I18N.en.sourceStateMissing'), 'Not installed or source path not found');
  assert.equal(p.run('I18N["zh-TW"].sourceStateMissing'), '未安裝或找不到來源路徑');
  assert.equal(p.run('I18N.en.evidenceKindAssistantMessage'), 'Assistant message');
  assert.equal(p.run('I18N["zh-TW"].evidenceKindAssistantMessage'), '助理訊息');
  assert.equal(p.run('I18N.es.logSources'), 'Log sources');
});

test('error and notification labels are localized in English and Traditional Chinese with English fallback', () => {
  const p = page();
  assert.equal(p.run('I18N.en.errorNote("Sample")'), 'Sample: Error');
  assert.match(p.run('I18N.en.notify'), /input requests.*errors.*completed/i);
  assert.equal(p.run('I18N["zh-TW"].errorNote("Sample")'), 'Sample：錯誤');
  assert.match(p.run('I18N["zh-TW"].notify'), /需要你回應.*錯誤.*完成/);
  assert.equal(p.run('I18N.es.errorNote("Sample")'), 'Sample: Error');
  assert.match(p.run('I18N.es.notify'), /input requests.*errors.*completed/i);
});

test('notification category preference falls through from disabled errors to pending requests', () => {
  const p = page();
  p.run('window.__chimes=[]; chime=(kind)=>window.__chimes.push(kind); state.sound=true; state.notifyErrors=false; state.notifyNeeds=true');
  sendSnapshot(p, [session()]);
  sendSnapshot(p, [session({ status: 'error', error: 'Hidden error detail', needsInput: true,
    pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose a recovery action' }] })]);

  assert.equal(p.notifications.length, 1);
  assert.match(p.notifications[0].title, /Waiting for you/);
  assert.equal(p.notifications[0].options.body, 'Choose a recovery action');
  assert.doesNotMatch(p.notifications[0].options.body, /Hidden error detail/);
  assert.deepEqual([...p.run('window.__chimes')], ['attention']);
  assert.equal(p.run('state.data.sessions[0].status'), 'error');
  assert.equal(p.run('state.flash.has("codex:one")'), true);
});

test('each disabled notification category suppresses only its matching event', () => {
  const events = [
    ['notifyNeeds', session({ needsInput: true, pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose one' }] })],
    ['notifyErrors', session({ status: 'error', error: 'Tool crashed' })],
    ['notifyDone', session({ status: 'done' })],
  ];
  for (const [preference, event] of events) {
    const p = page();
    p.run('window.__chimes=[]; chime=(kind)=>window.__chimes.push(kind); state.sound=true');
    sendSnapshot(p, [session()]);
    p.run(`state.${preference}=false`);
    sendSnapshot(p, [event]);
    assert.equal(p.notifications.length, 0, `${preference} suppresses its category`);
    assert.deepEqual([...p.run('window.__chimes')], []);
    assert.equal(p.run('state.flash.has("codex:one")'), true, 'category switches leave visual attention enabled');
  }
});

test('desktop master and sound are independent while both honor category switches', () => {
  const soundOnly = page();
  soundOnly.run('window.__chimes=[]; chime=(kind)=>window.__chimes.push(kind); state.notify=false; state.sound=true; state.notifyNeeds=true');
  sendSnapshot(soundOnly, [session()]);
  sendSnapshot(soundOnly, [session({ needsInput: true, pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose one' }] })]);
  assert.equal(soundOnly.notifications.length, 0);
  assert.deepEqual([...soundOnly.run('window.__chimes')], ['attention']);

  const desktopOnly = page();
  desktopOnly.run('window.__chimes=[]; chime=(kind)=>window.__chimes.push(kind); state.notify=true; state.sound=false; state.notifyNeeds=true');
  sendSnapshot(desktopOnly, [session()]);
  sendSnapshot(desktopOnly, [session({ needsInput: true, pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose one' }] })]);
  assert.equal(desktopOnly.notifications.length, 1);
  assert.deepEqual([...desktopOnly.run('window.__chimes')], []);
});

test('denied desktop permission does not disable an independently enabled sound', () => {
  const p = page();
  p.run('window.__chimes=[]; chime=(kind)=>window.__chimes.push(kind); state.notify=true; state.sound=true; state.notifyNeeds=true');
  p.context.Notification.permission = 'denied';
  sendSnapshot(p, [session()]);
  sendSnapshot(p, [session({ needsInput: true, pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose one' }] })]);
  assert.equal(p.notifications.length, 0);
  assert.deepEqual([...p.run('window.__chimes')], ['attention']);
});

test('a notification pause gates desktop and sound without catch-up after expiry', () => {
  const p = page();
  p.run('window.__chimes=[]; chime=(kind)=>window.__chimes.push(kind); state.sound=true; state.notifyPausedUntil=Date.now()+900000');
  sendSnapshot(p, [session()]);
  const paused = session({ needsInput: true, pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose one' }] });
  sendSnapshot(p, [paused]);
  assert.equal(p.notifications.length, 0);
  assert.deepEqual([...p.run('window.__chimes')], []);
  assert.equal(p.run('state.prev.get("codex:one").pendingIds[0]'), 'q1');
  assert.equal(p.run('state.data.sessions[0].pendingRequests[0].id'), 'q1');

  p.setNow(p.now() + 900001);
  sendSnapshot(p, [paused]);
  assert.equal(p.notifications.length, 0, 'a pending request that arrived during the pause is not replayed');
  assert.deepEqual([...p.run('window.__chimes')], []);

  sendSnapshot(p, [session()]);
  sendSnapshot(p, [session({ needsInput: true, pendingRequests: [{ id: 'q2', kind: 'question', summary: 'A new request' }] })]);
  assert.equal(p.notifications.length, 1);
  assert.deepEqual([...p.run('window.__chimes')], ['attention']);
});

test('new notification preferences validate bounded project keys and absolute pause deadlines', () => {
  const p = page();
  assert.equal(p.run('validPreference("notifyPausedUntil", 0)'), true);
  assert.equal(p.run('validPreference("notifyPausedUntil", 1700000900000)'), true);
  assert.equal(p.run('validPreference("notifyPausedUntil", -1)'), false);
  assert.equal(p.run('validPreference("notifyPausedUntil", Infinity)'), false);
  assert.equal(p.run('validPreference("notifyNeeds", true)'), true);
  assert.equal(p.run('validPreference("notifyErrors", "true")'), false);
  assert.equal(p.run('validPreference("pipSummary", false)'), true);
  assert.equal(p.run('validPreference("pipProjects", ["cwd:/repo/a", "session:codex:one"])'), true);
  assert.equal(p.run('validPreference("pipProjects", ["/repo/a"])'), false);
  assert.equal(p.run('validPreference("pipProjects", Array(65).fill("cwd:/repo/a"))'), false);
});

test('PiP summary groups pending errors once and project selection never mutates main data', () => {
  const p = page('?pip=1');
  let officeUpdates = 0;
  p.context.office = { setVisible() {}, update() { officeUpdates++; } };
  p.context.items = [
    session({ key: 'codex:a', id: 'a', cwd: '/repo/a', project: 'Same name', status: 'error', error: 'Permission denied', needsInput: true,
      pendingRequests: [{ id: 'q1', kind: 'question', summary: 'Choose one' }] }),
    session({ key: 'codex:b', id: 'b', cwd: '/repo/b', project: 'Same name', status: 'error', error: 'Tool crashed' }),
    session({ key: 'codex:c', id: 'c', cwd: null, project: 'No cwd', status: 'unknown', lastEventAt: null }),
    session({ key: 'codex:d', id: 'd', cwd: '/repo/a', project: 'Same name', status: 'tool' }),
    session({ key: 'codex:done', id: 'done', cwd: '/repo/a', project: 'Same name', status: 'done' }),
  ];
  p.run('state.loaded=true; state.pipSummary=true; state.data.sessions=items; syncControls(); render()');

  let html = p.elements.get('main').innerHTML;
  assert.match(html, /class="pip-summary"/);
  assert.match(html, /data-group="needsYou"[^>]*>[\s\S]*?<strong>1<\/strong>/);
  assert.match(html, /data-group="errors"[^>]*>[\s\S]*?<strong>1<\/strong>/);
  assert.match(html, /data-group="unknown"[^>]*>[\s\S]*?<strong>1<\/strong>/);
  assert.match(html, /data-group="working"[^>]*>[\s\S]*?<strong>1<\/strong>/);
  assert.equal(p.run('typeof projectKey'), 'function');
  assert.equal(p.run('projectKey(items[0])'), 'cwd:/repo/a');
  assert.equal(p.run('projectKey(items[1])'), 'cwd:/repo/b');
  assert.match(p.run('projectKey(items[2])'), /^session:/);
  assert.equal(p.run('projectKey({cwd:"C:\\\\Repo\\\\App",agent:"codex",id:"one"})'), 'cwd:c:/repo/app', 'Windows drive paths compare stably across slash forms and letter case');
  assert.equal(p.run('projectKey({cwd:"//server/share/App",agent:"codex",id:"one"})'), 'cwd://server/share/App', 'UNC identity retains its double-slash root');
  assert.notEqual(p.run('projectKey({cwd:"/repo\\\\app",agent:"codex",id:"one"})'), p.run('projectKey({cwd:"/repo/app",agent:"codex",id:"one"})'), 'a POSIX cwd is not rewritten as a Windows path');
  assert.equal(p.run('validPreference("pipProjects", ["cwd:"+"x".repeat(8188)])'), true);
  assert.equal(p.run('validPreference("pipProjects", ["cwd:"+"x".repeat(8189)])'), false);
  assert.equal(officeUpdates, 0, 'summary mode does not update or animate office agents');

  p.run('state.pipProjects=["cwd:/repo/a"]; render()');
  html = p.elements.get('main').innerHTML;
  assert.match(html, /data-group="needsYou"[^>]*>[\s\S]*?<strong>1<\/strong>/);
  assert.match(html, /data-group="errors"><span>Errors<\/span><b><strong>0<\/strong>/,
    'a pending error is counted once under Needs you, not again under Errors');
  assert.equal(p.run('state.data.sessions.length'), 5, 'the PiP display filter leaves the full source snapshot intact');
  assert.match(p.elements.get('pipProjectsList').innerHTML, /\/repo\/a/);
  assert.match(p.elements.get('pipProjectsList').innerHTML, /\/repo\/b/);

  p.run('state.pipProjects=["cwd:/missing"]; syncControls(); render()');
  html = p.elements.get('main').innerHTML;
  assert.match(html, /data-pip-no-matches/);
  assert.match(p.elements.get('pipProjectsList').innerHTML, /Unavailable/);
  assert.deepEqual([...p.run('state.pipProjects')], ['cwd:/missing'], 'missing selections remain selected instead of broadening');

  p.run('state.pipProjects=["cwd:/repo/a"]; state.pipSummaryExpanded=true; syncControls(); render()');
  assert.equal(p.run('state.view'), 'office', 'expanding the summary does not overwrite the saved view');
  html = p.elements.get('main').innerHTML;
  assert.match(html, /data-key="codex:a"/);
  assert.match(html, /data-key="codex:d"/);
  assert.doesNotMatch(html, /data-key="codex:b"|data-key="codex:c"/);
  assert.equal(officeUpdates, 0, 'the expanded list does not update or animate the hidden office');
});
