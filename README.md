# BlazeSandbox fixture

A dependency-free Node application used as the deployable payload of the
end-to-end test. It is not a demo: it exists so the acceptance criteria can be
asserted against something that actually behaves like a web app.

## Why it has no dependencies

The container runs `npm ci` during provisioning and network egress from a nested
container is the least reliable part of the whole path. A fixture that needs a
registry would fail for reasons that have nothing to do with the sandbox, so the
app uses only `node:http`, `node:crypto` and `node:fs`. `npm ci` succeeds
offline against the committed lockfile.

## Project contract

The service infers the project contract from `package.json`:

| Requirement | Provided by |
| --- | --- |
| start script | `scripts.start` → `node server.js` |
| migration script | `scripts.migrate` → `node scripts/migrate.js` |
| lockfile | `package-lock.json` |

The app binds `0.0.0.0` and reads `PORT` (default `3000`), which is what the
container needs to be reachable through the Incus proxy device.

## What makes the iterative loop testable

`build.json` is read on every request, not at boot. Editing it and calling
`sandbox_up` again changes the marker served on the same URL, with no restart
and no rebuild. The end-to-end re-deploy test asserts exactly that:

```
GET /build.json  →  {"marker":"fixture-build-1", ...}
# edit build.json → marker becomes fixture-build-2
GET /build.json  →  {"marker":"fixture-build-2", ...}
```

## Path prefix

Sandboxes are exposed at `/s/{id}/`, not at the root of a host. Two consequences
are handled here:

- every asset in `public/index.html` uses a **relative** path, so it resolves
  under the prefix instead of against the service host;
- the server strips a leading `/s/{id}` itself, so it works whether or not the
  reverse proxy removes the prefix before forwarding;
- `GET /s/{id}` (no trailing slash) redirects to `/s/{id}/`, because otherwise
  every relative asset resolves one level too high.

## WebSocket

`/ws` implements the RFC 6455 handshake and echoes text frames. It exists to
prove the reverse proxy forwards `Upgrade` and keeps the connection open — the
real-world case being Vite HMR. The page reports the socket state, so a broken
upgrade is visible instead of silent.

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` | HTML page with the build marker |
| `/healthz` | `{"status":"ok"}`, cheap liveness probe |
| `/build.json` | build marker as JSON, for assertions |
| `/api/echo` | echoes method, path and query |
| `/ws` | WebSocket echo |
| `/styles.css`, `/app.js` | static assets |

## Running it

```sh
npm start                 # http://0.0.0.0:3000
PORT=8080 npm start       # custom port
npm test                  # node --test
```
