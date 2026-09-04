import { createHmac } from 'node:crypto';
import { AppError } from './errorHandler.js';
import { supabase } from '../lib/supabase.js';

const DEFAULT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const DEFAULT_MAX = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 120;

// Il pre-filtro locale di sharedRateLimiter conta fino a max * questo fattore
// prima di rifiutare da solo: sopra quella soglia una singola istanza ha già
// visto più richieste di quante ne ammetta il limite globale, quindi il no è
// certo e la query al DB è sprecata.
const LOCAL_PREFILTER_FACTOR = 4;

// L'RPC può fallire a ogni richiesta (DB giù): loggare ogni volta riempirebbe
// i log senza aggiungere informazione. Uno ogni 60s, con il conteggio dei
// soppressi, dice la stessa cosa.
const RPC_LOG_THROTTLE_MS = 60_000;

function clientIp(c) {
  // x-forwarded-for is client-forgeable: any caller can pre-fill it and rotate
  // values to get a fresh bucket per request. Only the LAST entry was appended
  // by the trusted proxy in front of us, so that's the only hop to key on.
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',');
    return hops[hops.length - 1].trim() || 'unknown';
  }
  return c.req.header('x-real-ip') || 'unknown';
}

/**
 * L'IP che finisce nel bucket CONDIVISO non ci va in chiaro.
 *
 * Il limitatore in memoria vive dentro il processo e muore con lui; `rate_limits`
 * invece è una tabella su Supabase, cioè un archivio persistente — e un indirizzo
 * IP è un dato personale. Tenerlo in chiaro lì significherebbe aver creato, per
 * contare le richieste, un registro di chi si è collegato e quando.
 *
 * L'HMAC risolve senza togliere niente al conteggio: la chiave resta stabile
 * (stesso IP → stesso bucket) ma non è più reversibile. Un SHA semplice non
 * basterebbe: lo spazio IPv4 sono 4 miliardi di valori, si esaurisce a forza
 * bruta in minuti. Serve un segreto, ed è quello che lo rende una
 * pseudonimizzazione vera (art. 4(5) GDPR) invece di un offuscamento.
 *
 * Il segreto è la service-role key: è già obbligatoria (lib/supabase.js non parte
 * senza), non lascia mai il server, ed è stabile fra i riavvii — indispensabile,
 * perché una chiave che cambia a ogni cold start azzererebbe tutti i bucket e il
 * limite condiviso non conterebbe più niente.
 */
const IP_HASH_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hashedIp = (ip) =>
  createHmac('sha256', IP_HASH_SECRET).update(ip).digest('base64url').slice(0, 22);

/**
 * Fixed-window counter in memoria. Ritorna una funzione `hit(key, now)` che
 * incrementa e restituisce il bucket. Condivisa dai due limiter: identica la
 * finestra, identica la pulizia periodica.
 */
function memoryBuckets(windowMs) {
  const buckets = new Map(); // key -> { count, resetAt }

  // Periodic cleanup so the map does not grow unbounded.
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, windowMs).unref?.();

  return function hit(key, now) {
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket;
  };
}

/** Header di quota: stessa forma per entrambi i limiter, i client non devono distinguerli. */
function setQuotaHeaders(c, max, count, resetAt) {
  c.header('X-RateLimit-Limit', String(max));
  c.header('X-RateLimit-Remaining', String(Math.max(0, max - count)));
  c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
}

function reject(c, resetAt, now) {
  c.header('Retry-After', String(Math.max(0, Math.ceil((resetAt - now) / 1000))));
  throw new AppError(429, 'RATE_LIMITED', 'Troppe richieste, rallenta');
}

/**
 * Build a rate-limit middleware. Each instance owns its own bucket map, so a
 * generous global limiter and a strict per-route one don't share counters.
 *   windowMs — fixed window length.
 *   max      — allowed requests per window per IP.
 *
 * I contatori vivono nel processo, e su Fluid compute i processi sono più d'uno
 * e scendono a zero quando non c'è traffico: il limite reale è quindi `max` per
 * istanza attiva, e riparte da capo a ogni cold start. Va bene per il limitatore
 * globale montato in index.js — è un paraurti contro i burst, e una query al DB
 * per ogni GET della mappa costerebbe più del problema che risolve. Per i limiti
 * stretti su cui si conta davvero (scritture anonime, segnalazioni) usa
 * sharedRateLimiter, che conta sul DB e vale su tutte le istanze.
 */
