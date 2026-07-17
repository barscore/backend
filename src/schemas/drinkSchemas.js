import { z } from 'zod';

// Public catalog list, with the drinks-only search (q).
export const listDrinksQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Rankings: top bars for a drink / top drinks at a bar. lat/lng (optional,
// used by /drinks/:id/bars only) restrict the ranking to nearby bars.
export const listTopQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

// GET /me/drink-votes filter (prefill "your vote" in the UI).
export const myDrinkVotesQuerySchema = z.object({
  drink_id: z.string().uuid().optional(),
  bar_id: z.string().uuid().optional(),
});

// Single 1-5 vote for a drink at a bar (upserted on the unique key).
export const createDrinkVoteSchema = z.object({
  bar_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
});

// Public "proponi un drink" form — a lead for staff, materialized into the
// catalog only on approval.
export const createDrinkSuggestionSchema = z.object({
  name: z.string().trim().min(2).max(80),
  note: z.string().trim().max(300).optional(),
});

// Staff moderation list filter.
export const listDrinkSuggestionsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['new', 'done', 'rejected']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Staff status change.
export const updateDrinkSuggestionSchema = z.object({
  status: z.enum(['new', 'done', 'rejected']),
});
