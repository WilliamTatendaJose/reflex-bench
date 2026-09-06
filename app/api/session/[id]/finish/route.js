import { q } from '@/lib/db';
import { L, median, checkSession } from '@/lib/checks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const clientReport = {
    synthetic: !!body.synthetic,
    patchedTimer: !!body.patchedTimer,
    focusLost: !!body.focusLost,
  };

  const { rows: [s] } = await q(
    `select id, player_name, status, created_at from sessions where id=$1`,
    [id]
  ).catch(() => ({ rows: [] }));
  if (!s) return Response.json({ error: 'Unknown session.' }, { status: 404 });
  if (s.status !== 'open')
    return Response.json({ error: 'Session already scored.' }, { status: 409 });

  const { rows } = await q(
    `select reported_ms, status from rounds where session_id=$1 order by idx`,
    [id]
  );
  const times = rows.filter((r) => r.status === 'valid').map((r) => Number(r.reported_ms));
  const voids = rows.filter((r) => r.status === 'void').length;

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
    status, flags,
    median: +med.toFixed(1),
    best: +best.toFixed(1),
    sd: +sd.toFixed(1),
    name: s.player_name,
  });
}
