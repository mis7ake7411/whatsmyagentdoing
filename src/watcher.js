'use strict';

// Finds recent session logs on disk and keeps reading them as they grow.
// Polling (not fs.watch) because it behaves the same on macOS, Linux and
// Windows, and a 1s stat loop over a few hundred files is cheap.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');
const { newSession, applyClaude, applyCodex, applyGemini, applyGeminiDocument, applyCopilot, applyOMP } = require('./parsers');
const { Magpie } = require('./magpie');
const { clientFiles, metadata, applyKimi, applyDsh, applyGrok, readDsh } = require('./clients');
const { ompDirs } = require('./omp');
const hook = require('./hook');
const { transcript } = require('./transcript');
const { SOURCE_STATES, SOURCE_REASONS, errorReason, safeSourceHealth } = require('./diagnostics');

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 768 * 1024;
// OMP, Kimi and Grok logs are replayed whole up to this size, then read head + tail like the others.
const OMP_FULL_BYTES = 32 * 1024 * 1024;
// DSH logs are decoded and replayed whole, so a busy log is re-read at most this often.
const DSH_REPLAY_MS = 5000;
const LOCAL_AGENTS = ['claude', 'codex', 'gemini', 'copilot', 'kimi', 'dsh', 'grok', 'omp'];

const home = os.homedir();
const CLAUDE_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
const CODEX_HOME = process.env.CODEX_HOME || path.join(home, '.codex');
const CODEX_DIR = path.join(CODEX_HOME, 'sessions');
const CODEX_INDEX = path.join(CODEX_HOME, 'session_index.jsonl');
// Gemini CLI: ~/.gemini (or $GEMINI_CLI_HOME/.gemini); sandboxed runs on
// macOS keep their state under ~/.cache/.gemini instead.
const GEMINI_HOMES = [
  path.join(process.env.GEMINI_CLI_HOME || home, '.gemini'),
  path.join(home, '.cache', '.gemini'),
];
const GEMINI_DIR = path.join(GEMINI_HOMES[0], 'tmp');
const COPILOT_DIR = path.join(home, '.copilot', 'session-state');
const CLIENT_DIRS = {
  kimi: path.join(process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'sessions'),
  dsh: path.join(process.env.DSH_HOME || path.join(home, '.dsh'), 'sessions'),
  grok: path.join(process.env.GROK_HOME || path.join(home, '.grok'), 'sessions'),
};

function ls(dir, onDirectory) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    onDirectory?.(dir, null);
    return entries;
  } catch (error) {
    onDirectory?.(dir, error);
    return [];
  }
}

function statSafe(f, onError) {
  try { return fs.statSync(f); } catch (error) { onError?.(f, error); return null; }
}

function readRange(file, start, end, decoder) {
  const len = Math.max(0, end - start);
  const fd = fs.openSync(file, 'r');
  try {
    if (!len) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return decoder ? decoder.write(buf) : buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function statSignature(stat) {
  return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, size: stat.size };
}

function matchesStatSignature(signature, stat) {
  return signature && signature.mtimeMs === stat.mtimeMs && signature.ctimeMs === stat.ctimeMs
    && signature.ino === stat.ino && signature.size === stat.size;
}

function claudeFiles(onDirectory, sinceMs = -Infinity) {
  const out = [];
  for (const proj of ls(CLAUDE_DIR, onDirectory)) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(CLAUDE_DIR, proj.name);
    for (const e of ls(pdir, onDirectory)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const file = path.join(pdir, e.name), st = statSafe(file, onDirectory);
        if (st && st.mtimeMs >= sinceMs) out.push({ agent: 'claude', file, id: e.name.slice(0, -6) });
      } else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        for (const s of ls(sub, onDirectory)) {
          if (s.isFile() && s.name.endsWith('.jsonl')) {
            const file = path.join(sub, s.name), st = statSafe(file, onDirectory);
            if (st && st.mtimeMs >= sinceMs) out.push({ agent: 'claude', file, id: s.name.slice(0, -6), parentId: e.name });
          }
        }
      }
    }
  }
  return out;
}

