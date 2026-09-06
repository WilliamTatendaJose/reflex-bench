import { q } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // One row per name: their best verified session.
  const { rows: verified } = await q(
    `select * from (
       select distinct on (lower(player_name))
              player_name, median_ms, best_ms, sd_ms, completed_at
         from sessions where status = 'verified'
        order by lower(player_name), median_ms asc, completed_at asc
     ) best_per_name
     order by median_ms asc, completed_at asc, lower(player_name)
     limit 50`
  );

  const { rows: rejected } = await q(
    `select player_name, median_ms, flags, completed_at
       from sessions
      where status = 'rejected'
      order by completed_at desc
      limit 15`
  );

  return Response.json(
    { verified: verified.slice(0, 50), rejected },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
