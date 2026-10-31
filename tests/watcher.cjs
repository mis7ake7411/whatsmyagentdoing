// Isolated logs only: never read the developer's actual agent history.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { snapshot } = require('../src/server');

const watcherPath = path.join(__dirname, '../src/watcher.js');
const localRequire = createRequire(watcherPath);
const source = fs.readFileSync(watcherPath, 'utf8');
const HOUR = 3600000;
const NOW = Date.parse('2026-10-26T10:00:00Z');

function fixture(t, hours = 24) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-watcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = NOW;
  const reads = [];
  const blocked = new Set();
  const blockedReads = new Set();
  const blockedStats = new Set();
  const io = new Proxy(fs, {
    get(target, name) {
      if (['openSync', 'readdirSync', 'statSync'].includes(name)) return (file, ...args) => {
        if (blocked.has(String(file))) throw Object.assign(new Error('Fixture access denied'), { code: 'EACCES' });
        if (name === 'openSync' && blockedReads.has(String(file))) throw Object.assign(new Error('Fixture read denied'), { code: 'EACCES' });
        if (name === 'statSync' && blockedStats.has(String(file))) throw Object.assign(new Error('Fixture stat denied'), { code: 'EACCES' });
        if (name === 'openSync') reads.push(String(file));
        return target[name](file, ...args);
      };
      return target[name];
    },
  });
  class Clock extends Date { static now() { return now; } }
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod, Buffer, Date: Clock, process: { env: {} }, setInterval, clearInterval,
    require: name => name === 'os' ? { homedir: () => root } : name === 'fs' ? io : localRequire(name),
  }, { filename: watcherPath });
  const watcher = new mod.exports.Watcher({ hours });
  const event = (type, at, extra = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type, ...extra } }) + '\n';
  const write = (day, n, at) => {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const file = path.join(root, '.codex/sessions', day, `rollout-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ timestamp: '2025-01-01T00:00:00Z', type: 'session_meta', payload: { cwd: '/demo/long-chat' } }) + '\n' + event('task_started', at));
    fs.utimesSync(file, new Date(at), new Date(at));
    return { file, id };
  };
  return { root, watcher, write, reads, blocked, blockedReads, blockedStats,
    advance: ms => { now += ms; },
    append(log, type, extra) {
      fs.appendFileSync(log.file, event(type, now, extra));
      fs.utimesSync(log.file, new Date(now), new Date(now));
    },
  };
}

test('recently active Codex chats in old date folders are discovered without an index', t => {
  const f = fixture(t);
  const old = f.write('2025/01/01', 1, NOW - HOUR);
  const recent = f.write('2026/10/26', 2, NOW - HOUR);
  const inactive = f.write('2026/08/19', 3, NOW - 48 * HOUR);
  f.watcher.tick();
  assert.deepEqual(Array.from(f.watcher.sessions(), s => s.id).sort(), [old.id, recent.id].sort());
  assert.equal(f.reads.includes(inactive.file), false, 'inactive history is not opened');
  assert.equal(f.watcher.sessions().find(s => s.id === old.id).status, 'thinking');
});

test('an old inactive chat is discovered after resuming, then tailed without reopening', t => {
  const f = fixture(t);
  const log = f.write('2026/08/19', 1, NOW - 48 * HOUR);
  f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 0);
  f.advance(6000);f.append(log, 'task_started');f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 1);
  const tracker = f.watcher.trackers.get(log.file);
  f.advance(1000);f.append(log, 'task_complete', { last_agent_message: 'Finished' });f.watcher.tick();
  assert.equal(f.watcher.trackers.get(log.file), tracker, 'reuse incremental tracker');
  assert.equal(f.watcher.sessions()[0].status, 'done');
  assert.equal(f.watcher.sessions()[0].reply, 'Finished');
});

test('custom hours still excludes inactive logs and expires tracked sessions', t => {
  const f = fixture(t, 2);
  const active = f.write('2024/12/31', 1, NOW - HOUR);
  const inactive = f.write('2026/10/26', 2, NOW - 3 * HOUR);
  f.watcher.tick();
  assert.deepEqual(Array.from(f.watcher.sessions(), s => s.id), [active.id]);
  assert.equal(f.reads.includes(inactive.file), false);
  f.advance(3 * HOUR);f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 0);
});

test('an inaccessible historical folder or log does not hide readable active chats', t => {
  const f = fixture(t);
  const hidden = f.write('2025/01/01', 1, NOW - HOUR);
  const blocked = f.write('2025/02/02', 2, NOW - HOUR);
  const good = f.write('2025/03/03', 3, NOW - HOUR);
  f.blocked.add(path.dirname(hidden.file));f.blocked.add(blocked.file);
  assert.doesNotThrow(() => f.watcher.tick());
  assert.deepEqual(Array.from(f.watcher.sessions(), s => s.id), [good.id]);
});

test('historical files outside the window stay out of the one-second polling list', t => {
  const f = fixture(t);
  for (let n = 1; n <= 300; n++) f.write('2025/01/01', n, NOW - 48 * HOUR);
  const active = f.write('2025/01/01', 301, NOW - HOUR);
  f.watcher.tick();
  assert.deepEqual(Array.from(f.watcher.candidates, c => c.file), [active.file]);
  assert.deepEqual(f.reads, [active.file]);
});

test('a large long-lived chat keeps head metadata and reads its current state from the tail', t => {
  const f = fixture(t);
  const log = f.write('2025/01/01', 1, NOW - HOUR);
  const filler = JSON.stringify({ type: 'padding', payload: { text: 'x'.repeat(4096) } }) + '\n';
  fs.appendFileSync(log.file, filler.repeat(300));
  f.append(log, 'task_complete', { last_agent_message: 'Latest reply in the tail' });
  f.watcher.tick();
  const session = f.watcher.sessions()[0];
  assert.equal(session.id, log.id);
  assert.equal(session.cwd, '/demo/long-chat');
  assert.equal(session.status, 'done');
  assert.equal(session.reply, 'Latest reply in the tail');
  assert.equal(f.reads.filter(file => file === log.file).length, 2, 'read only the head and tail');
});

test('legacy Gemini documents reload when their size changes without an mtime change', t => {
  const f = fixture(t);
  const file = path.join(f.root, '.gemini/tmp/demo/chats/session-legacy.json');
  const stamp = new Date(NOW);
  const doc = { sessionId: 'legacy', messages: [
    { type: 'user', timestamp: stamp.toISOString(), content: 'Read the configuration' },
  ] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.utimesSync(file, stamp, stamp);
  f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 1);
  assert.equal(f.watcher.sessions()[0].status, 'thinking');
  const before = fs.statSync(file);

  doc.messages.push({ type: 'gemini', timestamp: stamp.toISOString(),
    toolCalls: [{ name: 'read_file', status: 'executing', args: { path: 'config.json' } }],
  });
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.utimesSync(file, stamp, stamp);
  const after = fs.statSync(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.ok(after.size > before.size);

  f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 1);
  assert.equal(f.watcher.sessions()[0].status, 'tool');
  assert.equal(f.watcher.sessions()[0].activity, 'read_file config.json');
});

test('source snapshots distinguish absent roots from empty sources and keep actual read time', t => {
  const f = fixture(t);
  f.watcher.tick();
  let out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sources.length, 8);
  assert.equal(out.sources.find(source => source.agent === 'codex').state, 'missing');

  fs.mkdirSync(path.join(f.root, '.codex/sessions'), { recursive: true });
  f.advance(6000); f.watcher.tick();
  out = snapshot(f.watcher, { demo: true, privacy: false });
  const codex = out.sources.find(source => source.agent === 'codex');
  assert.equal(codex.state, 'empty');
  assert.equal(codex.reason, 'no_recent_logs');

  const log = f.write('2026/10/26', 900, NOW - HOUR);
  f.advance(6000); f.watcher.tick();
  out = snapshot(f.watcher, { demo: true, privacy: false });
  const firstRead = out.sources.find(source => source.agent === 'codex').lastSuccessAt;
  assert.equal(firstRead, NOW + 12_000, 'successful content read records the wall clock');

  f.advance(1000); f.watcher.tick();
  out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sources.find(source => source.agent === 'codex').lastSuccessAt, firstRead, 'unchanged polling does not count as a read');
  assert.equal(out.sessions[0].sourceHealth.state, 'ok');
  assert.equal(JSON.stringify(out).includes(log.file), false, 'serialized diagnostics never include log paths');
});

test('old Claude, Gemini and Copilot files do not make empty sources look healthy', t => {
  const f = fixture(t);
  const old = new Date(NOW - 48 * HOUR);
  const writeOld = (rel, content) => {
    const file = path.join(f.root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.utimesSync(file, old, old);
    return file;
  };
  writeOld('.claude/projects/demo/old.jsonl', JSON.stringify({ type: 'user', timestamp: old.toISOString(), message: { content: 'Old' } }) + '\n');
  writeOld('.gemini/tmp/demo/chats/session-old.jsonl', JSON.stringify({ sessionId: 'old', messages: [{ type: 'user', timestamp: old.toISOString(), content: 'Old' }] }) + '\n');
  writeOld('.copilot/session-state/old/events.jsonl', JSON.stringify({ type: 'user.message', timestamp: old.toISOString(), data: { content: 'Old' } }) + '\n');

  f.watcher.tick();
  const sources = snapshot(f.watcher, { demo: true, privacy: false }).sources;
  for (const agent of ['claude', 'gemini', 'copilot']) {
    const source = sources.find(item => item.agent === agent);
    assert.equal(source.state, 'empty', `${agent} has no eligible recent log`);
    assert.equal(source.reason, 'no_recent_logs');
    assert.equal(source.lastSuccessAt, null);
  }
  assert.equal(f.watcher.sessions().length, 0);
});

test('a denied incremental read preserves the last session state and recovers after a successful read', t => {
  const f = fixture(t);
  const log = f.write('2026/10/26', 901, NOW - HOUR);
  f.watcher.tick();
  const first = f.watcher.sessions()[0];
  assert.equal(first.status, 'thinking');
  const firstRead = snapshot(f.watcher, { demo: true, privacy: false }).sources.find(source => source.agent === 'codex').lastSuccessAt;

  f.advance(1000);
  f.append(log, 'task_complete', { last_agent_message: 'Finished' });
  f.blockedReads.add(log.file);
  f.watcher.tick();
  let out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sessions.length, 1, 'a read failure keeps the last readable session');
  assert.equal(out.sessions[0].status, 'thinking');
  assert.deepEqual(out.sessions[0].sourceHealth, { state: 'read_error', lastSuccessAt: firstRead, reason: 'reading_denied' });
  assert.equal(out.sources.find(source => source.agent === 'codex').state, 'read_error');

  f.blockedReads.delete(log.file);
  f.advance(60_000);
  f.watcher.tick();
  out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sessions[0].status, 'done');
  assert.equal(out.sources.find(source => source.agent === 'codex').state, 'ok');
  assert.equal(out.sources.find(source => source.agent === 'codex').lastSuccessAt, NOW + 61_000);
});

test('a recovered stat denial retries an unchanged file instead of leaving stale diagnostics', t => {
  const f = fixture(t);
  const log = f.write('2026/10/26', 906, NOW - HOUR);
  f.watcher.tick();
  const firstRead = snapshot(f.watcher, { demo: true, privacy: false }).sources.find(source => source.agent === 'codex').lastSuccessAt;

  f.blockedStats.add(log.file);
  f.advance(1000); f.watcher.tick();
  assert.equal(snapshot(f.watcher, { demo: true, privacy: false }).sources.find(source => source.agent === 'codex').state, 'read_error');

  f.blockedStats.delete(log.file);
  f.advance(1000); f.watcher.tick();
  const out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sources.find(source => source.agent === 'codex').state, 'ok');
  assert.equal(out.sources.find(source => source.agent === 'codex').lastSuccessAt, NOW + 2000);
  assert.ok(out.sources.find(source => source.agent === 'codex').lastSuccessAt > firstRead);
});

test('an empty recent source log is opened before a successful read is recorded', t => {
  const f = fixture(t);
  const log = f.write('2026/10/26', 907, NOW);
  fs.writeFileSync(log.file, '');
  f.blockedReads.add(log.file);
  f.watcher.tick();
  const source = snapshot(f.watcher, { demo: true, privacy: false }).sources.find(item => item.agent === 'codex');
  assert.equal(source.state, 'read_error');
  assert.equal(source.reason, 'reading_denied');
  assert.equal(source.lastSuccessAt, null);
});

test('malformed complete records remain visible beside valid sources; partial tails are ignored', t => {
  const f = fixture(t);
  const good = f.write('2026/10/26', 902, NOW - HOUR);
  const badPath = path.join(f.root, '.codex/sessions/2026/10/26/rollout-00000000-0000-4000-8000-000000000903.jsonl');
  fs.mkdirSync(path.dirname(badPath), { recursive: true });
  fs.writeFileSync(badPath, [
    '{"type":"event_msg","payload":{"type":"task_started"}}',
    '{invalid-secret-record}',
    JSON.stringify({ timestamp: new Date(NOW - 30_000).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
    '',
  ].join('\n'));
  fs.utimesSync(badPath, new Date(NOW - HOUR), new Date(NOW - HOUR));
  f.watcher.tick();
  let out = snapshot(f.watcher, { demo: true, privacy: false });
  let codex = out.sources.find(source => source.agent === 'codex');
  assert.equal(codex.state, 'parse_error', 'one bad file is not hidden by a healthy file in the same source');
  assert.equal(codex.reason, 'invalid_json');
  assert.equal(out.sessions.length, 2, 'valid records from both files remain available');
  assert.equal(out.sessions.find(session => session.id.endsWith('000000000903')).status, 'done', 'a later good line in the same read still applies');

  f.advance(1000);
  f.append({ file: good.file }, 'task_complete', { last_agent_message: 'Good file continued' });
  f.watcher.tick();
  out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sources.find(source => source.agent === 'codex').state, 'parse_error', 'a healthy file cannot clear another file error');
  assert.equal(JSON.stringify(out).includes('invalid-secret-record'), false, 'parse diagnostics exclude raw contents');

  fs.appendFileSync(badPath, JSON.stringify({ timestamp: new Date(NOW + 6000).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  fs.utimesSync(badPath, new Date(NOW + 6000), new Date(NOW + 6000));
  f.advance(6000); f.watcher.tick();
  out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sources.find(source => source.agent === 'codex').state, 'ok', 'a later clean read recovers this file');

  f.advance(1000);
  fs.appendFileSync(badPath, '{"timestamp":"2026-10-26T10:00:08.000Z","type":"event_msg","payload":{"type":"task_complete"}');
  fs.utimesSync(badPath, new Date(NOW + 7000), new Date(NOW + 7000));
  f.watcher.tick();
  out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sources.find(source => source.agent === 'codex').state, 'ok', 'an incomplete final line is intentionally ignored');
});

test('a same-size corrected JSONL file clears a parse error only after replay', t => {
  const f = fixture(t);
  const log = f.write('2026/10/26', 908, NOW - HOUR);
  const validPrefix = fs.readFileSync(log.file);
  fs.appendFileSync(log.file, '{]\n');
  fs.utimesSync(log.file, new Date(NOW), new Date(NOW));
  f.watcher.tick();
  assert.equal(snapshot(f.watcher, { demo: true, privacy: false }).sources.find(item => item.agent === 'codex').state, 'parse_error');

  f.advance(1000);
  fs.writeFileSync(log.file, Buffer.concat([validPrefix, Buffer.from('{}\n')]));
  fs.utimesSync(log.file, new Date(NOW + 1000), new Date(NOW + 1000));
  f.watcher.tick();
  const out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sources.find(item => item.agent === 'codex').state, 'ok');
  assert.equal(out.sessions[0].status, 'thinking');
  assert.equal(out.sources.find(item => item.agent === 'codex').lastSuccessAt, NOW + 1000);
});

test('an unchanged invalid Gemini replacement is not retried or counted as a fresh read each poll', t => {
  const f = fixture(t);
  const file = path.join(f.root, '.gemini/tmp/demo/chats/session-repair.json');
  const stamp = new Date(NOW - 1000).toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'repair', messages: [{ type: 'user', timestamp: stamp, content: 'Keep current state' }] }));
  fs.utimesSync(file, new Date(NOW), new Date(NOW));
  f.watcher.tick();
  const previous = snapshot(f.watcher, { demo: true, privacy: false }).sources.find(item => item.agent === 'gemini').lastSuccessAt;

  f.advance(1000);
  fs.writeFileSync(file, '{');
  fs.utimesSync(file, new Date(NOW + 1000), new Date(NOW + 1000));
  f.watcher.tick();
  let out = snapshot(f.watcher, { demo: true, privacy: false });
  const failedReadAt = out.sources.find(item => item.agent === 'gemini').lastSuccessAt;
  assert.equal(out.sources.find(item => item.agent === 'gemini').state, 'parse_error');
  assert.equal(out.sessions[0].status, 'thinking', 'the last valid whole-document state remains visible');
  assert.ok(failedReadAt > previous, 'the changed content was read before its JSON parse failed');
  const readsAfterFailure = f.reads.filter(item => item === file).length;

  f.advance(1000); f.watcher.tick();
  out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sources.find(item => item.agent === 'gemini').lastSuccessAt, failedReadAt);
  assert.equal(f.reads.filter(item => item === file).length, readsAfterFailure, 'an unchanged failure is not re-read');

  f.advance(1000);
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'repair', messages: [{ type: 'user', timestamp: new Date(NOW + 2000).toISOString(), content: 'Repaired state' }] }));
  fs.utimesSync(file, new Date(NOW + 3000), new Date(NOW + 3000));
  f.watcher.tick();
  out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sources.find(item => item.agent === 'gemini').state, 'ok');
  assert.equal(out.sessions[0].status, 'thinking');
  assert.equal(out.sources.find(item => item.agent === 'gemini').lastSuccessAt, NOW + 3000);
});

test('directory discovery errors remain visible beside a readable session and clear after rescanning', t => {
  const f = fixture(t);
  const hidden = f.write('2025/01/01', 904, NOW - HOUR);
  const readable = f.write('2026/10/26', 905, NOW - HOUR);
  const deniedDirectory = path.dirname(hidden.file);
  f.blocked.add(deniedDirectory);
  f.watcher.tick();
  let out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].id, readable.id);
  assert.equal(out.sources.find(source => source.agent === 'codex').state, 'read_error');
  assert.equal(out.sources.find(source => source.agent === 'codex').reason, 'reading_denied');

  f.blocked.delete(deniedDirectory);
  f.advance(6000); f.watcher.tick();
  out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.equal(out.sources.find(source => source.agent === 'codex').state, 'ok');
  assert.equal(out.sessions.length, 2);
});

test('parser exceptions expose a fixed diagnostic while keeping the last valid status', t => {
  const f = fixture(t);
  const file = path.join(f.root, '.claude/projects/demo/session-parser-error.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const validAt = new Date(NOW - 1000).toISOString();
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', timestamp: validAt, message: { content: [{ type: 'text', text: 'Start work' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(NOW).toISOString(), message: { content: [null] } }),
    '',
  ].join('\n'));
  fs.utimesSync(file, new Date(NOW), new Date(NOW));
  f.watcher.tick();

  const out = snapshot(f.watcher, { demo: true, privacy: false });
  const source = out.sources.find(item => item.agent === 'claude');
  assert.equal(source.state, 'parse_error');
  assert.equal(source.reason, 'parser_failed');
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].status, 'thinking');
  assert.deepEqual(out.sessions[0].statusEvidence, { kind: 'user_message', at: NOW - 1000 });
  assert.equal(JSON.stringify(out.sources).includes('content'), false, 'diagnostics do not expose parser input');
});

test('hook waiting evidence is a projection and does not mutate the native session', t => {
  const f = fixture(t);
  const file = path.join(f.root, '.claude/projects/demo/session-hook.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const eventAt = new Date(NOW - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: eventAt, message: { content: 'Start work' } }) + '\n');
  fs.utimesSync(file, new Date(NOW), new Date(NOW));
  f.watcher.tick();

  const tracker = f.watcher.trackers.get(file);
  f.watcher.waiting.set('session-hook', { at: NOW + 500, message: 'Approval request' });
  const projected = f.watcher.sessions()[0];
  assert.equal(projected.status, 'waiting');
  assert.equal(projected.statusEvidence.kind, 'permission_hook');
  assert.equal(projected.statusEvidence.at, NOW + 500);
  assert.equal(tracker.session.status, 'thinking');
  assert.deepEqual(tracker.session.statusEvidence, { kind: 'user_message', at: NOW - 1000 });

  const out = snapshot(f.watcher, { demo: true, privacy: false });
  assert.deepEqual(out.sessions[0].statusEvidence, { kind: 'permission_hook', at: NOW + 500 });
  assert.equal(out.sessions[0].sourceHealth.state, 'ok');
});

test('DSH compressed-log failures use a fixed decoding code', t => {
  const f = fixture(t);
  const file = path.join(f.root, '.dsh/sessions/project/session/session.v3.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not a zstd frame');
  fs.utimesSync(file, new Date(NOW), new Date(NOW));
  f.watcher.tick();

  const source = snapshot(f.watcher, { demo: true, privacy: false }).sources.find(item => item.agent === 'dsh');
  assert.equal(source.state, 'parse_error');
  assert.equal(source.reason, 'decode_failed');
  assert.equal(JSON.stringify(source).includes(file), false);
});
