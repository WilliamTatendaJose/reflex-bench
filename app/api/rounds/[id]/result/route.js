import { transaction } from '@/lib/db';
import { readGoToken } from '@/lib/sign';
import { L, checkRound } from '@/lib/checks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const arrivedAt = Date.now();
  const { id } = await params;
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const token = readGoToken(body?.goToken);
  if (!token || token.roundId !== id)
    return Response.json({ error: 'Bad or missing go-token.' }, { status: 403 });

  return transaction(async (q) => {
    // Lock in the same order as allocation and finishing.
    const { rows: [session] } = await q(`select s.id, s.status from sessions s
      join rounds r on r.session_id=s.id where r.id=$1 for update of s`, [id]);
    if (!session) return Response.json({ error: 'Unknown round.' }, { status: 404 });
    const { rows: [saved] } = await q('select * from rounds where id=$1', [id]);
    // A lost response can be retrieved, even after the token expires. Never rescore.
    if (saved.status !== 'pending') return Response.json({
      status: saved.status, fault: saved.fault, note: saved.note,
      ms: saved.reported_ms == null ? null : Number(saved.reported_ms),
    });
    if (session.status !== 'open')
      return Response.json({ error: 'Session already closed.' }, { status: 409 });
    const elapsed = arrivedAt - token.goSentAtMs;
    const ms = typeof body.reportedMs === 'number' && Number.isFinite(body.reportedMs)
      ? body.reportedMs : null;
    const verdict = elapsed > L.TOKEN_TTL
      ? { status: 'void', fault: 'network', note: 'Round expired; try another round.' }
      : body.foul
        ? { status: 'void', fault: 'player', note: String(body.foul).slice(0, 40) }
        : checkRound({ reportedMs: ms ?? NaN, serverElapsedMs: elapsed });
    // Store bounded readings only: malformed values must not overflow numeric(8,2).
    const storedMs = ms != null && ms >= 0 && ms <= L.CEILING ? ms : null;
    await q(`update rounds set status=$2, note=$3, reported_ms=$4,
      server_elapsed_ms=$5, result_at=now(), fault=$6,
      go_sent_at=to_timestamp($7 / 1000.0) where id=$1 and status='pending'`,
      [id, verdict.status, verdict.note, storedMs, Math.min(elapsed, 999999), verdict.fault, token.goSentAtMs]);
    return Response.json({ ...verdict, ms: storedMs });
  });
}
