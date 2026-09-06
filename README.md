# Reflex Bench

A reaction-time game where the leaderboard means something. Five rounds per
session, scored on the **median** — not the best — and every number is
checked on the server before it reaches the board.

## Deploy

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL and SIGNING_SECRET
openssl rand -hex 32           # -> SIGNING_SECRET
npm run db:push                # applies db/schema.sql
npm run dev
```

For Vercel: push to a repo, import it, set `DATABASE_URL` and
`SIGNING_SECRET` as environment variables, deploy. Any Postgres works —
Neon, Supabase, or your own instance. Run `npm run db:push` once against
the production URL.

Note the round endpoint holds a request open for up to 4.3 seconds
(`maxDuration = 15`). That is inside the Hobby plan's limit, but it does
mean a round costs a held function invocation.

## Why 1ms scores happen elsewhere, and not here

Anything that reaches your eye through the display cannot beat one frame —
16.7ms at 60Hz. Add retinal transduction, visual cortex, and the motor
path, and human simple reaction time floors out around 150ms, with 200–250ms
being normal. A sub-16ms score never travelled through the screen at all.

Three things usually produce one:

1. Posting straight to the leaderboard API with no server validation.
2. Hooking the state change in-page so the "tap" fires in the same JS task
   the green is set, before any paint.
3. Knowing the delay and scheduling a tap against it.

## What actually binds

**Server-only state — a client cannot touch these:**

- The delay before green is chosen server-side and **never sent to the
  browser**. `POST /api/rounds` simply does not respond until green is due.
  Nothing to schedule against.
- Every go carries an HMAC-signed, single-use token. Results for rounds
  that were never started are rejected before the database is touched.
  This is what kills the curl-the-endpoint attack.
- `server_elapsed_ms` is measured go-release to result-arrival, entirely on
  the server. A client that waits and then lies about a fast reading gets
  caught by the gap.

**Physiology, not code:**

- Nothing under 100ms is a reaction. Rejected outright. 100–130ms is
  allowed but flags the session.
- Five samples from one nervous system have spread. Standard deviation
  under 8ms is flagged as machine-like.
- Median of five, not best of N. A single injected sample cannot move a
  median.

**Advisory — the browser's own evidence:**

`isTrusted` on the tap, native-function tripwires on `performance.now`,
`Date.now`, and `dispatchEvent`, and focus loss during a round. A
determined cheat suppresses all of these, so their *absence* proves
nothing. Their *presence* is treated as evidence and flags the session.

## What this does not claim

Cheating is not prevented. It is made unrewarding.

The reaction interval has to be measured client-side, because the server is
a network hop away and that hop is larger and noisier than the thing being
measured. So the ceiling on cheating is this: a script that waits a
human-plausible interval and reports a human-plausible spread across five
rounds will pass. That script scores maybe 140ms — elite, but possible. The
board is bounded by physiology instead of by imagination, which is the
whole goal. Anyone claiming more than that is overselling.

Two known soft spots, stated up front:

- **Wire-time slack is 450ms.** Wide enough that a bad mobile connection is
  not called fraud, which also means it will not catch a cheat shaving
  30ms. Tighten `L.WIRE_SLACK` in `lib/checks.js` if your users are all on
  good connections, and watch the false-reject rate.
- **Session retries are unlimited by name.** Rate limiting is per IP hash,
  25 sessions/hour. Someone patient can fish for a good median the same way
  an honest player can. That is a fairness choice, not an oversight.

## Layout

```
app/page.jsx                        the game (client)
app/api/session/route.js            create a session, rate limit by IP hash
app/api/rounds/route.js             hold the request, release the go
app/api/rounds/[id]/result/route.js verify token, check the round
app/api/session/[id]/finish/route.js score and apply session-level checks
app/api/leaderboard/route.js        verified board + rejected list
lib/checks.js                       every threshold and rule, in one file
lib/sign.js                         HMAC go-tokens, IP hashing
db/schema.sql                       two tables
```

All thresholds live in `L` at the top of `lib/checks.js`. Tune there.
