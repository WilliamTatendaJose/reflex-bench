'use client';

import { useState, useEffect, useLayoutEffect, useRef } from 'react';

const ROUNDS = 5;
const SUSPECT = 130;

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
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

export default function Page() {
  const [phase, setPhase] = useState('name'); // name|ready|wait|go|settling|submitting|shown|foul|done|error
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

  const operation = useRef(false);
  const generation = useRef(0);
  const retry = useRef(null);
  const greenAt = useRef(0);
  const round = useRef(null);
  const aborted = useRef(false);
  const pad = useRef(null);

  useEffect(() => { loadBoard(); const n = readName(); if (n) setName(n); }, []);
  const loadBoard = async () => {
    try { const r = await fetch('/api/leaderboard'); if (!r.ok) throw new Error(); setBoard(await r.json()); }
    catch { setBoard({ verified: [], rejected: [], down: true }); }
  };

  /* rAF approximates the presentation frame; browsers do not expose the
     exact instant the display emits the green pixels. */
  useLayoutEffect(() => {
    if (phase !== 'go' || operation.current || !round.current) return;
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

  const post = async (url, body) => {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'The request failed. Try again.');
    return data;
  };

  const start = async (who = name) => {
    if (operation.current) return false;
    const trimmed = String(who).trim().slice(0, 16);
    if (!trimmed) return false;
    operation.current = true;
    const version = generation.current;
    setError(null);
    try {
      const d = await post('/api/session', { name: trimmed });
      if (version !== generation.current) return false;
      rememberName(trimmed);
      setSessionId(d.sessionId);
      setPhase('ready');
      return true;
    } catch (e) {
      if (version === generation.current) setError(e.message || 'Lost the bench. Try again.');
      return false;
    } finally {
      if (version === generation.current) operation.current = false;
    }
  };

  // One synchronous lock covers each request; generations discard responses
  // from a session that the player has left. Retries retain the original payload.
  const settle = async (rd, payload) => {
    if (operation.current) return;
    operation.current = true;
    setPhase('submitting');
    setError(null);
    const version = generation.current;
    retry.current = () => settle(rd, payload);
    try {
      const d = await post(`/api/rounds/${rd.roundId}/result`, { goToken: rd.goToken, ...payload });
      if (version !== generation.current) return;
      retry.current = null;
      round.current = null;
      operation.current = false;
      if (d.status !== 'valid') {
        if (d.fault === 'network') setLost((n) => n + 1);
        else setVoids((n) => n + 1);
        setLast({ ms: d.ms, note: d.note || 'Round not counted.' });
        setPhase('foul');
        return;
      }
      const next = [...times, d.ms];
      setTimes(next);
      setLast({ ms: d.ms, note: d.note });
      if (next.length >= ROUNDS) await finish();
      else setPhase('shown');
    } catch (e) {
      if (version === generation.current) {
        setError(e.message || 'Connection lost. Retry saving this round.');
        setPhase('error');
      }
    } finally {
      if (version === generation.current) operation.current = false;
    }
  };

  const arm = async () => {
    if (operation.current) return;
    operation.current = true;
    aborted.current = false;
    round.current = null;
    retry.current = null;
    setPhase('wait');
    const version = generation.current;
    try {
      const d = await post('/api/rounds', { sessionId });
      if (version !== generation.current) return;
      round.current = d;
      operation.current = false;
      if (aborted.current) return settle(d, { foul: aborted.current });
      setPhase('go');
    } catch (e) {
      if (version === generation.current) {
        setError(`${e.message} Start a new session if the round could not be opened.`);
        setPhase('error');
        operation.current = false;
      }
    }
  };

  const foul = (note) => {
    if (aborted.current || phase === 'submitting') return;
    aborted.current = note;
    setLast({ ms: null, note });
    if (round.current) settle(round.current, { foul: note });
    else setPhase('settling'); // keep retries locked until the held request returns
  };

  const finish = async () => {
    if (operation.current) return;
    operation.current = true;
    const version = generation.current;
    setPhase('submitting');
    setError(null);
    retry.current = finish;
    try {
      const d = await post(`/api/session/${sessionId}/finish`, { synthetic, patchedTimer, focusLost });
      if (version !== generation.current) return;
      retry.current = null;
      setCert(d);
      setPhase('done');
      loadBoard();
    } catch (e) {
      if (version === generation.current) {
        setError(e.message || 'Connection lost. Retry saving your session.');
        setPhase('error');
      }
    } finally {
      if (version === generation.current) operation.current = false;
    }
  };

  const tap = (e) => {
    if (e.repeat) return;
    if (e.type === 'keydown') e.preventDefault();
    const ne = e.nativeEvent || e;
    const trusted = ne.isTrusted === true;
    if (!trusted) { setSynthetic(true); setCheatPresses((n) => n + 1); }

    if (phase === 'ready' || phase === 'shown') { if (trusted && !operation.current) arm(); return; }
    if (phase === 'foul') { if (trusted) setPhase('ready'); return; }
    if (phase === 'wait') return foul(pick(['too soon!', 'jumped it', 'the green had not even arrived']));
    if (phase !== 'go' || operation.current || !round.current) return;

    // Browser-stamped, on the performance timeline. Falls back only if the
    // UA gives an epoch value (very old Safari).
    let ts = typeof ne.timeStamp === 'number' ? ne.timeStamp : 0;
    const nowP = performance.now();
    if (!ts || Math.abs(ts - nowP) > 5000) ts = nowP;

    if (!greenAt.current) return foul(pick(['that was before the green', 'you beat the paint to it', 'the pad had not lit yet']));
    const ms = +(ts - greenAt.current).toFixed(1);
    if (!trusted) return foul('Synthetic tap detected.');
    settle(round.current, { reportedMs: ms });
  };

  const wipe = () => {
    generation.current += 1;
    operation.current = false;
    round.current = null;
    retry.current = null;
    aborted.current = false;
    setError(null);
    setShowBoard(false);
    setTimes([]); setVoids(0); setLost(0); setCert(null); setLast(null);
    setSynthetic(false); setFocusLost(false); setSessionId(null); setCheatPresses(0);
  };

  /* Five rounds done should not mean filling in a form again. If we know
     who you are, go straight into the next session; only fall back to the
     name screen when we do not, or when opening one failed — the error has
     nowhere else to render. */
  const again = async () => {
    if (operation.current) return;
    wipe();
    const version = generation.current;
    const remembered = (name || readName()).trim();
    if (!remembered) return setPhase('name');
    setName(remembered);
    const started = await start(remembered);
    if (!started && version === generation.current) setPhase('name');
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
          Wait for green, then tap. Your median over five rounds goes on the
          leaderboard if it passes the timing and input checks. Passing checks
          does not prove a human played. Unranked results are also public.
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
    phase === 'settling' ? 'settling…' :
    phase === 'submitting' ? 'saving…' :
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
          <button className="linkish" disabled={['wait', 'go', 'settling', 'submitting'].includes(phase)} onClick={() => setShowBoard((s) => !s)}>
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
            onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && tap(e)}
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

          {phase === 'error' && (
            <div>
              {retry.current && <button className="primary" onClick={() => retry.current?.()}>Retry saving</button>}
              <button className="ghost" onClick={again}>Start a new session</button>
            </div>
          )}
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
    ['the green', 'server-timed', true],
    ['fingers', synthetic ? 'suspiciously robotic' : 'no synthetic input reported', !synthetic],
    ['clocks', patchedTimer ? 'bent' : 'straight', !patchedTimer],
    ['attention', focusLost ? 'wandered off' : 'on the pad', !focusLost],
    ['human wobble', sd == null ? '—' : `${sd.toFixed(1)} ms`, true],
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
    text = `Median ${ms}ms over five rounds on the reflex bench (best ${cert.best.toFixed(1)}ms). Passed integrity checks.`;
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
          {clean ? 'passed checks' : 'not ranked'}
        </div>
      </div>
      <p className="dim small">Timing and input checks cannot prove human play.</p>
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
        {clean ? 'Post it to X' : 'Post result to X'}
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
            Unranked sessions — checks did not pass
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
