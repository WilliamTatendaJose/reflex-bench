# Reflex Bench

A reaction-time game where the leaderboard means something. Five rounds per
session, scored on the **median** — not the best — and every number is
checked on the server before it reaches the board.

## Deploy

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL and SIGNING_SECRET
openssl rand -hex 32           # -> SIGNING_SECRET
npm run db:push                # applies db/schema.sql (also runs on build)
npm run dev
```

For Vercel: push to a repo, import it, set `DATABASE_URL` and
`SIGNING_SECRET` as environment variables, deploy. Any Postgres works —
Neon, Supabase, or your own instance.

The build runs `db:push` first, so the schema is applied on the first
deploy and verified on every one after — `db/schema.sql` is entirely
`if not exists`, so re-running it is a no-op. A build with no
`DATABASE_URL` warns and carries on; a build with a malformed one stops
and says why, rather than leaving you to find out from a runtime
`ENOTFOUND`.

Note the round endpoint holds a request open for up to 4.3 seconds
(`maxDuration = 15`). That is inside the Hobby plan's limit, but it does
mean a round costs a held function invocation.

## Integrity checks and their limits

Scores under 100ms are excluded by policy. Readings under 130ms prevent a
session from ranking. These are game thresholds, not proof of cheating.
Consistency and matching readings are descriptive only: five samples do
not establish whether a person or a script played.

The server chooses the hidden delay, signs each go-token, and compares the
reported reaction interval with elapsed server time. A script can still
wait and submit plausible readings. “Passed checks” does not mean verified
human play. The internal `verified` status is retained for compatibility.

Browser-reported synthetic input, timer changes, and focus loss can prevent
ranking, but their absence proves nothing. Unranked results are public and
are not labelled as proven cheats.

## Round lifecycle and recovery

Round allocation locks the session row in a short transaction and reserves
one pending round before waiting. Results and finishing take the same lock.
No database connection is held during the random delay. Expired pending
attempts are eventually voided as network failures when another is requested.

The client blocks overlapping attempts and ignores responses from sessions
that have been left. Result and finish requests are idempotent: retrying after
a lost response returns the stored outcome without changing the score.
If a round-opening response is lost, start a new session; its missing go-token
cannot be reconstructed by the browser. “Retry saving” preserves a known
round's original payload. A retry that first arrives after expiry is voided.

Network voids do not consume the 14 charged attempts; 30 total attempts cap
a session. The wire budget is 450ms and can exclude honest readings on slow
connections. Names are public labels, not authenticated identities. Session
creation is limited to 25 per IP hash per hour.

Leaderboard selection finds each name's best score, then ranks all names
before taking the first 50. Existing historical scores are not rescored.

## Tests

`npm test` runs validation and API/SQL regressions using embedded PostgreSQL
(PGlite). Transaction serialization is exercised locally; this does not replace
a multi-connection PostgreSQL deployment test. `npm run test:e2e` runs browser
regressions with mocked API responses (install Chromium using
`npx playwright install chromium` first). `npm run build` checks production
compilation. Browser mocks do not verify live PostgreSQL or deployment setup.

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
