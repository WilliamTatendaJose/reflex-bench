'use client';

import { useState, useEffect, useLayoutEffect, useRef } from 'react';

const ROUNDS = 5;
const SUSPECT = 130;
const SD_FLOOR = 8;

const isNative = (fn) => {
  try { return /\[native code\]/.test(Function.prototype.toString.call(fn)); }
  catch { return false; }
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/* Remember who is playing, so finishing five rounds does not send you back
   to a form to retype your own name. Not a credential — just a label for
   the board — so it is readable by the page and carries no other weight. */
const NAME_COOKIE = 'rb_name';
const readName = () => {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|; )rb_name=([^;]*)/);
  try { return m ? decodeURIComponent(m[1]).slice(0, 16) : ''; } catch { return ''; }
};
const rememberName = (v) => {
  if (typeof document === 'undefined') return;
  const secure = location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${NAME_COOKIE}=${encodeURIComponent(v)}; path=/; max-age=31536000; samesite=lax${secure}`;
};
const forgetName = () => {
  if (typeof document === 'undefined') return;
  document.cookie = `${NAME_COOKIE}=; path=/; max-age=0; samesite=lax`;
};

/* The cheat button is the one joke a player can repeat on purpose, so it
   answers differently each time and eventually stops playing along. The
   session was already flagged on the first press — that is the point of
   the gag, that pressing it again achieves nothing. */
const CHEAT_LABELS = [
  'Cheat button. Go on, we dare you.',
  'Again, then.',
  'Still no.',
  'You will wear it out.',
  'This is being written down.',
  'It is still being written down.',
  'Nothing here is going to change.',
  'One more and I stop humouring you.',
];
const CHEAT_RETIRED = 'Cheat button (retired, on grounds of persistence)';
const ROBOT_NOTES = [
  'nice try, robot',
  'that one was a script as well',
  'we can tell. every time.',
  'we can do this all day',
  'you are only making the list longer',
  'the flag went up several taps ago',
  'yes. still a script.',
  'that is quite enough of that',
];
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

export default function Page() {
  const [phase, setPhase] = useState('name'); // name|ready|wait|go|shown|foul|done|error
  const [name, setName] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [times, setTimes] = useState([]);
  const [voids, setVoids] = useState(0);
  const [lost, setLost] = useState(0);   // rounds the connection ate, not held against you
  const [last, setLast] = useState(null);
  const [cert, setCert] = useState(null);
  const [error, setError] = useState(null);
  const [board, setBoard] = useState(null);
  const [showBoard, setShowBoard] = useState(false);

  // advisory client-side evidence, sent with the session
  const [synthetic, setSynthetic] = useState(false);
  const [cheatPresses, setCheatPresses] = useState(0);
  const [focusLost, setFocusLost] = useState(false);
  const [patchedTimer] = useState(
    () => !(isNative(performance.now) && isNative(Date.now) &&
            isNative(EventTarget.prototype.dispatchEvent))
  );

  const greenAt = useRef(0);
  const round = useRef(null);
  const aborted = useRef(false);
  const pad = useRef(null);

  useEffect(() => { loadBoard(); const n = readName(); if (n) setName(n); }, []);
  const loadBoard = async () => {
    try { setBoard(await (await fetch('/api/leaderboard')).json()); }
    catch { setBoard({ verified: [], rejected: [], down: true }); }
  };

  /* The timestamp that matters. This rAF is scheduled during the commit
     that turns the pad green, so it fires at the start of the frame after
     the green is actually on screen — not when state was set. */
  useLayoutEffect(() => {
    if (phase !== 'go') return;
    greenAt.current = 0;
    const id = requestAnimationFrame((t) => { greenAt.current = t; });
    return () => cancelAnimationFrame(id);
  }, [phase]);

  useEffect(() => {
    const drop = () => {
      if (phase === 'wait' || phase === 'go') { setFocusLost(true); foul(pick(['you looked away', 'eyes on the pad', 'you left the room, so to speak'])); }
    };
    const vis = () => document.hidden && drop();
    window.addEventListener('blur', drop);
    document.addEventListener('visibilitychange', vis);
    return () => { window.removeEventListener('blur', drop); document.removeEventListener('visibilitychange', vis); };
  }, [phase]);

  /* Takes the name explicitly because `again` starts a session from the
     remembered value before React has flushed it into state. Returns
     whether it worked, so the caller can decide where to land. */
  const start = async (who = name) => {
    setError(null);
    const trimmed = String(who).trim().slice(0, 16);
    if (!trimmed) return false;
    try {
      const r = await fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error); return false; }
      rememberName(trimmed);
      setSessionId(d.sessionId);
      setPhase('ready');
      return true;
    } catch {
      setError('Lost the bench. Have another go.');
      return false;
    }
  };

  /* Ask for a round. The server does not answer until green is due, so
     the moment cannot be pre-computed on this side. */
  const arm = async () => {
    aborted.current = false;
    round.current = null;
    setPhase('wait');
    try {
      const r = await fetch('/api/rounds', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error); return setPhase('error'); }
      round.current = d;
      if (aborted.current) return sendFoul(aborted.current);
      setPhase('go');
    } catch {
      setError('Lost the bench. Have another go.');
      setPhase('error');
    }
  };

  const sendFoul = async (note) => {
    const rd = round.current;
    if (!rd) return;
    round.current = null;
    await fetch(`/api/rounds/${rd.roundId}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goToken: rd.goToken, foul: note }),
    }).catch(() => {});
    setVoids((v) => v + 1);
  };

  const foul = (note) => {
    setLast({ ms: null, note });
    setPhase('foul');
    if (round.current) sendFoul(note); else aborted.current = note;
  };

  const submit = async (ms) => {
    const rd = round.current;
    round.current = null;
    const r = await fetch(`/api/rounds/${rd.roundId}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goToken: rd.goToken, reportedMs: ms }),
    });
    const d = await r.json();

    if (d.status !== 'valid') {
      // A round the wire ate is not a false start, and the readout should
      // not imply it was.
      if (d.fault === 'network') setLost((n) => n + 1);
      else setVoids((v) => v + 1);
      setLast({ ms, note: d.note || d.error || 'rejected' });
      return setPhase('foul');
    }
    const next = [...times, ms];
    setTimes(next);
    setLast({ ms, note: d.note });
    setPhase('shown');
    if (next.length >= ROUNDS) finish();
  };

  const finish = async () => {
    const r = await fetch(`/api/session/${sessionId}/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ synthetic, patchedTimer, focusLost }),
    });
    const d = await r.json();
    if (!r.ok) { setError(d.error); return setPhase('error'); }
    setCert(d);
    setPhase('done');
    loadBoard();
  };

  const tap = (e) => {
    const ne = e.nativeEvent || e;
    const trusted = ne.isTrusted === true;
    if (!trusted) { setSynthetic(true); setCheatPresses((n) => n + 1); }

    if (phase === 'ready' || phase === 'shown') { if (trusted) arm(); return; }
    if (phase === 'foul') { if (trusted) setPhase('ready'); return; }
    if (phase === 'wait') return foul(pick(['too soon!', 'jumped it', 'the green had not even arrived']));
    if (phase !== 'go') return;

    // Browser-stamped, on the performance timeline. Falls back only if the
    // UA gives an epoch value (very old Safari).
    let ts = typeof ne.timeStamp === 'number' ? ne.timeStamp : 0;
    const nowP = performance.now();
    if (!ts || Math.abs(ts - nowP) > 5000) ts = nowP;

    if (!greenAt.current) return foul(pick(['that was before the green', 'you beat the paint to it', 'the pad had not lit yet']));
    const ms = +(ts - greenAt.current).toFixed(1);
    if (!trusted) { round.current && sendFoul('robot tap'); setLast({ ms, note: ROBOT_NOTES[Math.min(cheatPresses, ROBOT_NOTES.length - 1)] }); return setPhase('foul'); }
    submit(ms);
  };

  const wipe = () => {
    setTimes([]); setVoids(0); setLost(0); setCert(null); setLast(null);
    setSynthetic(false); setFocusLost(false); setSessionId(null); setCheatPresses(0);
  };

  /* Five rounds done should not mean filling in a form again. If we know
     who you are, go straight into the next session; only fall back to the
     name screen when we do not, or when opening one failed — the error has
     nowhere else to render. */
  const again = async () => {
    wipe();
    const remembered = (name || readName()).trim();
    if (!remembered) return setPhase('name');
    setName(remembered);
    if (!(await start(remembered))) setPhase('name');
  };

  const changePlayer = () => {
    forgetName();
    wipe();
    setName('');
    setPhase('name');
  };

  const fakeTap = () =>
    pad.current?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

  /* ----------------------------- views ----------------------------- */

  if (phase === 'name') {
    return (
      <main className="wrap" style={{ paddingTop: '4rem' }}>
        <div className="mark">reflex bench</div>
        <h1>Five rounds. Median wins.</h1>
        <p className="dim">
          Two ways to play. Be genuinely quick, or convince the bench that
          you are. Fastest honest thumbs take the top of the board. Everyone
          caught trying it on lands in the wall of shame just underneath,
          which is every bit as public.
        </p>
        <div style={{ marginTop: '2rem' }}>
          <input
            value={name}
            maxLength={16}
            placeholder="Your name — for either list"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && start()}
          />
          <button className="primary" style={{ marginTop: '0.75rem' }}
            disabled={!name.trim()} onClick={() => start()}>
            Go on then
          </button>
        </div>
        {error && <p className="small" style={{ color: 'var(--foul)' }}>{error}</p>}
        <p className="dim small">Nobody has ever scored 1ms. Not for want of trying.</p>
      </main>
    );
  }

  const padText =
    phase === 'go' ? 'NOW!' :
    phase === 'wait' ? 'wait for it…' :
    phase === 'foul' ? (last?.note || 'void') :
    phase === 'shown' ? `${last.ms.toFixed(1)} ms` :
    phase === 'done' ? "that's your five" :
    phase === 'error' ? (error || 'the bench fell over') : 'tap when you are ready';

  return (
    <main className="wrap">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="mark">reflex bench</span>
        <span style={{ display: 'flex', gap: '1rem', alignItems: 'baseline' }}>
          {name && (
            <button className="linkish" onClick={changePlayer}>not {name}?</button>
          )}
          <button className="linkish" onClick={() => setShowBoard((s) => !s)}>
            {showBoard ? 'back to the pad' : 'leaderboard'}
          </button>
        </span>
      </div>

      {showBoard ? <Board board={board} /> : (
        <>
          <div
            ref={pad}
            className={`pad ${phase}`}
            onPointerDown={tap}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === ' ' && tap(e)}
          >
            <div className="read">{padText}</div>
            {phase === 'shown' && last.note && (
              <div className="small" style={{ marginTop: '0.5rem', color: 'var(--brass)' }}>{last.note}</div>
            )}
            {(phase === 'shown' || phase === 'foul') && (
              <div className="small" style={{ marginTop: '0.75rem', opacity: 0.75 }}>tap to carry on</div>
            )}
          </div>

          <div className="chambers">
            {Array.from({ length: ROUNDS }).map((_, i) => {
              const t = times[i];
              return (
                <div key={i} className={`chamber ${t != null ? 'filled' : ''} ${t < SUSPECT ? 'fast' : ''}`}>
                  {t == null ? '·' : Math.round(t)}
                </div>
              );
            })}
          </div>

          {phase === 'done' && cert && <Cert cert={cert} onAgain={again} />}

          <Integrity
            times={times} voids={voids} lost={lost}
            synthetic={synthetic} patchedTimer={patchedTimer} focusLost={focusLost}
          />

          <button className="ghost" style={{ marginTop: '1rem' }} onClick={fakeTap}
            disabled={cheatPresses >= CHEAT_LABELS.length}>
            {cheatPresses >= CHEAT_LABELS.length ? CHEAT_RETIRED : CHEAT_LABELS[cheatPresses]}
          </button>
        </>
      )}
    </main>
  );
}