function geminiFiles(onDirectory, sinceMs = -Infinity) {
  // <root>/tmp/<project>/chats/session-*.jsonl (+ legacy .json), and
  // subagents in <root>/tmp/<project>/chats/<parentSessionId>/<id>.jsonl
  const out = [];
  for (const root of GEMINI_HOMES) {
    const tmp = path.join(root, 'tmp');
    for (const proj of ls(tmp, onDirectory)) {
      if (!proj.isDirectory()) continue;
      const chats = path.join(tmp, proj.name, 'chats');
      for (const e of ls(chats, onDirectory)) {
        if (e.isFile() && /^session-.*\.jsonl?$/.test(e.name)) {
          const file = path.join(chats, e.name), st = statSafe(file, onDirectory);
          if (st && st.mtimeMs >= sinceMs) out.push({ agent: 'gemini', file, id: e.name.replace(/\.jsonl?$/, ''), project: proj.name, root });
        } else if (e.isDirectory()) {
          for (const f of ls(path.join(chats, e.name), onDirectory)) {
            if (f.isFile() && /\.jsonl$/.test(f.name)) {
              const file = path.join(chats, e.name, f.name), st = statSafe(file, onDirectory);
              if (st && st.mtimeMs >= sinceMs) out.push({ agent: 'gemini', file, id: f.name.slice(0, -6), project: proj.name, root, parentId: e.name });
            }
          }
        }
      }
    }
  }
  return out;
}

function codexFiles(sinceMs, onDirectory) {
  // Date folders record when a chat began, not when it was last used. Walk
  // every date so a months-old chat can be discovered when it resumes.
  // Check mtime here to keep inactive history out of the 1s polling list;
  // only the 5s discovery scan stats those files, without reading their logs.
  const out = [];
  for (const y of ls(CODEX_DIR, onDirectory)) {
    if (!y.isDirectory()) continue;
    for (const m of ls(path.join(CODEX_DIR, y.name), onDirectory)) {
      if (!m.isDirectory()) continue;
      for (const d of ls(path.join(CODEX_DIR, y.name, m.name), onDirectory)) {
        if (!d.isDirectory()) continue;
        const dir = path.join(CODEX_DIR, y.name, m.name, d.name);
        for (const f of ls(dir, onDirectory)) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
          const file = path.join(dir, f.name);
          const st = statSafe(file, onDirectory);
          if (!st || st.mtimeMs < sinceMs) continue;
          const id = (f.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/) || [])[1] || f.name;
          out.push({ agent: 'codex', file, id });
        }
      }
    }
  }
  return out;
}

function copilotFiles(onDirectory, sinceMs = -Infinity) {
  const out = [];
  for (const session of ls(COPILOT_DIR, onDirectory)) {
    if (!session.isDirectory()) continue;
    const events = path.join(COPILOT_DIR, session.name, 'events.jsonl');
    const st = statSafe(events, onDirectory);
    if (st && st.mtimeMs >= sinceMs) out.push({ agent: 'copilot', file: events, id: session.name });
  }
  return out;
}

function ompFiles(sinceMs, roots, onDirectory) {
  const out = [], seen = new Set();
  const add = (dir, profile, parentFile = null, depth = 0) => {
    if (depth > 20) return;
    const entries = ls(dir, onDirectory);
    // OMP keeps each agent's children in a directory named after its own log.
    // Dirents don't follow symlinks, so a linked directory is never walked.
    const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.includes('.bak')) continue;
      if (!parentFile && e.name.startsWith('__advisor')) continue;
      const file = path.join(dir, e.name), st = statSafe(file, onDirectory);
      if (!st) continue;
      const fresh = st.mtimeMs >= sinceMs;
      if (fresh && !seen.has(file)) {
        seen.add(file);
        out.push({ agent: 'omp', file, id: null, profile, parentFile });
      }
      const stem = e.name.slice(0, -6);
      if (!dirs.has(stem)) continue;
      const children = path.join(dir, stem);
      // A quiet parent whose child directory gained no entries in the window
      // has no new children, so old history isn't walked on every scan.
      if (!fresh && (statSafe(children, onDirectory)?.mtimeMs || 0) < sinceMs) continue;
      add(children, profile, file, depth + 1);
    }
  };
  for (const { dir, profile } of roots) {
    add(dir, profile); // --session-dir may point straight at a log directory
    for (const e of ls(dir, onDirectory)) {
      // A root-level log's sibling artifact directory is not a project directory.
      if (e.isDirectory() && !statSafe(path.join(dir, e.name + '.jsonl'), onDirectory)) add(path.join(dir, e.name), profile);
    }
  }
  return out;
}

