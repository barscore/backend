import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { uuidParam } from '../schemas/common.js';

// Public user profiles: the leaderboard/riconoscimenti profile popup and the
// credits page. Only safe columns — never email or auth data.
const users = new Hono();

const PUBLIC_COLS = 'id, username, avatar_url, role, organizer_type, created_at';
const FOUNDER_USERNAME = 'mar7yyy';

/** GET /users/credits — founder + admins + beta testers (Riconoscimenti page).
 *  Registered before /:id so "credits" never hits the uuid param check. */
users.get('/credits', async (c) => {
  const { data, error } = await supabase
    .from('profiles')
    .select(PUBLIC_COLS)
    .or(`role.in.(admin,betatester),username.eq.${FOUNDER_USERNAME}`)
    .order('username', { ascending: true });
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load credits');
  const all = data ?? [];
  const founder = all.find((p) => p.username === FOUNDER_USERNAME) ?? null;
  return c.json({
    founder,
    admins: all.filter((p) => p.role === 'admin' && p.username !== FOUNDER_USERNAME),
    betatesters: all.filter((p) => p.role === 'betatester' && p.username !== FOUNDER_USERNAME),
  });
});

/** GET /users/:id — public profile with derived ice cubes (10 per rating,
 *  same derivation as GET /me — never stored, so it can't drift). */
users.get('/:id', async (c) => {
  const id = uuidParam(c);

  const { data: profile, error } = await supabase
    .from('profiles')
    .select(PUBLIC_COLS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load profile');
  if (!profile) throw new AppError(404, 'NOT_FOUND', 'Profile not found');

  const { count } = await supabase
    .from('ratings')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', id);
  const ratingsCount = count ?? 0;

  return c.json({
    profile: {
      ...profile,
      ratings_count: ratingsCount,
      ice_cubes: ratingsCount * 10,
      is_founder: profile.username === FOUNDER_USERNAME,
    },
  });
});

export default users;
