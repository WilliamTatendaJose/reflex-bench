/* ------------------------------------------------------------------ *
 * What can and cannot be enforced, stated plainly.
 *
 * The reaction interval itself HAS to be measured on the client — the
 * server is one network hop away and that hop is larger and noisier than
 * the thing being measured. So the client number is never trusted on its
 * own. It is bounded from three directions instead:
 *
 *   BINDING (server-only state, a cheat cannot touch these):
 *     - the delay before green is chosen server-side and never sent
 *     - the go-token is HMAC-signed and single-use
 *     - server_elapsed_ms is measured go-release -> result-arrival
 *
 *   BINDING (physiology, not code):
 *     - nothing under 100ms is a reaction; it is an anticipation
 *     - five samples from one nervous system have spread
 *
 *   ADVISORY (client-reported, a determined cheat can suppress these):
 *     - isTrusted, patched-timer tripwires, focus loss
 *     Absence of these flags proves nothing. Presence is evidence.
 *
 * Net effect: the best available cheat is a script that waits a
 * human-plausible interval and reports a human-plausible spread. That
 * caps the board at "suspiciously elite" instead of "1ms". Cheating is
 * not prevented, it is made unrewarding. Do not oversell this.
 * ------------------------------------------------------------------ */

export const L = {
  ROUNDS: 5,            // valid rounds needed to complete a session
  MAX_ROUNDS: 14,       // total attempts allowed, incl. false starts
  HARD_FLOOR: 100,      // ms — below this, reject the round outright
  SUSPECT_FLOOR: 130,   // ms — allowed, but flags the session
  CEILING: 3000,        // ms — anything slower is a mis-tap, void it
  SD_FLOOR: 8,          // ms — humans cannot hold 5 trials tighter
  WIRE_SLACK: 450,      // ms — see wire check below
  TOKEN_TTL: 20000,     // ms — a go-token expires quickly
  DELAY_MIN: 1300,
  DELAY_MAX: 4300,
  SESSIONS_PER_HOUR: 25,
};

export const median = (a) => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** Per-round verdict. Returns { status, note }. */
export function checkRound({ reportedMs, serverElapsedMs }) {
  if (!Number.isFinite(reportedMs)) return { status: 'void', note: 'no reading' };

  if (reportedMs < L.HARD_FLOOR)
    return { status: 'void', note: 'below the human floor' };

  if (reportedMs > L.CEILING)
    return { status: 'void', note: 'too slow to be a reaction' };

  // The client cannot report a reaction longer than the whole wire
  // interval, because the wire interval contains it. A violation means
  // the client clock was tampered with.
  if (reportedMs > serverElapsedMs + 30)
    return { status: 'void', note: 'reading exceeds wire time' };

  // The other direction: the wire says the client took far longer than
  // it claims. A bot that waits and then lies gets caught here. Slack is
  // deliberately wide — a bad mobile connection is not fraud.
  if (serverElapsedMs - reportedMs > L.WIRE_SLACK)
    return { status: 'void', note: 'wire time inconsistent with reading' };

  return {
    status: 'valid',
    note: reportedMs < L.SUSPECT_FLOOR ? 'very fast — flagged' : null,
  };
}

/** Session verdict over the 5 valid rounds. Returns { status, flags }. */
export function checkSession({ times, voids, clientReport = {}, spanMs }) {
  const flags = [];

  if (times.length !== L.ROUNDS) flags.push('incomplete session');

  const sd = stdev(times);
  if (sd < L.SD_FLOOR)
    flags.push(`spread ${sd.toFixed(1)}ms — below human variability`);

  if (new Set(times.map((t) => t.toFixed(1))).size < times.length)
    flags.push('duplicate samples');

  if (times.some((t) => t < L.SUSPECT_FLOOR))
    flags.push('sample under 130ms');

  // A full session cannot physically run faster than 5 x (min delay).
  if (spanMs && spanMs < L.ROUNDS * L.DELAY_MIN)
    flags.push('session shorter than its own delays');

  if (voids > 8) flags.push('excessive false starts');

  // Advisory, from the browser. Treated as evidence when present.
  if (clientReport.synthetic) flags.push('scripted input reported by browser');
  if (clientReport.patchedTimer) flags.push('timing API was not native');
  if (clientReport.focusLost) flags.push('window lost focus mid-round');

  return { status: flags.length ? 'rejected' : 'verified', flags, sd };
}
