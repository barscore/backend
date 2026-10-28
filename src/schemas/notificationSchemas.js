import { z } from 'zod';
import { isPushEndpoint } from './common.js';

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// { all: true } marks everything read; { ids } marks a specific batch.
export const markReadSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }),
]);

export const pushSubscribeSchema = z.object({
  endpoint: z.string().max(1000).refine(isPushEndpoint, { message: 'Endpoint push non valido' }),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(100),
  }),
});

export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
});
