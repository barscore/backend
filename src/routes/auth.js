import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { sharedRateLimiter } from '../middleware/rateLimiter.js';
import { createClient } from '@supabase/supabase-js';

const auth = new Hono();

const loginSchema = z.object({
  login: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(256),
});

// Ogni fallimento risponde uguale e non prima di questo tempo: username
// inesistente, email sconosciuta e password sbagliata non si distinguono né
// dal messaggio né dalla latenza (il ramo username fa una query e una chiamata
// admin in più).
const FAIL_MIN_MS = 1000;

async function fail(started) {
  const wait = FAIL_MIN_MS - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenziali non valide');
}

// Due limiti: per IP (credential stuffing da una macchina) e per account
// (brute force distribuito su tante macchine contro uno username).
const perIp = sharedRateLimiter({ windowMs: 60_000, max: 10, key: 'auth-login' });
const perAccount = sharedRateLimiter({
  windowMs: 15 * 60_000,
  max: 10,
  key: 'auth-login-acct',
  by: async (c) => {
    const body = await c.req.json().catch(() => null);
    return typeof body?.login === 'string' ? body.login.trim().toLowerCase().slice(0, 254) : '';
  },
});

// POST /auth/login — authenticates via email or username
auth.post('/login', perIp, perAccount, async (c) => {
  const started = Date.now();
  const { login, password } = loginSchema.parse(await c.req.json());

  let email = login;

  // Se non è un'email, consideralo un username
  if (!login.includes('@')) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', login)
      .maybeSingle();
    if (!profile) return fail(started);

    const { data: user, error: userError } = await supabase.auth.admin.getUserById(profile.id);
    if (userError || !user?.user?.email) return fail(started);

    email = user.user.email;
  }

  // Creiamo un client anonimo per non sporcare la sessione del service_role
  const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
  if (error) return fail(started);

  return c.json({ session: data.session });
});

export default auth;
