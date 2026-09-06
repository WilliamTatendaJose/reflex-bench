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
  MAX_ROUNDS: 14,       // attempts charged to the player, incl. false starts
  MAX_ATTEMPTS: 30,     // absolute ceiling incl. rounds the network ate
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

/* ------------------------------------------------------------------ *
 * Everything below this line is what the bench SAYS. None of it is what
 * the bench DOES — the thresholds in L and the comparisons against them
 * are untouched by any of it.
 *
 * Two rules hold the voice together:
 *
 *   1. Rotate. The same sentence read three times is a UI label, not a
 *      joke, so every verdict has a few forms.
 *   2. Aim carefully. WIRE_SLACK is deliberately wide and still voids
 *      honest players on bad connections. Being sneered at by a machine
 *      for having poor reception is not funny, so network verdicts stay
 *      plain and say whose fault it is not. Only the deliberate ones —
 *      impossible speed, bent clocks, scripted taps — get the contempt.
 * ------------------------------------------------------------------ */

const pick = (a) => a[Math.floor(Math.random() * a.length)];

const SAY = {
  noReading: ['no reading — did you tap at all?', 'nothing came through', 'that round arrived empty'],
  tooFast: [
    'faster than biology allows',
    'nobody has nerves that short',
    'the light had not finished leaving the screen',
  ],
  tooSlow: ['the green gave up waiting', 'that one aged out', 'did you nod off?'],
  clockLies: [
    'your clock is telling stories',
    'that reading and this clock disagree',
    'the timestamps do not corroborate',
  ],
  // Not an accusation. Usually just a bad connection.
  wire: [
    'lost in traffic — void, and not your fault',
    'the connection ate that one',
    'network noise swallowed that round',
  ],
};

/* What to say about a round that counted. The middle band is deliberately
   silent: if every score gets a remark, none of them land. */
const BANDS = [
  [L.SUSPECT_FLOOR, ['suspiciously good', 'noted, and doubted', 'that is not a reaction, that is a premonition']],
  [180, ['annoyingly good', 'show off', 'fine. that was good.']],
  [260, [null, null, null]],
  [450, ['were you reading something?', 'take your time', 'somewhere else to be?']],
  [900, ['the green was up a while', 'it waited', 'we all waited']],
  [Infinity, ['we held the door for you', 'the green has since gone home', 'was the kettle on?']],
];

/** Per-round verdict. Returns { status, note }. */
export function checkRound({ reportedMs, serverElapsedMs }) {
  if (!Number.isFinite(reportedMs))
    return { status: 'void', fault: 'player', note: pick(SAY.noReading) };

  if (reportedMs < L.HARD_FLOOR)
    return { status: 'void', fault: 'player', note: pick(SAY.tooFast) };

  if (reportedMs > L.CEILING)
    return { status: 'void', fault: 'player', note: pick(SAY.tooSlow) };

  // The client cannot report a reaction longer than the whole wire
  // interval, because the wire interval contains it. A violation means
  // the client clock was tampered with.
  if (reportedMs > serverElapsedMs + 30)
    return { status: 'void', fault: 'player', note: pick(SAY.clockLies) };

  // The other direction: the wire says the client took far longer than
  // it claims. A bot that waits and then lies gets caught here. Slack is
  // deliberately wide — a bad mobile connection is not fraud.
  /* The wire was slower than the reading can account for. On a bad
     connection this is the commonest void there is, and the player did
     nothing wrong — so it is marked as such and not counted against them
     anywhere. */
  if (serverElapsedMs - reportedMs > L.WIRE_SLACK)
    return { status: 'void', fault: 'network', note: pick(SAY.wire) };

  return {
    status: 'valid',
    fault: null,
    note: pick(BANDS.find(([hi]) => reportedMs < hi)[1]),
  };
}

/** Session verdict over the 5 valid rounds. Returns { status, flags }. */
/* `voids` must already exclude rounds the network ate. Counting those
   would mean an honest player on a bad connection collecting a flag for
   impatience they never showed. */
export function checkSession({ times, voids, clientReport = {}, spanMs }) {
  const flags = [];

  if (times.length !== L.ROUNDS)
    flags.push(pick(['never finished it', 'walked off mid-session', 'left it unfinished']));

  const sd = stdev(times);
  if (sd < L.SD_FLOOR)
    flags.push(pick([
      `spread ${sd.toFixed(1)}ms — too steady to be a person`,
      `spread ${sd.toFixed(1)}ms — no hand repeats itself that well`,
      `spread ${sd.toFixed(1)}ms — machines are this consistent, people are not`,
    ]));

  if (new Set(times.map((t) => t.toFixed(1))).size < times.length)
    flags.push(pick(['the same tap, twice', 'two rounds agreeing to the decimal', 'copy, meet paste']));

  if (times.some((t) => t < L.SUSPECT_FLOOR))
    flags.push(pick([
      'a tap quicker than anyone has managed',
      'one round below what a nervous system does',
      'a reading no thumb has produced',
    ]));

  // A full session cannot physically run faster than 5 x (min delay).
  if (spanMs && spanMs < L.ROUNDS * L.DELAY_MIN)
    flags.push(pick([
      'finished before it could have started',
      'the whole session ran shorter than its own waiting',
      'five rounds in less time than five waits take',
    ]));

  if (voids > 8)
    flags.push(pick(['a truly itchy trigger finger', 'more false starts than starts', 'mostly jumping the gun']));

  // Advisory, from the browser. Treated as evidence when present.
  if (clientReport.synthetic)
    flags.push(pick(['the browser saw a robot', 'the taps were not made by a hand', 'the browser grassed you up']));
  if (clientReport.patchedTimer)
    flags.push(pick(['someone has been bending clocks', 'the timing functions were not the ones we shipped', 'the clocks had been got at']));
  if (clientReport.focusLost)
    flags.push(pick(['wandered off mid-round', 'the window lost interest', 'you left the room, so to speak']));

  return { status: flags.length ? 'rejected' : 'verified', flags, sd };
}