export function rateLimiter({ windowMs = DEFAULT_WINDOW_MS, max = DEFAULT_MAX } = {}) {
  const hit = memoryBuckets(windowMs);

  return async function rateLimit(c, next) {
    const now = Date.now();
    const bucket = hit(clientIp(c), now);

    setQuotaHeaders(c, max, bucket.count, bucket.resetAt);
    if (bucket.count > max) reject(c, bucket.resetAt, now);

    await next();
  };
}

/**
 * Come rateLimiter, ma il conteggio autorevole sta su Postgres (RPC atomica
 * `hit_rate_limit`), quindi il limite è uno solo per tutte le istanze e
 * sopravvive ai cold start.
 *   key — prefisso obbligatorio della rotta ('suggestions', 'bars-resolve'…):
 *         il bucket è `key:hmac(ip)`, così due rotte con limiti diversi non si
 *         mangiano a vicenda il contatore e la tabella non conserva indirizzi
 *         in chiaro (vedi hashedIp).
 *
 * Fail-open deliberato: se l'RPC non risponde (DB irraggiungibile, migrazione
 * add_rate_limits.sql non ancora eseguita) la richiesta passa lo stesso e resta
 * in piedi solo il contatore in memoria. Il rischio è che durante un guasto del
 * DB il limite torni a essere per-istanza, cioè quello che era prima; il caso
 * opposto — fail-closed — spegnerebbe segnalazioni e report degli utenti per un
 * problema che non è loro.
 */
export function sharedRateLimiter({ windowMs = DEFAULT_WINDOW_MS, max = DEFAULT_MAX, key } = {}) {
  if (!key) throw new Error('sharedRateLimiter richiede una key che identifichi la rotta');

  const hit = memoryBuckets(windowMs);
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));
  const localMax = max * LOCAL_PREFILTER_FACTOR;
  let rpcErrors = 0;
  let lastRpcLogAt = 0;

  function logRpcFailure(err, now) {
    rpcErrors += 1;
    if (now - lastRpcLogAt < RPC_LOG_THROTTLE_MS) return;
    console.error(
      `[rateLimiter] hit_rate_limit non disponibile per "${key}" (${rpcErrors} errori dall'ultimo log), fallback in memoria:`,
      err?.message || err,
    );
    lastRpcLogAt = now;
    rpcErrors = 0;
  }

  return async function sharedRateLimit(c, next) {
    const now = Date.now();
    const ip = clientIp(c);
    // In memoria l'IP in chiaro va bene (il processo muore e se lo porta via);
    // sul bucket condiviso, che è una tabella, ci va l'HMAC. Vedi hashedIp().
    const bucketKey = `${key}:${hashedIp(ip)}`;
    const local = hit(`${key}:${ip}`, now);

    // Pre-filtro: già solo questa istanza ha superato di gran lunga il limite,
    // il rifiuto è certo senza chiedere al DB.
    if (local.count > localMax) {
      setQuotaHeaders(c, max, local.count, local.resetAt);
      reject(c, local.resetAt, now);
    }

    const { data, error } = await supabase.rpc('hit_rate_limit', {
      p_key: bucketKey,
      p_window_s: windowSeconds,
      p_max: max,
    });

    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
      logRpcFailure(error || new Error('nessuna riga restituita'), now);
      // Fallback in memoria: stesso bucket del pre-filtro, ma sulla soglia vera.
      setQuotaHeaders(c, max, local.count, local.resetAt);
      if (local.count > max) reject(c, local.resetAt, now);
      return next();
    }

    const resetAt = Date.parse(row.reset_at);
    const resetMs = Number.isNaN(resetAt) ? now + windowMs : resetAt;

    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(Math.max(0, Number(row.remaining) || 0)));
    c.header('X-RateLimit-Reset', String(Math.ceil(resetMs / 1000)));

    if (!row.allowed) reject(c, resetMs, now);

    await next();
  };
}
