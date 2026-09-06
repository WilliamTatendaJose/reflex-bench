import crypto from 'node:crypto';
import { transaction } from '@/lib/db';
import { mintGoToken } from '@/lib/sign';
import { L } from '@/lib/checks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const sessionId = String(body?.sessionId || '');
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId))
    return Response.json({ error: 'Unknown session.' }, { status: 404 });

  const delay = L.DELAY_MIN + crypto.randomInt(L.DELAY_MAX - L.DELAY_MIN);
  // Serialize allocation on the session, then release the connection before waiting.
  const reserved = await transaction(async (q) => {
    const { rows: [s] } = await q('select status from sessions where id=$1 for update', [sessionId]);
    if (!s) return { error: 'Unknown session.', code: 404 };
    if (s.status !== 'open') return { error: 'Session already closed.', code: 409 };
    // A disconnected client must not leave a session locked forever.
    await q(`update rounds set status='void', fault='network', note='Round expired.', result_at=now()
      where session_id=$1 and status='pending'
        and go_sent_at < now() - ($2 * interval '1 millisecond')`,
      [sessionId, L.TOKEN_TTL + L.DELAY_MAX + 15000]);
    const { rows: [c] } = await q(`select count(*)::int as total,
      count(*) filter (where fault is distinct from 'network')::int as charged,
      count(*) filter (where status='pending')::int as pending,
      count(*) filter (where status='valid')::int as valid
      from rounds where session_id=$1`, [sessionId]);
    if (c.pending) return { error: 'Finish the active round first.', code: 409 };
    if (c.valid >= L.ROUNDS) return { error: 'All five rounds are complete.', code: 409 };
    if (c.charged >= L.MAX_ROUNDS || c.total >= L.MAX_ATTEMPTS)
      return { error: 'Round limit reached for this session.', code: 409 };
    const { rows: [r] } = await q(`insert into rounds (session_id, idx, delay_ms, go_sent_at)
      values ($1, $2, $3, now()) returning id`, [sessionId, c.total, delay]);
    return r;
  });
  if (reserved.error) return Response.json({ error: reserved.error }, { status: reserved.code });
  // Neither the reserved row nor the delay is exposed before the wait elapses.
  await new Promise((resolve) => setTimeout(resolve, delay));
  const goSentAt = Date.now();
  return Response.json({ roundId: reserved.id, goToken: mintGoToken(reserved.id, goSentAt) },
    { headers: { 'Cache-Control': 'no-store' } });
}
