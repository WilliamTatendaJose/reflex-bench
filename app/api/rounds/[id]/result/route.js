import { q } from '@/lib/db';
import { readGoToken } from '@/lib/sign';
import { L, checkRound } from '@/lib/checks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const arrivedAt = Date.now(); // stamp first, before any other work
  const { id } = await params;

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const token = readGoToken(body.goToken);
  if (!token || token.roundId !== id)
    return Response.json({ error: 'Bad or missing go-token.' }, { status: 403 });

  if (arrivedAt - token.goSentAtMs > L.TOKEN_TTL)
    return Response.json({ error: 'Round expired.' }, { status: 410 });

  const serverElapsedMs = arrivedAt - token.goSentAtMs;

  // A false start: the client tapped during the wait, so there is no
  // reading to check. Record it as void and move on.
  if (body.foul) {
    const { rowCount } = await q(
      `update rounds set status='void', fault='player', note=$2, result_at=now(),
              server_elapsed_ms=$3, go_sent_at=to_timestamp($4 / 1000.0)
         where id = $1 and status='pending'`,
      [id, String(body.foul).slice(0, 40), serverElapsedMs, token.goSentAtMs]
    );
    if (!rowCount) return Response.json({ error: 'Round already settled.' }, { status: 409 });
    return Response.json({ status: 'void', note: 'jumped the gun' });
  }

  const reportedMs = Number(body.reportedMs);
  const verdict = checkRound({ reportedMs, serverElapsedMs });

  // Single-use: the status='pending' predicate makes replay a no-op.
  const { rowCount } = await q(
    `update rounds
        set status=$2, note=$3, reported_ms=$4,
            server_elapsed_ms=$5, result_at=now(), fault=$6,
            go_sent_at=to_timestamp($7 / 1000.0)
      where id=$1 and status='pending'`,
    [id, verdict.status, verdict.note, Number.isFinite(reportedMs) ? reportedMs : null,
     serverElapsedMs, verdict.fault, token.goSentAtMs]
  );
  if (!rowCount)
    return Response.json({ error: 'Round already settled.' }, { status: 409 });

  const { rows: [c] } = await q(
    `select count(*) filter (where status='valid')::int as valid,
            count(*) filter (where status='void' and fault is distinct from 'network')::int as void,
            count(*) filter (where fault = 'network')::int as lost
       from rounds where session_id = (select session_id from rounds where id=$1)`,
    [id]
  );

  return Response.json({ ...verdict, ms: reportedMs, valid: c.valid, void: c.void, lost: c.lost });
}
