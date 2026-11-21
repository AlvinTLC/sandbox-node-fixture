'use strict';

// Opens a WebSocket against the same origin the page was served from, so the
// connection inherits whatever path prefix the sandbox is mounted under. This is
// the client half of the proxy's upgrade test: if the reverse proxy drops the
// Upgrade header, the status line below stays "closed" and the page says so
// instead of pretending the socket works.
(function connect() {
  const status = document.getElementById('ws-status');
  if (!status) {
    return;
  }

  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = window.location.pathname.replace(/\/[^/]*$/, '/');
  const url = `${scheme}//${window.location.host}${base}ws`;

  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    status.textContent = 'unavailable';
    status.dataset.state = 'closed';
    return;
  }

  socket.addEventListener('open', () => {
    status.textContent = 'open';
    status.dataset.state = 'open';
    socket.send('ping');
  });

  socket.addEventListener('message', (event) => {
    status.textContent = `open · echo ${event.data}`;
    status.dataset.state = 'open';
  });

  socket.addEventListener('error', () => {
    status.textContent = 'error';
    status.dataset.state = 'closed';
  });

  socket.addEventListener('close', () => {
    if (status.dataset.state !== 'open') {
      status.textContent = 'closed';
      status.dataset.state = 'closed';
    }
  });
})();
