import { z } from 'zod';

export const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radius_km: z.coerce.number().positive().max(100).optional().default(2),
});

export const createBarSchema = z.object({
  name: z.string().min(2).max(100),
  address: z.string().min(1),
  city: z.string().min(1),
  country: z.string().length(2).optional().default('IT'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  google_place_id: z.string().optional(),
  osm_node_id: z.number().int().optional(),
  phone: z.string().optional(),
  website: z.string().url().optional(),
  opening_hours: z.record(z.string()).optional(),
  cover_image_url: z.string().url().optional(),
});

export const updateBarSchema = createBarSchema.partial().extend({
  is_active: z.boolean().optional(),
});

// Keep only well-formed http(s) URLs; anything else (javascript:, data:,
// malformed OSM tags) becomes null. Used at the /bars/resolve insert instead of
// schema-level .url() because raw OSM tags are frequently malformed and a bad
// tag must not reject the whole bar.
export function sanitizeHttpUrl(v) {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// Find-or-create a bar from an OpenStreetMap place. Fields beyond the OSM id
// are optional hints from the client; anything missing is backfilled from
// Overpass server-side. `website`/`cover_image_url` are sanitized (not
// rejected) at insert time via sanitizeHttpUrl.
export const resolveBarSchema = z.object({
  osm_node_id: z.coerce.number().int(),
  osm_type: z.enum(['node', 'way', 'relation']).optional().default('node'),
  name: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  lat: z.coerce.number().min(-90).max(90).optional().nullable(),
  lng: z.coerce.number().min(-180).max(180).optional().nullable(),
  phone: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  cover_image_url: z.string().optional().nullable(),
});
