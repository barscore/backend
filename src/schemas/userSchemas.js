import { z } from 'zod';
export const updateProfileSchema = z.object({
  username: z.string().min(3).max(30).optional(),
  // Finiscono in link (instagram.com/<u>, wa.me/<n>): solo il formato valido.
  // Stringa vuota = cancella il campo.
  instagram_username: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().replace(/^@/, '') || null : v),
    z.string().regex(/^[A-Za-z0-9._]{1,30}$/, 'Username Instagram non valido').nullable().optional(),
  ),
  whatsapp_number: z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/[\s\-().]/g, '') || null : v),
    z.string().regex(/^\+?[1-9]\d{7,14}$/, 'Numero WhatsApp non valido (con prefisso, es. +393331234567)').nullable().optional(),
  ),
});
