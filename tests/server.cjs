// Each case owns a child process so an uncaught request error fails the test.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

for (const scenario of ['assets', 'scenes', 'guards', 'streams']) {
  test(`HTTP ${scenario}: malformed paths and resource boundaries`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-server-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/server.cjs'), scenario, home], {
      env: { ...process.env, HOME: home, USERPROFILE: home, WMAD_NO_UPDATE_CHECK: '1' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}

test('silence marks active sessions stale without changing the observed status', () => {
  const { snapshot } = require('../src/server');
  const now = Date.now(), min = 60_000;
  const s = (key, status, ago) => ({ agent: 'claude', id: key, status, lastEventAt: now - ago, cwd: '/w' });
  const rows = snapshot({ sessions: () => [s('a', 'tool', 9 * min), s('b', 'tool', 12 * min), s('c', 'thinking', 9 * min),
    s('d', 'thinking', 20 * min), s('e', 'waiting', 30 * min), s('f', 'tool', 50 * min)] }, { privacy: false }).sessions;
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by.a.status, 'tool'); assert.equal(by.a.stale, false);
  assert.equal(by.b.status, 'tool'); assert.equal(by.b.stale, true);
  assert.equal(by.c.status, 'thinking'); assert.equal(by.c.stale, false);
  assert.equal(by.d.status, 'thinking'); assert.equal(by.d.stale, true);
  assert.equal(by.e.status, 'waiting'); assert.equal(by.e.stale, true);
  assert.equal(by.f.status, 'tool'); assert.equal(by.f.stale, true);
  assert.ok(rows.every(row => row.stuck === undefined), 'silence is not reported as a stuck status');
});

test('Antigravity is included in the sanitized source snapshot', () => {
  const { snapshot } = require('../src/server');
  const health = { state: 'ok', lastSuccessAt: 123, reason: null };
  const result = snapshot({
    sessions: () => [{ agent: 'antigravity', id: 'session-1', status: 'thinking', lastEventAt: 123 }],
    sourceHealthFor: () => health,
    sources: () => [{ agent: 'antigravity', ...health, file: 'private/transcript.jsonl' }],
  }, { privacy: false });

  assert.deepEqual(result.sources, [{ agent: 'antigravity', ...health }]);
  assert.deepEqual(result.sessions[0].sourceHealth, health);
  assert.equal(JSON.stringify(result).includes('private/transcript.jsonl'), false);
});
