import { z } from 'zod';
import { httpUrl } from './common.js';

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
  website: httpUrl().optional(),
  opening_hours: z.record(z.string()).optional(),
  cover_image_url: httpUrl().optional(),
});

export const updateBarSchema = createBarSchema.partial().extend({
  is_active: z.boolean().optional(),
  accepts_free_drinks: z.boolean().optional(),
  free_drinks_hours: z.string().nullable().optional(),
});

// Lives in lib/url.js now — lib/osm.js sanitizes the raw OSM tags too, and a
// lib importing from schemas/ would be the wrong direction. Re-exported here so
// the existing callers (routes/bars.js) keep their import path.
export { sanitizeHttpUrl } from '../lib/url.js';

// Find-or-create a bar from an OpenStreetMap place. Only the OSM id and the
// coordinates are used (to find the cached tile): the bar's details always
// come from our tiles or Overpass (routes/bars.js#trustedPlace). The other
// fields are still accepted so older app builds that send them don't 400.
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
