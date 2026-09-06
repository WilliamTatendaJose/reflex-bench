import crypto from 'node:crypto';
import { q } from '@/lib/db';
import { mintGoToken } from '@/lib/sign';
import { L } from '@/lib/checks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15; // the longest hold is 4.3s; 15 is headroom

/**
 * The whole point of this route: the client asks for a round and the
 * server simply does not answer until the green should appear. The delay
 * never crosses the wire, so it cannot be pre-computed and a tap cannot
 * be scheduled against it. The client's clock starts when this response
 * lands.
 */
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const sessionId = String(body.sessionId || '');

  const { rows: [s] } = await q(
    `select id, status from sessions where id = $1`,
    [sessionId]
  ).catch(() => ({ rows: [] }));

  if (!s) return Response.json({ error: 'Unknown session.' }, { status: 404 });
  if (s.status !== 'open')
    return Response.json({ error: 'Session already closed.' }, { status: 409 });

  const { rows: [c] } = await q(
    `select count(*)::int as n from rounds where session_id = $1`,
    [sessionId]
  );
  if (c.n >= L.MAX_ROUNDS)
    return Response.json({ error: 'Round limit reached for this session.' }, { status: 409 });

  const delay = L.DELAY_MIN + crypto.randomInt(L.DELAY_MAX - L.DELAY_MIN);
  await new Promise((r) => setTimeout(r, delay));

  const goSentAt = Date.now();
  const { rows: [r] } = await q(
    `insert into rounds (session_id, idx, delay_ms, go_sent_at)
     values ($1, $2, $3, to_timestamp($4 / 1000.0)) returning id`,
    [sessionId, c.n, delay, goSentAt]
  );

  return Response.json(
    { roundId: r.id, goToken: mintGoToken(r.id, goSentAt) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
