import { z } from 'zod';

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
