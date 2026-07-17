import { z } from 'zod';

const uuidSchema = z.string().uuid();

// Every entity PK in the schema is a UUID, so any :id/:rid/:barId path param
// must parse as one. Parsing here turns a malformed id into a clean 400
// VALIDATION_ERROR (via the central ZodError handler) instead of a Postgres
// 22P02 surfacing as a generic 500.
export function uuidParam(c, name = 'id') {
  return uuidSchema.parse(c.req.param(name));
}
