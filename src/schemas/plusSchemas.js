import { z } from 'zod';

/** POST /plus/checkout — il client sceglie solo il piano, mai il prezzo. */
export const plusCheckoutSchema = z.object({
  plan: z.enum(['week', 'month', 'year']),
});

/**
 * POST /plus/google/verify — il token che Google Play dà all'app. Si controlla
 * solo la forma: cosa vale lo dice la Developer API.
 */
export const plusGoogleVerifySchema = z.object({
  purchase_token: z.string().min(10).max(4096),
});