function Integrity({ times, voids, lost, synthetic, patchedTimer, focusLost }) {
  const sd = times.length >= 2 ? stdev(times) : null;
  const rows = [
    ['the green', 'unguessable', true],
    ['fingers', synthetic ? 'suspiciously robotic' : 'real ones', !synthetic],
    ['clocks', patchedTimer ? 'bent' : 'straight', !patchedTimer],
    ['attention', focusLost ? 'wandered off' : 'on the pad', !focusLost],
    ['human wobble', sd == null ? '—' : `${sd.toFixed(1)} ms`, sd == null || sd >= SD_FLOOR],
    ['itchy taps', String(voids), voids <= 8],
    // Only worth a line when it has actually happened to you.
    ...(lost > 0 ? [['eaten by the wire', `${lost} — not counted`, true]] : []),
  ];
  return (
    <div className="panel">
      {rows.map(([k, v, ok]) => (
        <div className="row" key={k}>
          <span className="k">{k}</span>
          <span className={ok ? '' : 'bad'}>{v}</span>
        </div>
      ))}
    </div>
  );
}

/* X counts a URL as 23 characters however long it is, so the sentence gets
   a budget rather than the whole 280. Flags are player-visible text of
   unknown length, hence the trim. */
const shareUrl = (cert) => {
  const clean = cert.status === 'verified';
  const flags = cert.flags || [];
  const ms = cert.median.toFixed(1);

  let text;
  if (clean) {
    text = `Median ${ms}ms over five rounds on the reflex bench (best ${cert.best.toFixed(1)}ms). Verified, which is the hard part.`;
  } else if (flags.length > 1) {
    const others = flags.length - 1;
    text = `${ms}ms on the reflex bench, thrown out for "${flags[0]}" and ${others} other ${others === 1 ? 'reason' : 'reasons'}.`;
  } else {
    text = `${ms}ms on the reflex bench, thrown out for "${flags[0] || 'reasons it declined to elaborate on'}".`;
  }

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `https://x.com/intent/post?text=${encodeURIComponent(text.slice(0, 240))}` +
         (origin ? `&url=${encodeURIComponent(origin)}` : '');
};

