import { z } from 'zod';

/** POST /plus/checkout — il client sceglie solo il piano, mai il prezzo. */
export const plusCheckoutSchema = z.object({
  plan: z.enum(['week', 'month', 'year']),
});
