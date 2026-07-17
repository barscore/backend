import { z } from 'zod';

export const createRatingSchema = z.object({
  prezzo: z.number().int().min(1).max(5),
  qualita_drinks: z.number().int().min(1).max(5),
  socialita: z.number().int().min(1).max(5),
  varieta: z.number().int().min(1).max(5),
  orari: z.number().int().min(1).max(5),
  commento: z.string().max(500).optional(),
});

// All fields optional on update, but at least one must be present.
export const updateRatingSchema = createRatingSchema
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' });

export const listRatingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
