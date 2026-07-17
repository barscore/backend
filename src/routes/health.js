import { Hono } from 'hono';

const health = new Hono();

/** GET /health — liveness probe. */
health.get('/', (c) =>
  c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }),
);

export default health;
