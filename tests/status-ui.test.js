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
        }, addEventListener() {} });
    }
    return elements.get(id);
  };
  const notifications = [];
  function Notification(title, options) { notifications.push({ title, options }); }
  Notification.permission = 'granted';
  const context = vm.createContext({ console, Intl: testIntl, Date: TestDate, EventSource: FakeEventSource, URLSearchParams, Notification,
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {}, documentElement: { dataset: {} }, body: { classList: { add() {} } } },
    Image: class {},
    navigator: { languages: ['en'] }, location: { search }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} }, office: null, refreshTip() {},
  });
  context.window = context;
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
  p.run("state.view = 'list'; render()");
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
  p.run("state.view = 'list'; state.data.sessions = items; render()");
  const html = p.elements.get('main').innerHTML;
  assert.match(html, /Needs you/);
  assert.equal((html.match(/data-key="codex:one"/g) || []).length, 1);
  assert.doesNotMatch(html, /<h2>Working/);
});

test('unknown sessions remain visible without enabling the idle filter', () => {
  const p = page();
  p.context.items = [session({ status: 'unknown', lastEventAt: null })];
  p.run("state.view = 'list'; state.data.sessions = items; render()");
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

test('error and notification labels are localized in English and Traditional Chinese with English fallback', () => {
  const p = page();
  assert.equal(p.run('I18N.en.errorNote("Sample")'), 'Sample: Error');
  assert.match(p.run('I18N.en.notify'), /input requests.*errors.*completed/i);
  assert.equal(p.run('I18N["zh-TW"].errorNote("Sample")'), 'Sample：錯誤');
  assert.match(p.run('I18N["zh-TW"].notify'), /需要你回應.*錯誤.*完成/);
  assert.equal(p.run('I18N.es.errorNote("Sample")'), 'Sample: Error');
  assert.match(p.run('I18N.es.notify'), /input requests.*errors.*completed/i);
});
