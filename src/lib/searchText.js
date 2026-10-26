// Ricerca "naturale": quello che uno scrive di getto deve trovare il locale.
//
//   * maiuscole, accenti e punteggiatura non contano: «caffe" = «Caffè»;
//   * l'ordine delle parole non conta e una parola può essere l'inizio di un'altra:
//     «centrale bar» trova «Bar Centrale», «spri» trova «Spritz Bar»;
//   * un refuso non azzera il risultato: «negorni» trova «Negroni»;
//   * la città può stare nella stessa frase: «stazione rovereto» trova il «Bar
//     Stazione» di Rovereto prima di quello di Trento.
//
// Il punteggio è relativo alla query: serve a ordinare i candidati che arrivano
// da Photon e dal nostro database, non a scartarli (tranne quelli a zero).

/** «Caffè  dell'Arte!» → «caffe dell arte». */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Parole che dicono il tipo di posto, non quale: «bar», «pub»… Contano solo se
// la query non ha altro.
const GENERIC = new Set([
  'bar', 'pub', 'caffe', 'cafe', 'caffetteria', 'locale', 'osteria', 'birreria', 'enoteca',
  'il', 'lo', 'la', 'i', 'gli', 'le', 'l', 'di', 'da', 'del', 'della', 'dei', 'delle',
  'a', 'al', 'alla', 'in', 'e', 'the', 'of',
]);

export function queryTokens(query) {
  const all = normalize(query).split(' ').filter((t) => t.length > 0);
  const specific = all.filter((t) => !GENERIC.has(t));
  return { all, specific: specific.length ? specific : all };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Quanto una parola della query somiglia alla migliore parola candidata, 0…1. */
function tokenMatch(q, words) {
  let best = 0;
  for (const w of words) {
    if (w === q) return 1;
    if (w.startsWith(q)) best = Math.max(best, q.length >= 3 ? 0.9 : 0.6);
    else if (q.length >= 4 && w.includes(q)) best = Math.max(best, 0.7);
    else if (q.length >= 4 && w.length >= 4) {
      // Un refuso ogni ~4 lettere: «negorni»→«negroni» sì, «roma»→«rosa» meno.
      const ratio = 1 - levenshtein(q, w.slice(0, Math.max(q.length, Math.min(w.length, q.length + 1)))) / q.length;
      if (ratio >= 0.7) best = Math.max(best, 0.6 * ratio);
    }
  }
  return best;
}

/**
 * Rilevanza di un locale per la query, 0…~1.5. `place` è il testo di contorno
 * (via, città): una parola che cade lì vale meno di una nel nome.
 */
export function relevance(query, name, place = '') {
  const { specific } = queryTokens(query);
  if (!specific.length) return 0;
  const nameWords = normalize(name).split(' ').filter(Boolean);
  const placeWords = normalize(place).split(' ').filter(Boolean);
  let sum = 0;
  let inName = 0;
  for (const q of specific) {
    const n = tokenMatch(q, nameWords);
    const p = tokenMatch(q, placeWords) * 0.55;
    if (n >= p && n > 0) inName++;
    sum += Math.max(n, p);
  }
  // Almeno una parola deve stare nel nome: la sola città non fa un risultato.
  if (!inName) return 0;
  let score = sum / specific.length;
  const nq = normalize(query);
  const nn = normalize(name);
  if (nn === nq) score += 0.5;
  else if (nn.startsWith(nq)) score += 0.3;
  return score;
}

/**
 * Le parole su cui interrogare il database con ILIKE: quelle specifiche, senza
 * l'ultima lettera oltre le 4 (copre «caffe»→«Caffè» e un refuso finale).
 * Solo lettere e cifre — finiscono in un filtro `or()` di PostgREST.
 */
export function dbPatterns(query) {
  const { specific } = queryTokens(query);
  return [...new Set(
    specific
      .filter((t) => t.length >= 2)
      .map((t) => (t.length > 4 ? t.slice(0, -1) : t))
      .filter((t) => /^[\p{L}\p{N}]+$/u.test(t)),
  )].slice(0, 4);
}

// --- self-check: `node src/lib/searchText.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  assert(normalize("Caffè  dell'Arte!") === 'caffe dell arte', 'normalize');
  assert(relevance('caffe arte', "Caffè dell'Arte") > 0.8, 'accenti e parole');
  assert(relevance('centrale bar', 'Bar Centrale') > 0.8, 'ordine');
  assert(relevance('spri', 'Spritz Bar') > 0.5, 'prefisso');
  assert(relevance('negorni', 'Negroni Bar') > 0.3, 'refuso');
  assert(
    relevance('stazione rovereto', 'Bar Stazione', 'Piazza Rosmini, Rovereto') >
      relevance('stazione rovereto', 'Bar Stazione', 'Via Roma, Trento'),
    'città nella frase',
  );
  assert(relevance('rovereto', 'Bar Stazione', 'Rovereto') === 0, 'solo città non basta');
  assert(relevance('bar', 'Bar Miami') > 0, 'solo parola generica');
  assert(JSON.stringify(dbPatterns('caffè negroni rovereto')) === '["negron","roveret"]', 'patterns');
  assert(JSON.stringify(dbPatterns('caffè')) === '["caff"]', 'patterns, solo generica');
  console.log('searchText self-check ok');
}
