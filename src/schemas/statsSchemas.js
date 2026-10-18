import { z } from 'zod';

// Da dove può arrivare ogni tipo di evento. Una scansione viene per forza dal
// QR o dal tag NFC del locale; i pulsanti, la recensione e la registrazione
// non hanno provenienza.
const SOURCES_BY_KIND = {
  scan: ['qr', 'nfc'],
  view: ['map', 'list', 'search', 'link', 'qr', 'nfc'],
  directions: [],
  call: [],
  website: [],
  review: [],
  signup: [],
};

const eventSchema = z
  .object({
    // Assente solo per signup, che non riguarda un bar.
    bar_id: z.string().uuid().optional(),
    kind: z.enum(['scan', 'view', 'directions', 'call', 'website', 'review', 'signup']),
    source: z.enum(['qr', 'nfc', 'map', 'list', 'search', 'link']).optional(),
  })
  .refine(
    (e) => (e.source ? SOURCES_BY_KIND[e.kind].includes(e.source) : e.kind !== 'scan'),
    { message: 'source non valida per questo tipo di evento', path: ['source'] },
  )
  .refine((e) => (e.kind === 'signup') === !e.bar_id, {
    message: 'bar_id obbligatorio, tranne che per signup',
    path: ['bar_id'],
  });

export const statsEventsSchema = z.object({
  // UUID casuale generato dal client e tenuto in locale: identifica il
  // dispositivo, non la persona, e non viene mai legato a un account.
  visitor_id: z.string().uuid(),
  events: z.array(eventSchema).min(1).max(20),
});

export const barStatsQuerySchema = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), 'days: 7, 30 o 90').default(30),
});
