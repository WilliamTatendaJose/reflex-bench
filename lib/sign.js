import crypto from 'node:crypto';

const secret = () => {
  const s = process.env.SIGNING_SECRET;
  if (!s || s === 'replace_me') throw new Error('SIGNING_SECRET is not set');
  return s;
};

const hmac = (msg) =>
  crypto.createHmac('sha256', secret()).update(msg).digest('base64url');

/**
 * Proves that the server itself released the "go" for this round at this
 * instant. A client that never received a go cannot mint one, so results
 * for rounds that were never started are rejected before touching the DB.
 */
export const mintGoToken = (roundId, goSentAtMs) => {
  const body = `${roundId}.${goSentAtMs}`;
  return `${body}.${hmac(body)}`;
};

export const readGoToken = (token) => {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [roundId, ts, sig] = parts;
  const expected = hmac(`${roundId}.${ts}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { roundId, goSentAtMs: Number(ts) };
};

export const hashIp = (ip) =>
  crypto.createHmac('sha256', secret()).update(String(ip || 'unknown')).digest('hex').slice(0, 32);

export const clientIp = (req) =>
  req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
  req.headers.get('x-real-ip') ||
  'unknown';
