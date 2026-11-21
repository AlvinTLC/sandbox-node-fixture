'use strict';

// Contract tests for the fixture app.
//
// These run on any machine with Node and no network: they start the real server
// on an ephemeral port and talk to it over HTTP. What they protect is the set of
// properties the end-to-end test depends on, so a regression here shows up as a
// clear failure instead of a mysterious sandbox timeout.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { createServer, stripSandboxPrefix } = require('../server.js');

const FIXTURE_ROOT = path.join(__dirname, '..');
const MIGRATE_PATH = path.join(FIXTURE_ROOT, 'scripts', 'migrate.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function withServer(fn) {
  const server = createServer();
  const port = await listen(server);
  try {
    return await fn(port);
  } finally {
    await close(server);
  }
}

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: options.method || 'GET', headers: options.headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

// Raw upgrade over a plain socket. Node's http client keeps the socket in a
// state that makes the upgrade event awkward to await, and what the reverse
// proxy actually forwards is bytes on the wire, so the test speaks bytes.
function upgradeRequest(requestPath, key) {
  return (
    `GET ${requestPath} HTTP/1.1\r\n` +
    'Host: 127.0.0.1\r\n' +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Version: 13\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    '\r\n'
  );
}

function rawUpgrade(port, requestPath, key) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(upgradeRequest(requestPath, key)));
    let buffer = Buffer.alloc(0);

    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        return;
      }
      const head = buffer.subarray(0, end).toString('utf8').split('\r\n');
      const status = Number.parseInt(head[0].split(' ')[1], 10);
      const headers = {};
      for (const line of head.slice(1)) {
        const separator = line.indexOf(':');
        if (separator === -1) {
          continue;
        }
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
      }
      finish({ status, headers });
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`upgrade to ${requestPath} timed out`));
    });
  });
}

test('serves the index page with a 200', async () => {
  await withServer(async (port) => {
    const res = await request(port, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /Sandbox is live/);
  });
});

test('renders the build marker from build.json', async () => {
  const build = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'build.json'), 'utf8'));
  await withServer(async (port) => {
    const res = await request(port, '/');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(build.marker), `index should contain marker ${build.marker}`);
  });
});

test('exposes the build marker as JSON for assertions', async () => {
  const build = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'build.json'), 'utf8'));
  await withServer(async (port) => {
    const res = await request(port, '/build.json');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).marker, build.marker);
  });
});

test('references assets with relative paths so they survive the /s/{id}/ prefix', async () => {
  await withServer(async (port) => {
    const res = await request(port, '/');
    assert.equal(res.status, 200);
    // An absolute href="/styles.css" would resolve against the service host and
    // 404 once the app is mounted under /s/{id}/.
    assert.match(res.body, /href="styles\.css"/);
    assert.match(res.body, /src="app\.js"/);
    assert.doesNotMatch(res.body, /href="\/styles\.css"/);
    assert.doesNotMatch(res.body, /src="\/app\.js"/);
  });
});

