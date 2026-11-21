'use strict';

// BlazeSandbox fixture application.
//
// This app exists to be deployed inside a sandbox container and probed over the
// public URL that the service hands back. It is deliberately dependency-free:
// the container runs `npm ci` with no network guarantee, so anything that needs
// a registry would make the end-to-end test flaky for reasons unrelated to the
// sandbox itself.
//
// Two properties matter for the acceptance criteria:
//
//   1. The build marker is read from build.json on every request, so editing
//      that file and re-deploying is observable on the same URL without a
//      restart. That is what makes the iterative loop testable.
//   2. Every asset is referenced with a relative path and the server tolerates
//      being mounted under a path prefix, because the service exposes sandboxes
//      at /s/{id}/ rather than at the root of a host.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

// The service mounts a sandbox at /s/{id}/. Whether the reverse proxy strips
// that prefix before forwarding is a property of the proxy, not of this app, so
// the app accepts both shapes instead of assuming one.
function stripSandboxPrefix(pathname) {
  const match = /^\/s\/[^/]+(\/.*)?$/.exec(pathname);
  if (!match) {
    return pathname;
  }
  return match[1] || '/';
}

function readBuildMarker() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      marker: typeof parsed.marker === 'string' ? parsed.marker : 'unknown',
      built_at: typeof parsed.built_at === 'string' ? parsed.built_at : '',
    };
  } catch {
    // A missing or malformed build.json must not take the app down: the probe
    // only needs a 200, and a hard failure here would look like a sandbox bug.
    return { marker: 'unknown', built_at: '' };
  }
}

function renderIndex() {
  const build = readBuildMarker();
  const template = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  return template
    .replaceAll('{{BUILD_MARKER}}', escapeHtml(build.marker))
    .replaceAll('{{BUILT_AT}}', escapeHtml(build.built_at));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body === undefined) {
    res.end();
    return;
  }
  res.end(body);
}

function serveStatic(res, filePath) {
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found\n');
    return;
  }
  const type = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
  send(res, 200, { 'content-type': type, 'cache-control': 'no-store' }, data);
}

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://sandbox.invalid');
  const originalPath = url.pathname;

  // A sandbox URL without the trailing slash breaks every relative asset, so
  // redirect instead of serving a page whose CSS and JS 404.
  if (/^\/s\/[^/]+$/.test(originalPath)) {
    send(res, 308, { location: `${originalPath}/${url.search}` });
    return;
  }

  const route = stripSandboxPrefix(originalPath);

  if (route === '/' || route === '/index.html') {
    let html;
    try {
      html = renderIndex();
    } catch {
      send(res, 500, { 'content-type': 'text/plain; charset=utf-8' }, 'index template missing\n');
      return;
    }
    send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, html);
    return;
  }

  if (route === '/healthz') {
    send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ status: 'ok' }));
    return;
  }

  // Exposed separately so a test can assert the marker without parsing HTML.
  if (route === '/build.json') {
    send(
      res,
      200,
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      JSON.stringify(readBuildMarker()),
    );
    return;
  }

  if (route === '/api/echo') {
    send(
      res,
      200,
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      JSON.stringify({ method: req.method, path: originalPath, query: Object.fromEntries(url.searchParams) }),
    );
    return;
  }

  // Static assets live under public/ and are resolved without ever escaping it.
  const candidate = path.join(ROOT, 'public', path.normalize(route).replace(/^(\.\.[/\\])+/, ''));
  const relative = path.relative(path.join(ROOT, 'public'), candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    send(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'forbidden\n');
    return;
  }
  serveStatic(res, candidate);
}

// Minimal RFC 6455 server side: enough to prove that the reverse proxy forwards
// the Upgrade handshake and keeps the socket open. The real motivation is Vite
// HMR, which is a WebSocket that must survive the /s/{id} hop.
function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key.length === 0) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
  );

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(buffer);
      if (!frame) {
        return;
      }
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        socket.end(encodeFrame(0x8, Buffer.alloc(0)));
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0x1) {
        socket.write(encodeFrame(0x1, frame.payload));
      }
    }
  });
  // An upgraded socket is detached from the HTTP parser, so nothing else will
  // tear it down: without these handlers a client that walks away leaves the
  // socket open and the server can never finish closing.
  socket.on('end', () => socket.destroy());
  socket.on('error', () => socket.destroy());
  socket.on('close', () => socket.destroy());
}

function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    length = Number(big);
    offset += 8;
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) {
    return null;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey) {
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  return { opcode, payload, consumed: offset + length };
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function createServer() {
  const server = http.createServer(handleRequest);
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://sandbox.invalid');
    const route = stripSandboxPrefix(url.pathname);
    if (route !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    acceptWebSocket(req, socket);
  });
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    // The resolved port is printed rather than the requested one: with PORT=0
    // the kernel picks a free port, and the tests need to read the real value.
    const address = server.address();
    process.stdout.write(`fixture listening on http://${HOST}:${address.port}\n`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, stripSandboxPrefix, readBuildMarker, encodeFrame, decodeFrame };
