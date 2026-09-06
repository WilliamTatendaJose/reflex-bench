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

/* "create table if not exists" skips a table that already carries the name,
   whatever shape it is in. So a database that already owns a "sessions"
   table silently keeps it, and the failure surfaces one statement later as
   a foreign-key type mismatch against a table nobody meant to reference.
   Presence is not compatibility — check the shape before touching anything. */
const { rows: [found] } = await client.query(`
  select
    to_regclass('public.sessions')::text                       as qualified,
    to_regclass('sessions')::text                              as unqualified,
    (select a.atttypid::regtype::text
       from pg_attribute a
      where a.attrelid = to_regclass('public.sessions')
        and a.attname = 'id' and a.attnum > 0)                 as id_type,
    (select count(*)::int
       from pg_attribute a
      where a.attrelid = to_regclass('public.sessions')
        and a.attnum > 0
        and a.attname in ('player_name', 'ip_hash', 'median_ms')) as ours
`);

const bail = (lines) => {
  lines.forEach((l) => console.error(l));
  client.end();
  process.exit(1);
};

if (found.qualified && found.id_type !== 'uuid') {
  bail([
    `public.sessions already exists in this database and is not ours.`,
    `Its "id" column is ${found.id_type}; this schema needs uuid, so the`,
    `rounds foreign key cannot be created against it.`,
    '',
    'Nothing has been changed. Point DATABASE_URL at a database of its own,',
    'or rename/drop that table yourself if you are certain it is disposable.',
    'To see what it is:  \\d public.sessions',
  ]);
}

if (found.qualified && found.ours < 3) {
  bail([
    'public.sessions already exists with a uuid id, but it is missing columns',
    'this app requires (player_name, ip_hash, median_ms).',
    '',
    'Nothing has been changed. Use a database of its own, or inspect it with:',
    '  \\d public.sessions',
  ]);
}

if (found.unqualified && found.unqualified !== 'sessions' && found.unqualified !== 'public.sessions') {
  console.warn(`! note: unqualified "sessions" resolves to ${found.unqualified} on this`);
  console.warn('! search_path. This schema pins everything to public explicitly.');
}

// schema.sql is entirely "if not exists", so re-running it is a no-op.
await client.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await client.end();

console.log(found.qualified ? 'Schema already present — verified.' : 'Schema created.');