function Cert({ cert, onAgain }) {
  const clean = cert.status === 'verified';
  return (
    <div className={`cert ${clean ? '' : 'bad'}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="dim small">median of five</div>
          <div className="big">{cert.median.toFixed(1)}<span className="unit"> ms</span></div>
        </div>
        <div className="small" style={{ fontFamily: 'var(--mono)', color: clean ? 'var(--go)' : 'var(--foul)' }}>
          {clean ? 'legit' : 'busted'}
        </div>
      </div>
      {cert.flags?.map((f) => (
        <div key={f} className="small" style={{ marginTop: '0.5rem', color: 'var(--foul)' }}>— {f}</div>
      ))}
      {cert.lost > 0 && (
        <div className="dim small" style={{ marginTop: '0.5rem' }}>
          {cert.lost} {cert.lost === 1 ? 'round' : 'rounds'} lost to the connection, and not held against you.
        </div>
      )}
      <button className="primary" style={{ marginTop: '1rem' }} onClick={onAgain}>
        Go again
      </button>
      <a className="ghost-link" style={{ marginTop: '0.5rem' }}
        href={shareUrl(cert)} target="_blank" rel="noopener noreferrer">
        {clean ? 'Post it to X' : 'Post the charge sheet to X'}
      </a>
    </div>
  );
}

function Board({ board }) {
  if (!board) return <p className="dim">Fetching the scores…</p>;
  if (board.down) return <p style={{ color: 'var(--foul)' }}>The board is having a lie down.</p>;
  const { verified = [], rejected = [] } = board;
  return (
    <div style={{ marginTop: '1rem' }}>
      {verified.length === 0 && <p className="dim">No clean runs yet. Open goal.</p>}
      {verified.map((b, i) => (
        <div className="entry" key={i}>
          <span className="rank">{i + 1}</span>
          <span className="who">{b.player_name}</span>
          <span className="sd">±{Number(b.sd_ms).toFixed(1)}</span>
          <span className="ms">{Number(b.median_ms).toFixed(1)}</span>
        </div>
      ))}
      {rejected.length > 0 && (
        <>
          <div className="small" style={{ marginTop: '1.5rem', color: 'var(--foul)' }}>
            Wall of shame — nobody gets quietly deleted
          </div>
          {rejected.map((b, i) => (
            <div key={i} style={{ padding: '0.6rem 0', borderBottom: '1px solid var(--line)' }}>
              <span className="struck">{b.player_name} — {Number(b.median_ms).toFixed(1)} ms</span>
              {(b.flags || []).map((f, j) => (
                <div key={j} className="small" style={{ color: 'var(--foul)' }}>— {f}</div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
