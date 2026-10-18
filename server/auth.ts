import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// Optional single-password login. Without APP_PASSWORD (local use) everything is open.
const COOKIE = 'mm_session';
const MAX_AGE_DAYS = 30;

const password = () => process.env.APP_PASSWORD ?? '';
export const authRequired = () => password().length > 0;

const key = () => crypto.createHash('sha256').update(`${password()}|${process.env.AUTH_SECRET ?? 'menet-mester'}`).digest();
const sign = (payload: string) => crypto.createHmac('sha256', key()).update(payload).digest('base64url');

function token() {
  const exp = Date.now() + MAX_AGE_DAYS * 864e5;
  return `${exp}.${sign(String(exp))}`;
}

function valid(value: string | undefined) {
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

function cookieOf(req: Request) {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const secure = () => process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

function setCookie(res: Response, value: string, maxAge: number) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure() ? '; Secure' : ''}`);
}

export const isAuthenticated = (req: Request) => !authRequired() || valid(cookieOf(req));

export async function login(req: Request, res: Response) {
  const given = String((req.body as { password?: string })?.password ?? '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(password()).digest();
  if (!authRequired() || !crypto.timingSafeEqual(a, b)) {
    await new Promise((r) => setTimeout(r, 700)); // slow down guessing
    return res.status(401).json({ error: 'Hibás jelszó' });
  }
  setCookie(res, token(), MAX_AGE_DAYS * 86400);
  res.json({ ok: true });
}

export function logout(_req: Request, res: Response) {
  setCookie(res, '', 0);
  res.json({ ok: true });
}

/** Blocks every API call except the login endpoints until the password was given. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Bejelentkezés szükséges', auth: true });
}
