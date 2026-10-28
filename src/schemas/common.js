import { z } from 'zod';
import { sanitizeHttpUrl } from '../lib/url.js';

const uuidSchema = z.string().uuid();

// Every entity PK in the schema is a UUID, so any :id/:rid/:barId path param
// must parse as one. Parsing here turns a malformed id into a clean 400
// VALIDATION_ERROR (via the central ZodError handler) instead of a Postgres
// 22P02 surfacing as a generic 500.
export function uuidParam(c, name = 'id') {
  return uuidSchema.parse(c.req.param(name));
}

// Escape LIKE wildcards (and the escape char itself) in user input so "%" / "_"
// match literally: a bare "%%%%" would otherwise force a full unindexed scan.
export const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

// For PostgREST .or() strings: also strip its metacharacters — a "," or ")"
// would otherwise be parsed as extra filter conditions (filter injection).
export const orSafeLike = (s) => escapeLike(s.replace(/[,()]/g, ' ').trim());

// Un URL che finisce in un href o in un <img>: solo http(s), salvato nella
// forma normalizzata. `z.string().url()` da solo non basta: accetta qualsiasi
// cosa `new URL` sappia leggere, `javascript:alert(1)` compreso, che in un
// link esegue codice sul sito di chi lo tocca.
export const httpUrl = (max = 2000) =>
  z
    .string()
    .max(max)
    .refine((v) => sanitizeHttpUrl(v) !== null, { message: 'Serve un indirizzo http:// o https://' })
    .transform((v) => sanitizeHttpUrl(v));

// I servizi push dei browser (Chrome/Edge/Samsung via FCM, Firefox, Safari,
// Edge su Windows). Il backend fa una POST a ogni endpoint registrato: senza
// questa lista un utente poteva registrare un URL qualsiasi e far chiamare al
// server indirizzi a sua scelta (SSRF), a ogni notifica.
const PUSH_HOSTS = ['googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function isPushEndpoint(v) {
  try {
    const u = new URL(v);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
