import { supabase } from '../lib/supabase.js';
import { AppError } from './errorHandler.js';

// Verifies the Supabase access token (Bearer) and attaches the user to context.
// Works for email/password and OAuth (Google) sessions alike.
export async function requireAuth(c, next) {
  const header = c.req.header('Authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header');
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
  }

  // Enforce moderation state: banned users are locked out entirely; suspended
  // users are locked out until suspended_until passes. Role stays lazy
  // (loaded by requireRole), but we already touch profiles here for the ban
  // check, so cache it on context to save requireRole a round-trip.
  const { data: prof } = await supabase
    .from('profiles')
    .select('role, banned, suspended_until')
    .eq('id', data.user.id)
    .maybeSingle();

  if (prof?.banned) {
    throw new AppError(403, 'BANNED', 'Account bannato');
  }
  if (prof?.suspended_until && new Date(prof.suspended_until) > new Date()) {
    throw new AppError(
      403,
      'SUSPENDED',
      `Account sospeso fino al ${new Date(prof.suspended_until).toLocaleString('it-IT')}`,
    );
  }

  c.set('user', { id: data.user.id, email: data.user.email, role: prof?.role });
  await next();
}

// Best-effort auth: return the user id when a valid Bearer token is present,
// null otherwise. Never rejects — for public routes that just want to attach
// the author when one exists (suggestions, drink proposals).
export async function optionalUser(c) {
  const header = c.req.header('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  const { data } = await supabase.auth.getUser(token);
  return data?.user?.id ?? null;
}

// Restricts a route to the given roles. Use after requireAuth.
// Fetches the caller's role from profiles (Supabase JWT carries no app role).
export function requireRole(...roles) {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Not authenticated');

    // requireAuth already loaded the role; fall back to a fetch if missing.
    let role = user.role;
    if (role === undefined) {
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();
      if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not verify role');
      role = data?.role;
    }

    if (!role || !roles.includes(role)) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
    }

    c.set('user', { ...user, role });
    await next();
  };
}
