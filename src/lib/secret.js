import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Confronto a tempo costante di un segreto condiviso (cron, notifiche Google).
 * `!==` esce al primo byte diverso e il tempo di risposta racconta quanti byte
 * erano giusti: con un endpoint che si può chiamare quanto si vuole, è un
 * segreto che si indovina un carattere alla volta.
 *
 * Si confrontano gli SHA-256, non i byte: `timingSafeEqual` pretende due buffer
 * della stessa lunghezza, e la guardia sulla lunghezza che servirebbe a non
 * farlo lanciare è essa stessa un canale. I digest sono sempre 32 byte, quindi
 * non lancia mai e la lunghezza del segreto non trapela.
 */
export function sameSecret(given, expected) {
  if (!expected || !given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
