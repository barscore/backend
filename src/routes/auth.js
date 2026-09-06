import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { createClient } from '@supabase/supabase-js';

const auth = new Hono();

// POST /auth/login — authenticates via email or username
auth.post('/login', async (c) => {
  const { login, password } = await c.req.json();
  if (!login || !password) throw new AppError(400, 'BAD_REQUEST', 'Email/Username e password sono richiesti');

  let email = login;

  // Se non è un'email, consideralo un username
  if (!login.includes('@')) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', login)
      .maybeSingle();

    if (!profile) {
      throw new AppError(400, 'BAD_REQUEST', 'Credenziali non valide');
    }

    const { data: user, error: userError } = await supabase.auth.admin.getUserById(profile.id);
    if (userError || !user || !user.user) {
      throw new AppError(400, 'BAD_REQUEST', 'Credenziali non valide');
    }
    
    email = user.user.email;
  }

  // Creiamo un client anonimo per non sporcare la sessione del service_role
  const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
  if (error) {
    throw new AppError(400, 'BAD_REQUEST', error.message || 'Credenziali non valide');
  }

  return c.json({ session: data.session });
});

export default auth;
