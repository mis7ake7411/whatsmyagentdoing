'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual card/render/onData functions without starting a browser
// or replacing their output with a mocked renderer.
function page() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', style: {}, options: [{}],
      classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {} });
    return elements.get(id);
  };
  const notifications = [];
  function Notification(title, options) { notifications.push({ title, options }); }
  Notification.permission = 'granted';
  const context = vm.createContext({ console, Intl, URLSearchParams, Notification,
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {}, documentElement: {} },
    navigator: { languages: ['en'] }, location: { search: '' }, history: {},
    localStorage: { getItem: () => null, setItem() {} }, office: null, refreshTip() {},
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), context);
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const script = html.split('<script>')[1].split('// ---- office view')[0];
  vm.runInContext(script, context);
  return { context, elements, notifications, run: (code) => vm.runInContext(code, context) };
}

function session(overrides = {}) {
  return { key: 'codex:one', id: 'one', agent: 'codex', project: 'Sample', status: 'tool',
    activity: 'Shell: tests', subagent: false, lastEventAt: 1000, turnStartedAt: 1000,
    pendingRequests: [], needsInput: false, staleAfterMs: 600000, ...overrides };
}

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
