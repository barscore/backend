import { z } from 'zod';

export const CHANNELS = [
  'instagram',
  'facebook',
  'x',
  'telegram',
  'whatsapp',
  'tiktok',
  'volantinaggio',
  'altro',
];

export const createOrganizerRequestSchema = z
  .object({
    requested_type: z.enum(['pr', 'organizzatore', 'proprietario']),
    proof: z.string().trim().min(10).max(1000),
    channels: z.array(z.enum(CHANNELS)).min(1),
    channels_other: z.string().trim().min(1).max(200).optional(),
    collaborations: z.string().trim().min(5).max(1000),
  })
  .refine((v) => !v.channels.includes('altro') || !!v.channels_other, {
    message: 'Descrivi il canale "altro"',
    path: ['channels_other'],
  });

export const createClaimSchema = z.object({
  proof: z.string().trim().min(10).max(1000),
});

export const reviewSchema = z.object({
  admin_note: z.string().trim().max(500).optional(),
});
