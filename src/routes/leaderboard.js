import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

// Public ice-cube leaderboard: every user ranked by accumulated ice cubes
// (10 per rating). Aggregation lives in the get_leaderboard Postgres RPC — never
// computed in JS — so it stays in sync with the ratings table.
const leaderboard = new Hono();

leaderboard.get('/', async (c) => {
  const { data, error } = await supabase.rpc('get_leaderboard', { limit_count: 100 });
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load leaderboard');
  return c.json({ leaderboard: data ?? [] });
});

export default leaderboard;
