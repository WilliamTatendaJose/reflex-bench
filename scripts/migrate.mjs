import { readFileSync } from 'node:fs';
import pg from 'pg';

const raw = process.env.DATABASE_URL;

// Building without a database is allowed — a fork should still compile.
// The app just will not work until DATABASE_URL is set, so say so loudly
// rather than failing the build.
if (!raw) {
  console.warn('! DATABASE_URL is not set — skipping the schema push.');
  console.warn('! The game will 500 on every round until you set it and redeploy.');
  process.exit(0);
}

/* A connection string that is not a valid absolute URL does not fail here.
   pg resolves it against its own dummy base and the host silently becomes
   the literal word "base", which only surfaces much later as a baffling
   ENOTFOUND at runtime. Catch the shape now, while someone is reading the
   build log.

   Note the whitespace checks are not fussiness: new URL() quietly strips
   surrounding whitespace but pg does not, so a padded value passes a naive
   URL check and still dies at runtime. Ask about the raw string. */
const complain = (why) => {
  console.error(`DATABASE_URL is not a usable Postgres connection string: ${why}.`);
  console.error('It must start with postgres:// or postgresql:// and name a host —');
  console.error('no "DATABASE_URL=" prefix, no wrapping quotes, no stray whitespace.');
  console.error(`Got a value ${raw.length} characters long starting "${raw.slice(0, 12)}…".`);
  process.exit(1);
};

if (raw !== raw.trim()) complain('it has leading or trailing whitespace');
if (/\s/.test(raw)) complain('it contains a space or newline');

let parsed = null;
try { parsed = new URL(raw); } catch { complain('it is not a URL'); }
if (!/^postgres(ql)?:$/.test(parsed.protocol)) complain(`the scheme is "${parsed.protocol}"`);
if (!parsed.hostname) complain('it names no host');

const client = new pg.Client({
  connectionString: raw,
  ssl: raw.includes('localhost') ? false : { rejectUnauthorized: false },
});
await client.connect();

// schema.sql is entirely "if not exists", so re-running it is a no-op.
// Look first only so the build log can say which of the two happened.
const { rows: [{ present }] } = await client.query(
  `select to_regclass('public.sessions') is not null as present`
);
await client.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await client.end();

console.log(present ? 'Schema already present — verified.' : 'Schema created.');
