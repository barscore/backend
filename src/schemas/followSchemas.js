import { z } from 'zod';

// Exactly one target: an event (reminder + updates) XOR an organizer
// (their new events).
export const followTargetSchema = z
  .object({
    event_id: z.string().uuid().optional(),
    organizer_id: z.string().uuid().optional(),
  })
  .refine((v) => !!v.event_id !== !!v.organizer_id, {
    message: 'Serve esattamente uno tra event_id e organizer_id',
  });
