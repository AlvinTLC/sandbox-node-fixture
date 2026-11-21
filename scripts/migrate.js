'use strict';

// Migration step for the fixture.
//
// The provisioner runs `npm run migrate` before starting the app, so this has to
// be idempotent and has to work with what the baked image already ships. The
// image has Postgres and its client, but no npm registry access is guaranteed,
// which rules out the `pg` driver: this talks to `psql` over the local socket
// instead.
//
// If DATABASE_URL is absent the step is a no-op that still exits 0. That keeps
// the fixture usable for a plain `npm start` outside a sandbox without turning
// a missing database into a provisioning failure.

const { spawnSync } = require('node:child_process');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS fixture_events (
     id          bigserial PRIMARY KEY,
     kind        text        NOT NULL,
     created_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `INSERT INTO fixture_events (kind) VALUES ('migrate')`,
];

function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stdout.write('migrate: DATABASE_URL not set, skipping\n');
    return 0;
  }

  const sql = STATEMENTS.join(';\n') + ';\n';
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], {
    input: sql,
    encoding: 'utf8',
  });

  if (result.error) {
    process.stderr.write(
      `migrate: cannot run psql: ${result.error.message}\n` +
        'migrate: the baked image blazesandbox-node-pg must ship the postgresql client; ' +
        'see docs/runbook-incus.md (make bake) in the blazesandbox repo.\n',
    );
    return 1;
  }
  if (result.status !== 0) {
    process.stderr.write(`migrate: psql failed (exit ${result.status})\n${result.stderr || ''}`);
    return 1;
  }

  process.stdout.write('migrate: schema up to date\n');
  return 0;
}

process.exit(main());
