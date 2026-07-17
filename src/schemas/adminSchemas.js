import { z } from 'zod';

// --- Users ---------------------------------------------------------------
export const listUsersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(['user', 'betatester', 'moderator', 'admin', 'organizer']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const suspendSchema = z.object({
  // How long to suspend, in hours (1h .. 1 year). Account is locked out until
  // now + hours; enforced by requireAuth.
  hours: z.coerce.number().int().min(1).max(24 * 365),
  reason: z.string().trim().max(500).optional(),
});

export const banSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const roleSchema = z
  .object({
    role: z.enum(['user', 'betatester', 'moderator', 'admin', 'organizer']),
    organizer_type: z.enum(['pr', 'organizzatore', 'proprietario']).optional(),
  })
  .refine((v) => v.role !== 'organizer' || !!v.organizer_type, {
    message: 'organizer_type richiesto per il ruolo organizer',
    path: ['organizer_type'],
  });

// --- Settings (security + emergency switches) ----------------------------
export const settingsSchema = z
  .object({
    registration_open: z.boolean().optional(),
    ratings_enabled: z.boolean().optional(),
    maintenance_mode: z.boolean().optional(),
    maintenance_reason: z.string().trim().max(500).nullable().optional(),
    maintenance_eta: z.string().datetime({ offset: true }).nullable().optional(),
    // Beta program: app locked for everyone except admin/moderator/betatester.
    beta_mode: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No settings provided' });

// --- Ratings -------------------------------------------------------------
export const listRatingsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