function sourceRoots(ompRoots) {
  return {
    claude: [CLAUDE_DIR],
    codex: [CODEX_DIR],
    gemini: GEMINI_HOMES.map((root) => path.join(root, 'tmp')),
    copilot: [COPILOT_DIR],
    kimi: [CLIENT_DIRS.kimi],
    dsh: [CLIENT_DIRS.dsh],
    grok: [CLIENT_DIRS.grok],
    omp: ompRoots.map((root) => root.dir),
  };
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createSourceScan(roots) {
  const agents = new Map(LOCAL_AGENTS.map((agent) => [agent, {
    roots: new Set((roots[agent] || []).map(pathKey)),
    availableRoots: new Set(),
    errorReason: null,
    candidateCount: 0,
  }]));
  const observe = (agent, directory, error) => {
    const source = agents.get(agent);
    if (!source) return;
    const key = pathKey(directory);
    if (!error) {
      if (source.roots.has(key)) source.availableRoots.add(key);
      return;
    }
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return;
    source.errorReason ||= errorReason(error);
  };
  const forAgent = (agent) => (directory, error) => observe(agent, directory, error);
  const forClientPath = (directory, error) => {
    const key = pathKey(directory);
    for (const [agent, source] of agents) {
      if (Array.from(source.roots).some((root) => key === root || key.startsWith(root + path.sep))) {
        observe(agent, directory, error);
        return;
      }
    }
  };
  return { agents, observe, forAgent, forClientPath };
}

// OMP may record a parent through a symlink (macOS /var, a linked ~/.omp) or,
// on Windows, with different case; compare real paths. Cached per session.
function sameOMPPath(s, a, b) {
  const key = `${a}\0${b}`;
  if (s._ompPathKey === key) return s._ompPathSame;
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  s._ompPathKey = key;
  s._ompPathSame = path.resolve(a) === path.resolve(b) || real(a) === real(b);
  return s._ompPathSame;
}

class Watcher extends EventEmitter {
  constructor({ hours = 24, interval = 1000, ompDir, magpieSources = process.env.WMAD_MAGPIE_SOURCES,
    magpieUrl = process.env.WMAD_MAGPIE_URL, magpieKey = process.env.WMAD_MAGPIE_KEY } = {}) {
    super();
    this.windowMs = hours * 3600 * 1000;
    this.interval = interval;
    this.trackers = new Map(); // file -> { session, offset, partial, apply }
    this.failed = new Map();   // file -> retry-after time, for logs we couldn't read
    this.dshWarned = false;
    this.codexNames = new Map();
    this.geminiProjects = new Map(); // tmp dir name -> project path
    this.geminiRegistryMtime = 0;
    this.codexIndexMtime = 0;
    this.lastScan = 0;
    this.candidates = [];
    this.sourceScan = createSourceScan(sourceRoots([]));
    this.sourceLastSuccessAt = new Map(LOCAL_AGENTS.map((agent) => [agent, null]));
    this.sourceFileErrors = new Map(); // current candidate file -> fixed safe diagnostic
    if (typeof magpieSources === 'string') {
      try { magpieSources = JSON.parse(magpieSources); } catch { throw new Error('WMAD_MAGPIE_SOURCES must be a JSON array of {url, key} objects'); }
    }
    const sources = magpieSources ?? (magpieUrl ? [{ url: magpieUrl, key: magpieKey }] : []);
    if (!Array.isArray(sources) || sources.some((s) => !s || typeof s.url !== 'string' || typeof s.key !== 'string')) {
      throw new Error('WMAD_MAGPIE_SOURCES must be an array of {url, key} objects');
    }
    this.magpies = sources.map(({ url, key }, i) => {
      const source = new Magpie({ url, key, hours });
      source.on('change', () => this.emit('change'));
      source.on('warning', (message) => console.error(`Magpie source ${i + 1}: ${message}; its session status is unknown. Retrying.`));
      return source;
    });
    this.ompDir = ompDir;
    this.ompParentIds = new Map(); // parent log -> { mtime, size, id }
    this.waiting = new Map(); // Claude session ID -> { at, message } from the optional hook
  }

  recordSourceError(file, agent, state, reason) {
    if (!SOURCE_STATES.has(state) || !SOURCE_REASONS.has(reason)) return;
    this.sourceFileErrors.set(file, { agent, state, reason });
  }

  recordSourceRead(agent, file) {
    if (!this.sourceLastSuccessAt.has(agent)) return;
    this.sourceLastSuccessAt.set(agent, Date.now());
    const previous = this.sourceFileErrors.get(file);
    if (previous?.state === 'read_error') this.sourceFileErrors.delete(file);
  }

  finishSourceParse(agent, file, result, allowEmptyRecovery = false) {
    if (result.reason) {
      this.recordSourceError(file, agent, 'parse_error', result.reason);
      return;
    }
    if (!result.records && !allowEmptyRecovery) return;
    const previous = this.sourceFileErrors.get(file);
    if (previous?.state === 'parse_error') this.sourceFileErrors.delete(file);
  }

  sourceHealth(agent) {
    if (!LOCAL_AGENTS.includes(agent)) return null;
    const source = this.sourceScan.agents.get(agent);
    let readReason = source?.errorReason || null;
    let parseReason = null;
    for (const error of this.sourceFileErrors.values()) {
      if (error.agent !== agent) continue;
      if (error.state === 'read_error') readReason ||= error.reason;
      else if (error.state === 'parse_error') parseReason ||= error.reason;
    }
    let state, reason;
    if (readReason) { state = 'read_error'; reason = readReason; }
    else if (parseReason) { state = 'parse_error'; reason = parseReason; }
    else if (source?.candidateCount > 0) { state = 'ok'; reason = null; }
    else if (source?.availableRoots.size > 0) { state = 'empty'; reason = 'no_recent_logs'; }
    else { state = 'missing'; reason = 'not_found'; }
    return safeSourceHealth({ state, lastSuccessAt: this.sourceLastSuccessAt.get(agent), reason });
  }

  sources() {
    const out = LOCAL_AGENTS.map((agent) => ({ agent, ...this.sourceHealth(agent) }));
    if (this.magpies.length) out.push({ agent: 'magpie', state: 'unavailable', lastSuccessAt: null, reason: 'not_instrumented' });
    return out;
  }

  sourceHealthFor(session) {
    if (session?.source === 'magpie') return null;
    return this.sourceHealth(session?.agent);
  }

  start() {
    this.tick();
    for (const source of this.magpies) source.start();
    this.timer = setInterval(() => this.tick(), this.interval);
    return this;
  }

  stop() { clearInterval(this.timer); for (const source of this.magpies) source.stop(); }

  loadCodexIndex() {
    const st = statSafe(CODEX_INDEX);
    if (!st || st.mtimeMs === this.codexIndexMtime) return false;
    this.codexIndexMtime = st.mtimeMs;
    const start = Math.max(0, st.size - 2 * 1024 * 1024);
    for (const line of readRange(CODEX_INDEX, start, st.size).split('\n')) {
      try {
        const d = JSON.parse(line);
        if (d.id && d.thread_name) this.codexNames.set(d.id, d.thread_name);
      } catch {}
    }
    return true;
  }

  // ~/.gemini/projects.json maps project paths to the short slugs used as
  // tmp dir names; older versions used sha256(path) instead.
  loadGeminiProjects() {
    let mt = 0;
    const files = GEMINI_HOMES.map((r) => path.join(r, 'projects.json'));
    for (const f of files) mt += (statSafe(f) || {}).mtimeMs || 0;
    if (mt === this.geminiRegistryMtime) return false;
    this.geminiRegistryMtime = mt;
    for (const f of files) {
      try {
        const reg = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const [dir, slug] of Object.entries(reg.projects || {})) {
          this.geminiProjects.set(slug, dir);
          this.geminiProjects.set(crypto.createHash('sha256').update(dir).digest('hex'), dir);
        }
      } catch {}
    }
    return true;
  }

  tick() {
    const now = Date.now();
    const since = now - this.windowMs;
    const sourceSignature = JSON.stringify(this.sources());
    let changed = this.loadCodexIndex();
    if (this.loadWaiting(since)) changed = true;
    if (this.loadGeminiProjects()) changed = true;

    // Directory walk every 5s; stat known files every tick.
    if (now - this.lastScan > 5000) {
      this.lastScan = now;
      const ompErrors = [];
      const ompRoots = ompDirs(this.ompDir, process.env, home, process.platform,
        (directory, error) => ompErrors.push({ directory, error }));
      const scan = createSourceScan(sourceRoots(ompRoots));
      for (const item of ompErrors) scan.observe('omp', item.directory, item.error);
      this.candidates = [...claudeFiles(scan.forAgent('claude'), since), ...codexFiles(since, scan.forAgent('codex')),
        ...geminiFiles(scan.forAgent('gemini'), since), ...copilotFiles(scan.forAgent('copilot'), since),
        ...clientFiles(CLIENT_DIRS, since, scan.forClientPath),
        ...ompFiles(since, ompRoots, scan.forAgent('omp'))];
      for (const candidate of this.candidates) {
        const source = scan.agents.get(candidate.agent);
        if (source) source.candidateCount += 1;
      }
      this.sourceScan = scan;
      const currentFiles = new Set(this.candidates.map((candidate) => candidate.file));
      for (const file of this.sourceFileErrors.keys()) if (!currentFiles.has(file)) this.sourceFileErrors.delete(file);
      for (const file of this.failed.keys()) if (!currentFiles.has(file)) this.failed.delete(file);
    }

    for (const c of this.candidates) {
      // A log we can't read (permissions, deleted mid-read…) is skipped and
      // retried a minute later; it must never take the server down.
      if ((this.failed.get(c.file) || 0) > now) continue;
      try {
        if (this.track(c, since)) changed = true;
        this.failed.delete(c.file);
      } catch (e) {
        if (c.agent === 'dsh') {
          // A zstd frame may be half-written. Keep the last readable snapshot.
          // A log over the replay limit stays too big, so don't decode it again soon.
          this.failed.set(c.file, now + (e?.tooLarge ? 60000 : DSH_REPLAY_MS));
          if (!this.dshWarned) {
            console.error('DSH: log decoding failed; keeping the last readable state and retrying. See the zstd requirements and size limit in README.');
            this.dshWarned = true;
          }
        } else {
          this.failed.set(c.file, now + 60000);
        }
        if (e?.partialLog) {
          // A growing log may not have a complete session header yet.
        } else if (e?.parseFailed || e?.tooLarge || e?.decodeFailed) {
          this.recordSourceError(c.file, c.agent, 'parse_error', e?.diagnosticReason
            || (e?.tooLarge || e?.decodeFailed ? 'decode_failed' : 'parser_failed'));
        } else {
          this.recordSourceError(c.file, c.agent, 'read_error', errorReason(e));
        }
      }
    }

    for (const [file, t] of this.trackers) {
      const activity = t.session.agent === 'omp' ? Math.max(t.session.lastEventAt || 0, t.session.mtime || 0) : (t.session.lastEventAt || t.session.mtime || 0);
      if (activity < since) { this.trackers.delete(file); changed = true; }
    }

    if (JSON.stringify(this.sources()) !== sourceSignature) changed = true;
    if (changed) this.emit('change');
  }

  // Returns true when this file's session changed.
  track(c, since) {
    const st = statSafe(c.file, (file, error) => {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) {
        this.recordSourceError(file, c.agent, 'read_error', errorReason(error));
      }
    });
    const t = this.trackers.get(c.file);
    if (!st) return c.agent === 'omp' && this.trackers.delete(c.file);
    if (!t) {
      if (st.mtimeMs < since) return false;
      this.open(c, st);
      return true;
    }
    const sourceError = this.sourceFileErrors.get(c.file);
    if (sourceError?.state === 'read_error'
      || (sourceError?.state === 'parse_error' && this.failed.has(c.file))) {
      this.open(c, st);
      return true;
    }
    if (c.agent === 'omp') {
      // The title slot is rewritten in place, sometimes without changing the size.
      const modified = st.mtimeMs !== t.mtime || st.ctimeMs !== t.ctime || st.ino !== t.ino;
      if (st.size < t.offset || (modified && st.size === t.offset) || st.ino !== t.ino) {
        this.open(c, st);
        return true;
      }
      if (st.size > t.offset) {
        const parseResult = { records: 0, reason: null };
        this.feedOMP(t, c.file, t.offset, st.size, false, parseResult,
          () => this.recordSourceRead(c.agent, c.file));
        this.finishSourceParse(c.agent, c.file, parseResult);
        this.ompTitle(t, c.file, st.size);
        t.offset = st.size;
        t.mtime = t.session.mtime = st.mtimeMs;
        t.ctime = st.ctimeMs;
        return true;
      }
      return false;
    }
    let changed = false;
    const modified = st.mtimeMs !== t.mtime || st.ctimeMs !== t.ctime || st.ino !== t.ino || st.size !== t.offset;
    if (t.whole && modified) {
      // Whole documents and compressed streams are replaced only after reading.
      if (c.agent === 'dsh' && Date.now() - t.readAt < DSH_REPLAY_MS) return false;
      if (matchesStatSignature(t.failedRead, st)) return false;
      this.open(c, st);
      return true;
    } else if (!t.whole && sourceError?.state === 'parse_error' && st.size === t.offset
      && (st.mtimeMs !== t.mtime || st.ctimeMs !== t.ctime || st.ino !== t.ino)) {
      // Re-read a same-size rewrite only while recovering a known parse error.
      this.open(c, st);
      return true;
    } else if (st.size > t.offset) {
      const chunk = readRange(c.file, t.offset, st.size, t.decoder);
      this.recordSourceRead(c.agent, c.file);
      const parseResult = { records: 0, reason: null };
      this.feed(t, chunk, false, false, parseResult);
      this.finishSourceParse(c.agent, c.file, parseResult);
      t.offset = st.size;
      changed = true;
    } else if (st.size < t.offset) {
      // Read the replacement before dropping the last readable session.
      this.open(c, st);
      return true;
    }
    if (c.metadata) {
      const meta = statSafe(c.metadata);
      if (meta && (meta.mtimeMs !== t.metaMtime || meta.size !== t.metaSize)) {
        metadata(t.session, c.agent, c.metadata);
        t.metaMtime = meta.mtimeMs; t.metaSize = meta.size;
        changed = true;
      }
    }
    t.session.mtime = st.mtimeMs;
    t.mtime = st.mtimeMs; t.ctime = st.ctimeMs; t.ino = st.ino;
    return changed;
  }

  open(c, st) {
    const previous = this.trackers.get(c.file);
    const session = newSession(c.agent, c.id, c.file);
    if (c.sessionId) session.sessionId = c.sessionId;
    if (c.parentId) { session.parentId = c.parentId; session.subagent = true; }
    session.mtime = st.mtimeMs;
    if (c.agent === 'gemini') session.geminiProject = c.project;
    const apply = { claude: applyClaude, codex: applyCodex, gemini: applyGemini, copilot: applyCopilot, kimi: applyKimi, dsh: applyDsh, grok: applyGrok, omp: applyOMP }[c.agent];
    const t = { session, offset: st.size, partial: '', apply, mtime: st.mtimeMs,
      ctime: st.ctimeMs, ino: st.ino, agent: c.agent, file: c.file };
    if (c.agent === 'dsh') {
      t.whole = true;
      t.readAt = Date.now();
      const content = readDsh(c.file);
      this.recordSourceRead(c.agent, c.file);
      const parseResult = { records: 0, reason: null };
      this.feed(t, content, false, false, parseResult);
      this.finishSourceParse(c.agent, c.file, parseResult, true);
      if (!session._dshHeader) {
        const error = new Error('DSH header is not readable yet');
        error.partialLog = !parseResult.reason && parseResult.records === 0 && t.partial.length > 0;
        error.parseFailed = !error.partialLog;
        error.diagnosticReason = parseResult.reason || (error.partialLog ? null : 'parser_failed');
        throw error;
      }
      for (const [file, old] of this.trackers) {
        if (old.session.agent === 'dsh' && old.session.id === session.id) this.trackers.delete(file);
      }
      this.trackers.set(c.file, t);
      return t;
    }
    if (c.agent === 'omp') {
      session.ompProfile = c.profile;
      if (c.parentFile) {
        session.subagent = true;
        session.ompParentFile = c.parentFile;
        session.ompAgentName = path.basename(c.file, '.jsonl');
      }
      t.decoder = new StringDecoder('utf8');
      t.ctime = st.ctimeMs;
      t.ino = st.ino;
      const parseResult = { records: 0, reason: null };
      const onRead = () => this.recordSourceRead(c.agent, c.file);
      // A full chunked replay keeps metadata and every open toolCall; past
      // OMP_FULL_BYTES only calls still open in the tail are seen.
      if (st.size <= OMP_FULL_BYTES) this.feedOMP(t, c.file, 0, st.size, false, parseResult, onRead);
      else {
        const head = readRange(c.file, 0, HEAD_BYTES);
        onRead();
        this.feed(t, head, true, false, parseResult);
        t.partial = '';
        this.feedOMP(t, c.file, st.size - TAIL_BYTES, st.size, true, parseResult, onRead);
      }
      onRead();
      this.finishSourceParse(c.agent, c.file, parseResult, true);
      this.ompTitle(t, c.file, st.size);
      this.trackers.set(c.file, t);
      return t;
    }
    if (c.agent === 'gemini' && c.file.endsWith('.json')) {
      t.whole = true;
      const content = readRange(c.file, 0, st.size);
      this.recordSourceRead(c.agent, c.file);
      let document;
      try { document = JSON.parse(content); }
      catch {
        this.recordSourceError(c.file, c.agent, 'parse_error', 'invalid_json');
        if (previous) {
          previous.failedRead = statSignature(st);
          return previous;
        }
        this.trackers.set(c.file, t);
        return t;
      }
      let parseReason = null;
      try { applyGeminiDocument(session, document); }
      catch { parseReason = 'parser_failed'; }
      if (parseReason && previous) {
        this.recordSourceError(c.file, c.agent, 'parse_error', parseReason);
        previous.failedRead = statSignature(st);
        return previous;
      }
      this.finishSourceParse(c.agent, c.file, { records: 1, reason: parseReason }, true);
      this.trackers.set(c.file, t);
      return t;
    }
    // Keep a decoder for later Kimi/Grok appends that split a UTF-8 character.
    if (c.agent === 'kimi' || c.agent === 'grok') t.decoder = new StringDecoder('utf8');
    const parseResult = { records: 0, reason: null };
    if (t.decoder && st.size <= OMP_FULL_BYTES) {
      // Pending tools and approvals need every event, including the middle.
      for (let start = 0; start < st.size; start += TAIL_BYTES) {
        const chunk = readRange(c.file, start, Math.min(start + TAIL_BYTES, st.size), t.decoder);
        this.recordSourceRead(c.agent, c.file);
        this.feed(t, chunk, false, false, parseResult);
      }
    } else if (st.size <= HEAD_BYTES + TAIL_BYTES) {
      const chunk = readRange(c.file, 0, st.size);
      this.recordSourceRead(c.agent, c.file);
      this.feed(t, chunk, false, false, parseResult);
    } else {
      // Big log: head for metadata (cwd, title, model), tail for current state.
      const head = readRange(c.file, 0, HEAD_BYTES);
      this.recordSourceRead(c.agent, c.file);
      this.feed(t, head, true, false, parseResult);
      t.partial = '';
      const tail = readRange(c.file, st.size - TAIL_BYTES, st.size, t.decoder);
      this.recordSourceRead(c.agent, c.file);
      this.feed(t, tail, false, true, parseResult);
    }
    if (!st.size) this.recordSourceRead(c.agent, c.file);
    this.finishSourceParse(c.agent, c.file, parseResult, true);
    if (c.metadata) {
      metadata(session, c.agent, c.metadata);
      const meta = statSafe(c.metadata);
      t.metaMtime = meta?.mtimeMs; t.metaSize = meta?.size;
    }
    this.trackers.set(c.file, t);
    return t;
  }

  feedOMP(t, file, start, end, skipFirstLine = false, parseResult = { records: 0, reason: null }, onRead = null) {
    const fd = fs.openSync(file, 'r');
    let read = false;
    try {
      const buf = Buffer.alloc(128 * 1024);
      while (start < end) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - start), start);
        if (!n) break;
        if (!read) { onRead?.(); read = true; }
        let text = t.decoder.write(buf.subarray(0, n));
        if (skipFirstLine) {
          // a tail read starts mid-line: drop everything up to the first newline
          const nl = text.indexOf('\n');
          text = nl < 0 ? '' : text.slice(nl + 1);
          if (nl >= 0) skipFirstLine = false;
        }
        this.feed(t, text, false, false, parseResult);
        start += n;
      }
    } finally { fs.closeSync(fd); }
    if (!read) onRead?.();
  }

  ompTitle(t, file, size) {
    const first = readRange(file, 0, Math.min(size, 4096)).split('\n')[0];
    try {
      const slot = JSON.parse(first);
      if (slot.type === 'title') applyOMP(t.session, slot);
    } catch {}
  }

  feed(t, chunk, dropLastPartial, dropFirst = false, parseResult = { records: 0, reason: null }) {
    const lines = (t.partial + chunk).split('\n');
    t.partial = lines.pop();
    if (dropFirst) lines.shift();
    if (dropLastPartial) t.partial = '';
    for (const line of lines) {
      if (!line) continue;
      let d;
      try { d = JSON.parse(line); }
      catch { parseResult.reason ||= 'invalid_json'; continue; }
      parseResult.records += 1;
      try { t.apply(t.session, d); }
      catch { parseResult.reason ||= 'parser_failed'; }
    }
    return parseResult;
  }

  // The parent's session ID, from its tracker or (when it is outside the
  // window) from its header, cached until the parent log changes.
  ompParentId(file) {
    const tracked = this.trackers.get(file)?.session?.sessionId;
    if (tracked) return tracked;
    const st = statSafe(file);
    if (!st) return null;
    const cached = this.ompParentIds.get(file);
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.id;
    let id = null;
    try {
      for (const line of readRange(file, 0, Math.min(st.size, HEAD_BYTES)).split('\n')) {
        try { const d = JSON.parse(line); if (d.type === 'session' && typeof d.id === 'string' && d.id) { id = d.id; break; } } catch {}
      }
    } catch {}
    this.ompParentIds.set(file, { mtime: st.mtimeMs, size: st.size, id });
    return id;
  }

  // Markers written by `cli.js --hook`; returns true when they changed.
  loadWaiting(since) {
    const next = hook.markers(since);
    const key = (m) => [...m].map(([id, w]) => `${id}:${w.at}`).sort().join();
    const changed = key(next) !== key(this.waiting);
    this.waiting = next;
    return changed;
  }

  // Recent messages of one tracked session, looked up by its key — never by a path from the client.
  transcript(key) {
    for (const t of this.trackers.values()) {
      if (`${t.session.agent}:${t.session.id}` === key) return transcript(t.session, t.apply);
    }
    return null;
  }

  sessions() {
    const out = [];
    for (const t of this.trackers.values()) {
      const s = t.session;
      if (s.agent === 'omp') {
        // Skip stray JSONL files and logs whose header isn't written yet.
        if (!s.sessionId || !s.cwd) continue;
        if (s.subagent && s.ompParentFile) {
          // parentSession alone also describes ordinary branched conversations;
          // require the artifact directory it was found in to match its parent.
          const advisor = /^__advisor(?:[._-].*)?$/.test(s.ompAgentName);
          if (s.parentSession && !sameOMPPath(s, s.parentSession, s.ompParentFile)) continue;
          if (!s.parentSession && !advisor) continue;
          s.parentId = this.ompParentId(s.ompParentFile);
          if (!s.title) s.title = advisor ? 'Advisor' : s.ompAgentName.replace(/\./g, ' > ');
        }
        s.lastEventAt = Math.max(s.lastEventAt || 0, s.mtime || 0);
      }
      if (s.agent === 'gemini' && !s.cwd && this.geminiProjects.has(s.geminiProject)) {
        s.cwd = this.geminiProjects.get(s.geminiProject);
      }
      if (s.agent === 'gemini' && !s.cwd) s.cwd = s.geminiProject;
      // Gemini re-appends whole messages with their original timestamps, so
      // the file's own write time is the best "last activity" signal.
      if (s.agent === 'gemini') s.lastEventAt = Math.max(s.lastEventAt || 0, s.mtime || 0);
      if (s.agent === 'codex' && !s.title) {
        const name = this.codexNames.get(s.id);
        if (name) s.title = name;
      }
      // A permission prompt from the optional Claude Code hook, until the log moves on.
      const wait = s.agent === 'claude' && !s.subagent && this.waiting.get(s.id);
      if (wait && wait.at > (s.lastEventAt || 0)) {
        out.push({ ...s, status: 'waiting', activity: wait.message || null, lastEventAt: wait.at,
          statusEvidence: { kind: 'permission_hook', at: Number.isFinite(wait.at) ? wait.at : null } });
        continue;
      }
      out.push(s);
    }
    if (!this.magpies.length) return out;
    const remote = new Map();
    // Magpie's native records carry richer metadata than gateway projections.
    // Prefer those, then the newest record; any healthy in-flight call counts.
    const records = this.magpies.flatMap((m) => m.sessions())
      .sort((a, b) => Number(a.gateway) - Number(b.gateway) || b.lastEventAt - a.lastEventAt);
    for (const s of records) {
      const key = `${s.agent}:${s.id}`;
      const other = remote.get(key);
      if (!other) { remote.set(key, { ...s }); continue; }
      for (const field of ['title', 'cwd', 'model', 'agentName', 'parentId', 'startedAt']) {
        if (!other[field]) other[field] = s[field];
      }
      other.subagent ||= s.subagent;
      if (s.status === 'thinking') other.status = 'thinking';
      other.lastEventAt = Math.max(other.lastEventAt, s.lastEventAt);
    }
    const merged = out.map((s) => {
      // Gemini's file name can differ from its ID. Kimi children instead carry
      // the parent sessionId for resume, which must not consume the parent's row.
      const alias = s.agent === 'gemini' && s.sessionId;
      const other = remote.get(`${s.agent}:${s.id}`) || (alias && remote.get(`${s.agent}:${alias}`));
      remote.delete(`${s.agent}:${s.id}`);
      if (alias) remote.delete(`${s.agent}:${alias}`);
      // Do not write fallback metadata into the native tracker: its own title
      // may arrive later, or the gateway may disappear.
      return other ? { ...s, title: s.title || other.title, cwd: s.cwd || other.cwd, model: s.model || other.model,
        parentId: s.parentId || other.parentId, subagent: s.subagent || other.subagent } : s;
    });
    return merged.concat([...remote.values()]);
  }
}

module.exports = { Watcher, CLAUDE_DIR, CODEX_DIR, GEMINI_DIR, CLIENT_DIRS, ompDirs };
