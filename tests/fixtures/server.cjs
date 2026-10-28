const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { PassThrough } = require('node:stream');
assert.ok(process.argv[3], 'Run through tests/server.cjs with an isolated home');
assert.equal(process.env.HOME, process.argv[3]);
const { createServer } = require('../../src/server');
const { USER_DIR } = require('../../src/scenes');

const scene = path.join(USER_DIR, 'fixture');
fs.mkdirSync(scene, { recursive: true });
fs.writeFileSync(path.join(scene, 'manifest.json'), '{"name":"Fixture"}');
fs.writeFileSync(path.join(scene, 'hello world.json'), '{"fixture":true}\n');
fs.writeFileSync(path.join(scene, 'literal%name.json'), '{"percent":true}\n');
fs.writeFileSync(path.join(scene, 'blocked.txt'), 'not an allowed HTTP MIME type');
fs.writeFileSync(path.join(USER_DIR, 'outside.json'), '{"outside":true}');

const watcher = new EventEmitter();
watcher.sessions = () => [];
const server = createServer(watcher, {});

function request(url, host = 'localhost') {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port: server.address().port, path: url,
      headers: { host: `${host}:${server.address().port}` },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error(`Request timed out: ${url}`)));
  });
}

function requestUntilClose(url, onFirstData) {
  return new Promise((resolve, reject) => {
    let response;
    let settled = false;
    const chunks = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ status: response ? response.statusCode : null, complete: response ? response.complete : false, body: Buffer.concat(chunks) });
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = http.get({
      host: '127.0.0.1', port: server.address().port, path: url,
      headers: { host: `localhost:${server.address().port}` },
    }, res => {
      response = res;
      let firstData = true;
      res.on('data', chunk => {
        chunks.push(chunk);
        if (firstData) {
          firstData = false;
          if (onFirstData) onFirstData(chunk, req);
        }
      });
      res.on('error', error => {
        if (res.aborted || error.code === 'ECONNRESET') return finish();
        fail(error);
      });
      res.on('close', finish);
      res.on('end', finish);
    });
    req.on('error', error => {
      if (error.code === 'ECONNRESET') return finish();
      fail(error);
    });
    req.setTimeout(2000, () => {
      fail(new Error(`Request timed out: ${url}`));
      req.destroy();
    });
  });
}

async function withReadStream(file, prepare, action) {
  const createReadStream = fs.createReadStream;
  let resolveStream;
  const streamReady = new Promise(resolve => { resolveStream = resolve; });
  fs.createReadStream = function (target, ...args) {
    if (path.resolve(target) !== path.resolve(file)) return createReadStream.call(this, target, ...args);
    const stream = new PassThrough();
    resolveStream(stream);
    prepare(stream);
    return stream;
  };
  try {
    return await action(streamReady);
  } finally {
    fs.createReadStream = createReadStream;
  }
}

function readError(code) {
  const error = new Error('simulated file read failure');
  error.code = code;
  return error;
}

async function ping(host) {
  const res = await request('/api/ping', host);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { app: 'whatsmyagentdoing' });
}

async function resource(url, file, type, cache = 'no-cache') {
  const res = await request(url);
  assert.equal(res.status, 200, url);
  assert.equal(res.headers['content-type'], type);
  assert.equal(res.headers['cache-control'], cache);
  assert.deepEqual(res.body, fs.readFileSync(file), url);
}

