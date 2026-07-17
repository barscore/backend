import { z } from 'zod';

// Reuse the same coercing lat/lng/radius query shape as bars.
export const nearbyEventsQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radius_km: z.coerce.number().positive().max(100).optional().default(2),
});

// Events are added by hand for a venue. `bar_id` ties the event to a locale and
// backfills lat/lng from that bar; a standalone event may pass its own coords.
export const createEventSchema = z
  .object({
    bar_id: z.string().uuid().optional(),
    title: z.string().min(2).max(120),
    description: z.string().max(1000).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    starts_at: z.string().datetime({ offset: true }),
    ends_at: z.string().datetime({ offset: true }).optional(),
  })
  .refine((e) => e.bar_id || (e.lat != null && e.lng != null), {
    message: 'Provide bar_id or lat/lng',
  })
  .refine((e) => !e.ends_at || e.ends_at >= e.starts_at, {
    message: 'ends_at must be at or after starts_at',
    path: ['ends_at'],
  });

export const updateEventSchema = z
  .object({
    title: z.string().min(2).max(120).optional(),
    description: z.string().max(1000).optional().nullable(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    starts_at: z.string().datetime({ offset: true }).optional(),
    ends_at: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .refine((e) => Object.keys(e).length > 0, { message: 'Empty update' });
