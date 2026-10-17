import { z } from 'zod';

// Da dove può arrivare ogni tipo di evento. Una scansione viene per forza dal
// QR o dal tag NFC del locale; i pulsanti non hanno provenienza.
const SOURCES_BY_KIND = {
  scan: ['qr', 'nfc'],
  view: ['map', 'list', 'search', 'link', 'qr', 'nfc'],
  directions: [],
  call: [],
  website: [],
};

const eventSchema = z
  .object({
    bar_id: z.string().uuid(),
    kind: z.enum(['scan', 'view', 'directions', 'call', 'website']),
    source: z.enum(['qr', 'nfc', 'map', 'list', 'search', 'link']).optional(),
  })
  .refine(
    (e) => (e.source ? SOURCES_BY_KIND[e.kind].includes(e.source) : e.kind !== 'scan'),
    { message: 'source non valida per questo tipo di evento', path: ['source'] },
  );

export const statsEventsSchema = z.object({
  // UUID casuale generato dal client e tenuto in locale: identifica il
  // dispositivo, non la persona.
  visitor_id: z.string().uuid(),
  events: z.array(eventSchema).min(1).max(20),
});

export const statsPingSchema = z.object({
  visitor_id: z.string().uuid(),
});

export const barStatsQuerySchema = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), 'days: 7, 30 o 90').default(30),
});
