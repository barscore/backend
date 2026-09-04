import { supabase } from './supabase.js';

// Append one row to the staff action log (`admin_audit`, add_admin_audit.sql).
//
// `action` is a stable dotted string ('user.ban', 'rating.delete', …) so the log
// stays greppable, and `payload` carries only what is needed to reconstruct the
// decision later — reason, duration, old and new value. Best-effort by design:
// a failed audit row must never fail the write that triggered it.
export async function audit(actorId, action, { targetType = null, targetId = null, payload = null } = {}) {
  try {
    const { error } = await supabase.from('admin_audit').insert({
      actor_id: actorId,
      action,
      target_type: targetType,
      target_id: targetId,
      payload,
    });
    if (error) console.error('[audit] insert failed:', error.message);
  } catch (e) {
    console.error('[audit] insert failed:', e.message);
  }
}