test('serves static assets', async () => {
  await withServer(async (port) => {
    const css = await request(port, '/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);

    const js = await request(port, '/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
  });
});

test('answers the health probe', async () => {
  await withServer(async (port) => {
    const res = await request(port, '/healthz');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, 'ok');
  });
});

test('redirects /s/{id} to /s/{id}/ so relative assets resolve', async () => {
  await withServer(async (port) => {
    const res = await request(port, '/s/abc123');
    assert.equal(res.status, 308);
    assert.equal(res.headers.location, '/s/abc123/');
  });
});

test('serves the app under the /s/{id}/ prefix', async () => {
  await withServer(async (port) => {
    const page = await request(port, '/s/abc123/');
    assert.equal(page.status, 200);
    assert.match(page.body, /Sandbox is live/);

    const css = await request(port, '/s/abc123/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
  });
});

test('strips the sandbox prefix from the path it reports', async () => {
  await withServer(async (port) => {
    const res = await request(port, '/s/abc123/api/echo?x=1');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.query.x, '1');
    // The app sees the original path; the route it matched is the stripped one.
    assert.equal(body.path, '/s/abc123/api/echo');
  });
});

test('stripSandboxPrefix handles the shapes the proxy can forward', () => {
  assert.equal(stripSandboxPrefix('/s/abc/'), '/');
  assert.equal(stripSandboxPrefix('/s/abc/styles.css'), '/styles.css');
  assert.equal(stripSandboxPrefix('/s/abc'), '/');
  assert.equal(stripSandboxPrefix('/styles.css'), '/styles.css');
  assert.equal(stripSandboxPrefix('/'), '/');
});

test('does not serve files outside public/', async () => {
  await withServer(async (port) => {
    const res = await request(port, '/../server.js');
    assert.notEqual(res.status, 200);
  });
});

test('returns 404 for unknown paths', async () => {
  await withServer(async (port) => {
    const res = await request(port, '/nope');
    assert.equal(res.status, 404);
  });
});

test('completes the WebSocket handshake on /ws', async () => {
  await withServer(async (port) => {
    const key = crypto.randomBytes(16).toString('base64');
    const result = await rawUpgrade(port, '/ws', key);

    assert.equal(result.status, 101);
    const expected = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    assert.equal(result.headers['sec-websocket-accept'], expected);
  });
});

test('echoes a WebSocket text frame', async () => {
  await withServer(async (port) => {
    const key = crypto.randomBytes(16).toString('base64');
    const echoed = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(upgradeRequest('/ws', key));
      });
      let buffer = Buffer.alloc(0);
      let upgraded = false;

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end === -1) {
            return;
          }
          upgraded = true;
          buffer = buffer.subarray(end + 4);
          // Client frames must be masked; "ping" with a fixed mask.
          const payload = Buffer.from('ping');
          const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
          const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
          socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
        }
        if (buffer.length >= 2) {
          // Server frames are unmasked: byte 0 is FIN|opcode, byte 1 is length.
          const length = buffer[1] & 0x7f;
          if (buffer.length < 2 + length) {
            return;
          }
          const text = buffer.subarray(2, 2 + length).toString('utf8');
          socket.destroy();
          resolve(text);
        }
      });
      socket.on('error', reject);
    });

    assert.equal(echoed, 'ping');
  });
});

test('rejects an upgrade on a path that is not /ws', async () => {
  await withServer(async (port) => {
    const result = await rawUpgrade(port, '/not-ws', crypto.randomBytes(16).toString('base64'));
    assert.notEqual(result.status, 101);
  });
});

test('migrate fails with an actionable message when psql is missing', async () => {
  // The provisioner runs `npm run migrate` inside the baked image. If the image
  // does not ship the postgresql client, the failure must point at the runbook
  // instead of leaving a bare ENOENT that looks like a sandbox bug. PATH is
  // pointed at an empty directory so `psql` is genuinely not found.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blazesandbox-migrate-'));
  try {
    const emptyBin = path.join(tmp, 'bin');
    fs.mkdirSync(emptyBin);
    const run = spawnSync(process.execPath, [MIGRATE_PATH], {
      env: { ...process.env, DATABASE_URL: 'postgres://127.0.0.1:1/db', PATH: emptyBin },
      encoding: 'utf8',
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /cannot run psql/);
    assert.match(run.stderr, /runbook-incus\.md/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('serves an edited build marker without a restart', async () => {
  // This is the property the re-deploy test relies on: the marker is read per
  // request, so a new deploy is observable on the same URL. The copy keeps the
  // committed fixture untouched.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blazesandbox-fixture-'));
  try {
    fs.cpSync(FIXTURE_ROOT, tmp, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules`),
    });

    // The server resolves its files relative to its own directory, so the copy
    // is exercised by pointing a fresh module instance at it.
    const copiedServerPath = path.join(tmp, 'server.js');
    const copied = require(copiedServerPath);
    const copiedServer = copied.createServer();
    const port = await listen(copiedServer);

    try {
      const before = JSON.parse((await request(port, '/build.json')).body);
      assert.equal(before.marker, 'fixture-build-1');

      fs.writeFileSync(
        path.join(tmp, 'build.json'),
        JSON.stringify({ marker: 'fixture-build-2', built_at: '2024-01-02T00:00:00Z' }, null, 2),
      );

      const after = JSON.parse((await request(port, '/build.json')).body);
      assert.equal(after.marker, 'fixture-build-2');

      const page = await request(port, '/');
      assert.ok(page.body.includes('fixture-build-2'), 'index should show the new marker');
    } finally {
      await close(copiedServer);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
