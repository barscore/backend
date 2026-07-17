import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

// Throw this for any controlled error path.
export class AppError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const CODE_BY_STATUS = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
};

// Centralized error handler registered via app.onError.
export function errorHandler(err, c) {
  if (err instanceof ZodError) {
    return c.json(
      {
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      400,
    );
  }

  if (err instanceof AppError) {
    return c.json(
      { error: err.message, code: err.code, statusCode: err.statusCode },
      err.statusCode,
    );
  }

  if (err instanceof HTTPException) {
    const sc = err.status;
    return c.json(
      { error: err.message, code: CODE_BY_STATUS[sc] || 'ERROR', statusCode: sc },
      sc,
    );
  }

  console.error('[unhandled]', err);
  return c.json(
    { error: 'Internal server error', code: 'INTERNAL_ERROR', statusCode: 500 },
    500,
  );
}
