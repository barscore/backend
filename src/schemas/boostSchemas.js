import { z } from 'zod';

export const boostCheckoutSchema = z
  .object({
    tier: z.enum(['3d', '7d', '30d']),
    event_id: z.string().uuid().optional(),
    bar_id: z.string().uuid().optional(),
  })
  .refine((v) => !!v.event_id !== !!v.bar_id, {
    message: 'Serve esattamente uno tra event_id e bar_id',
  });
