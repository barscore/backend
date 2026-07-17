import { z } from 'zod';

// Public "segnala un bar" form. Anyone (signed in or not) can submit; the
// backend attaches the user id when a valid session is present. Kept small on
// purpose — it's a lead for staff to add the venue, not a full bar record.
export const createSuggestionSchema = z.object({
  name: z.string().trim().min(2).max(120),
  city: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
  // Optional contact so staff can follow up (email or anything short).
  contact: z.string().trim().max(160).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

// Admin list filter.
export const listSuggestionsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['new', 'done', 'rejected']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Admin status change.
export const updateSuggestionSchema = z.object({
  status: z.enum(['new', 'done', 'rejected']),
});
