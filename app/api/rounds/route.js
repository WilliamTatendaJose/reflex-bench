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

  /* Two counts, not one. `idx` has to keep numbering every round or the
     unique(session_id, idx) constraint collides, but the attempt budget
     only charges rounds the player is answerable for — a round the network
     ate should not cost them one of their goes.

     MAX_ATTEMPTS is the backstop: forgiving network voids without any
     ceiling would let a client farm unlimited attempts by sitting on its
     results until the wire check fires. */
  const { rows: [c] } = await q(
    `select count(*)::int as total,
            count(*) filter (where fault is distinct from 'network')::int as charged
       from rounds where session_id = $1`,
    [sessionId]
  );
  if (c.charged >= L.MAX_ROUNDS || c.total >= L.MAX_ATTEMPTS)
    return Response.json({ error: 'Round limit reached for this session.' }, { status: 409 });

  const delay = L.DELAY_MIN + crypto.randomInt(L.DELAY_MAX - L.DELAY_MIN);
  await new Promise((r) => setTimeout(r, delay));

  /* Stamp AFTER the insert. Anything before this point — including however
     long Postgres took to accept the row — is the bench's own latency, and
     charging it to the player's wire budget is what made a remote database
     eat into their allowance. The token carries the authoritative instant;
     go_sent_at is corrected to match when the result lands. */
  const { rows: [r] } = await q(
    `insert into rounds (session_id, idx, delay_ms, go_sent_at)
     values ($1, $2, $3, now()) returning id`,
    [sessionId, c.total, delay]
  );
  const goSentAt = Date.now();

  return Response.json(
    { roundId: r.id, goToken: mintGoToken(r.id, goSentAt) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
