import { z } from 'zod';

const tier = z.enum(['3d', '7d', '30d']);

/** Exactly one target: an event you created, or a bar you claimed. */
const oneTarget = (v) => !!v.event_id !== !!v.bar_id;
const oneTargetMessage = { message: 'Serve esattamente uno tra event_id e bar_id' };

const targetSchema = z
  .object({
    tier,
    event_id: z.string().uuid().optional(),
    bar_id: z.string().uuid().optional(),
  })
  .refine(oneTarget, oneTargetMessage);

export const boostCheckoutSchema = targetSchema;

/** POST /boosts/apple/order — same body as the Stripe checkout. */
export const appleOrderSchema = targetSchema;

/**
 * POST /boosts/apple/verify — the raw JWS handed over by StoreKit.
 *
 * Only the shape is checked here; the signature, the bundle id and the
 * environment are verified against Apple's root certificates in
 * `lib/appleIap.js`. The length cap keeps a bad client from making the verifier
 * chew through megabytes.
 */
export const appleVerifySchema = z.object({
  signed_transaction: z.string().min(20).max(20_000),
});
