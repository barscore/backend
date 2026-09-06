import { z } from 'zod';
export const updateProfileSchema = z.object({
  username: z.string().min(3).max(30).optional(),
  instagram_username: z.string().max(30).optional().nullable(),
  whatsapp_number: z.string().max(20).optional().nullable(),
});
