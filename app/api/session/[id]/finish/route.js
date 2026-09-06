import { transaction } from '@/lib/db';
import { L, median, checkSession } from '@/lib/checks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    return Response.json({ error: 'Unknown session.' }, { status: 404 });

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const clientReport = {
    synthetic: !!body?.synthetic,
    patchedTimer: !!body?.patchedTimer,
    focusLost: !!body?.focusLost,
  };

  return transaction(async (q) => {
    const { rows: [s] } = await q(
      `select * from sessions where id=$1 for update`,
      [id]
    );
    if (!s) return Response.json({ error: 'Unknown session.' }, { status: 404 });

    const { rows } = await q(
      `select reported_ms, status, fault from rounds where session_id=$1 order by idx`,
      [id]
    );
    const times = rows.filter((r) => r.status === 'valid').map((r) => Number(r.reported_ms));

    /* Rounds the network ate are not the player's doing, so they are not
       counted as false starts. Without this split, five good rounds plus nine
       rounds lost to a bad connection scored as "more false starts than
       starts" and put an honest player on the wall of shame. */
    const voids = rows.filter((r) => r.status === 'void' && r.fault !== 'network').length;
    const lost = rows.filter((r) => r.fault === 'network').length;

    if (s.status === 'verified' || s.status === 'rejected')
      return Response.json({ status: s.status, flags: s.flags, lost,
        median: +Number(s.median_ms).toFixed(1), best: +Number(s.best_ms).toFixed(1),
        sd: +Number(s.sd_ms).toFixed(1), name: s.player_name });
    if (s.status !== 'open')
      return Response.json({ error: 'Session already closed.' }, { status: 409 });
    if (rows.some((r) => r.status === 'pending'))
      return Response.json({ error: 'Finish the active round first.' }, { status: 409 });

    if (times.length < L.ROUNDS)
      return Response.json({ error: 'Session not finished.' }, { status: 400 });

    const scored = times.slice(0, L.ROUNDS);
    const spanMs = Date.now() - new Date(s.created_at).getTime();
    const { status, flags, sd } = checkSession({ times: scored, voids, clientReport, spanMs });

    const med = median(scored);
    const best = Math.min(...scored);

    await q(
      `update sessions
          set status=$2, median_ms=$3, best_ms=$4, sd_ms=$5,
              flags=$6::jsonb, client_report=$7::jsonb, completed_at=now()
        where id=$1`,
      [id, status, med.toFixed(2), best.toFixed(2), sd.toFixed(2),
       JSON.stringify(flags), JSON.stringify(clientReport)]
    );

    return Response.json({
      status, flags, lost,
      median: +med.toFixed(1),
      best: +best.toFixed(1),
      sd: +sd.toFixed(1),
      name: s.player_name,
    });
  });
}
