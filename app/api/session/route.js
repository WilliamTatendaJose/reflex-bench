import { q } from '@/lib/db';
import { hashIp, clientIp } from '@/lib/sign';
import { L } from '@/lib/checks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = {}; }

  const name = String(body.name || '').trim().slice(0, 16);
  if (!name) return Response.json({ error: 'Enter a name.' }, { status: 400 });

  const ip = hashIp(clientIp(req));

  const { rows: [count] } = await q(
    `select count(*)::int as n from sessions
      where ip_hash = $1 and created_at > now() - interval '1 hour'`,
    [ip]
  );
  if (count.n >= L.SESSIONS_PER_HOUR)
    return Response.json(
      { error: 'Too many sessions from here in the last hour. Try again later.' },
      { status: 429 }
    );

  const { rows: [s] } = await q(
    `insert into sessions (player_name, ip_hash) values ($1, $2) returning id`,
    [name, ip]
  );

  return Response.json({ sessionId: s.id, rounds: L.ROUNDS });
}