async function main() {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const scenario = process.argv[2];
    if (scenario === 'assets' || scenario === 'scenes') {
      const prefixes = scenario === 'assets' ? ['/assets/'] : ['/scenes/', '/scenes/fixture/'];
      for (const prefix of prefixes) {
        for (const suffix of ['%', '%2', '%GG', '%E0%A4', '%FF']) {
          const url = prefix + suffix;
          assert.equal((await request(url)).status, 400, url);
          await ping();
          if (scenario === 'assets') {
            await resource('/assets/agents%2F%63laude.png', path.join(__dirname, '../../assets/agents/claude.png'), 'image/png');
          } else {
            await resource('/scenes/fixture/hello%20world.json', path.join(scene, 'hello world.json'), 'application/json');
          }
        }
      }
    } else if (scenario === 'guards') {
      assert.equal((await request('//[', 'untrusted.example')).status, 403, 'Host guard runs before URL parsing');
      assert.equal((await request('//[')).status, 400, 'malformed request URL is rejected');
      await ping();
      for (const url of ['/assets/%', '/scenes/%']) {
        assert.equal((await request(url, 'untrusted.example')).status, 403, url);
      }
      for (const host of ['localhost', '127.0.0.1', '[::1]']) await ping(host);
      for (const url of [
        '/assets/%2e%2e%2fpackage.json', '/scenes/fixture/%2e%2e%2foutside.json',
        '/scenes/%2e%2e%2ffixture/manifest.json', '/assets/agents/README.md',
        '/scenes/fixture/blocked.txt', '/assets/missing.png', '/scenes/missing/manifest.json',
      ]) assert.equal((await request(url)).status, 404, url);
      await resource('/scenes/fixture/literal%25name.json', path.join(scene, 'literal%name.json'), 'application/json');
      await resource('/office.js', path.join(__dirname, '../../public/office.js'), 'text/javascript; charset=utf-8', 'no-store');
      await ping();
    }

    if (scenario === 'streams') {
      const staticFile = path.join(__dirname, '../../public/office.js');
      const assetFile = path.join(__dirname, '../../assets/agents/claude.png');
      const sceneFile = path.join(scene, 'hello world.json');
      const cases = [
        { url: '/office.js', file: staticFile, code: 'ENOENT', status: 404 },
        { url: '/assets/agents/claude.png', file: assetFile, code: 'ENOTDIR', status: 404 },
        { url: '/scenes/fixture/hello%20world.json', file: sceneFile, code: 'ENOTDIR', status: 404 },
        { url: '/office.js', file: staticFile, code: 'EACCES', status: 500 },
        { url: '/assets/agents/claude.png', file: assetFile, code: 'EIO', status: 500 },
        { url: '/scenes/fixture/hello%20world.json', file: sceneFile, code: 'EACCES', status: 500 },
      ];
      for (const { url, file, code, status } of cases) {
        const result = await withReadStream(file, stream => {
          process.nextTick(() => stream.emit('error', readError(code)));
        }, () => request(url));
        assert.equal(result.status, status, `${url} ${code}`);
        assert.equal(result.body.length, 0, `${url} ${code} response body is empty`);
        assert.ok(!result.body.toString().includes(file), `${url} ${code} response does not expose the file path`);
        await ping();
      }

      const brokenDirectory = path.join(scene, 'broken.json');
      fs.mkdirSync(brokenDirectory);
      const directoryRead = await requestUntilClose('/scenes/fixture/broken.json');
      assert.equal(directoryRead.status, 500, 'an open directory that fails on read returns 500');
      assert.equal(directoryRead.complete, true, 'the directory read failure completes an error response');
      assert.equal(directoryRead.body.length, 0, 'the directory read failure has an empty body');
      await ping();

      for (const { url, file } of [
        { url: '/office.js', file: staticFile },
        { url: '/assets/agents/claude.png', file: assetFile },
        { url: '/scenes/fixture/hello%20world.json', file: sceneFile },
      ]) {
        const result = await withReadStream(file, stream => {
          process.nextTick(() => {
            stream.emit('open');
            stream.write('partial');
          });
        }, async streamReady => {
          let source;
          const response = requestUntilClose(url, () => source.emit('error', readError('EIO')));
          const stream = await streamReady;
          source = stream;
          return response;
        });
        assert.equal(result.status, 200, `${url} headers were sent before the read failed`);
        assert.equal(result.complete, false, `${url} response was destroyed after a partial read`);
        assert.equal(result.body.toString(), 'partial', `${url} retains only the bytes read before failure`);
        await ping();
      }

      let sourceClosed;
      const sourceClosedPromise = new Promise(resolve => { sourceClosed = resolve; });
      const aborted = await withReadStream(staticFile, stream => {
        stream.once('close', sourceClosed);
        process.nextTick(() => {
          stream.emit('open');
          stream.write('partial');
        });
      }, async streamReady => {
        const [response, source] = await Promise.all([
          requestUntilClose('/office.js', (_chunk, req) => req.destroy()),
          streamReady,
        ]);
        if (!source.closed) await sourceClosedPromise;
        return response;
      });
      assert.equal(aborted.status, 200);
      assert.equal(aborted.complete, false, 'client abort leaves the response incomplete');
      assert.equal(aborted.body.toString(), 'partial', 'client receives the first chunk before aborting');
      await ping();
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
