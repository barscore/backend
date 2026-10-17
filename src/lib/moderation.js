import { AppError } from '../middleware/errorHandler.js';

// Moderazione automatica dei contenuti pubblici con l'endpoint Moderation di
// OpenAI: gratuito, modello omni-moderation (testo in qualsiasi lingua e
// immagini).
//
// È la seconda linea dopo textFilter.js. L'elenco locale ferma subito, senza
// rete, i termini che non hanno mai un uso innocente; il modello prende quello
// che un elenco non può vedere: insulti composti o riformulati, minacce senza
// le parole chiave, testo sessuale esplicito, le lingue che l'elenco non copre,
// le foto degli eventi.
//
// Fail-open: senza OPENAI_API_KEY, o se OpenAI non risponde entro il timeout,
// il contenuto passa col solo filtro locale e resta soggetto a segnalazione e
// pannello admin. Una recensione persa perché un fornitore esterno è giù costa
// più di un contenuto da togliere a mano.
//
// Non si rifiuta su `flagged`, che per un'app di recensioni è troppo largo:
// «il barista è uno stronzo» è `harassment`, «c'è stata una rissa» è
// `violence`, «qui girano pasticche» è `illicit`. Sono recensioni dure o
// segnalazioni utili, non contenuti da bloccare in automatico (la stessa linea
// del filtro locale). Si rifiutano solo le categorie delle policy qui sotto.

const ENDPOINT = 'https://api.openai.com/v1/moderations';
const MODEL = 'omni-moderation-latest';
// Per le immagini OpenAI deve anche scaricare il file: il timeout copre quello.
const TIMEOUT_MS = 5000;

// Recensioni, risposte dei gestori, eventi. `self-harm/intent` resta fuori:
// riguarda chi scrive («voglio morire, che prezzi»), non ferisce nessuno, e
// rifiutarlo non aiuta chi lo intende davvero. L'istigazione degli altri
// («ucciditi») è `harassment/threatening` e `self-harm/instructions`.
const CONTENT = [
  'hate',
  'hate/threatening',
  'harassment/threatening',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence/graphic',
  'illicit/violent',
];

// Username e handle: compaiono accanto a ogni contenuto dell'utente e non c'è
// un motivo legittimo perché offendano qualcuno, quindi conta anche `harassment`.
const IDENTITY = [...CONTENT, 'harassment'];

const POLICIES = { content: CONTENT, identity: IDENTITY };

const MESSAGES = {
  content: 'Il testo non rispetta le regole della community e non può essere pubblicato.',
  identity: 'Questo nome non rispetta le regole della community: scegline un altro.',
  image: "L'immagine non rispetta le regole della community e non può essere pubblicata.",
};

const isFilled = (text) => typeof text === 'string' && text.trim() !== '';

/**
 * Uno username o un handle come frase: «sei_un.Coglione» → «sei un Coglione».
 * Il modello legge le parole, non gli identificatori.
 */
export function identityText(name) {
  if (!isFilled(name)) return name;
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim();
}

/** Le categorie della policy segnalate in almeno uno dei risultati di OpenAI. */
export function blockedCategories(results, policy = 'content') {
  return POLICIES[policy].filter((cat) => results.some((r) => r.categories?.[cat] === true));
}

// Una chiamata all'endpoint: l'array `results` di OpenAI, o `null` se non è
// stato possibile ottenerlo. Il testo non finisce mai nei log.
async function classify(input) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[moderation] OpenAI ${res.status}: ${detail.slice(0, 200)}`);
      return null;
    }
    const { results } = await res.json();
    return Array.isArray(results) ? results : null;
  } catch (err) {
    console.warn('[moderation] OpenAI non raggiungibile:', err.message);
    return null;
  }
}

/**
 * Le categorie da rifiutare trovate nei testi, `[]` se passano, `null` se non è
 * stato possibile verificarli (chiave assente, timeout, errore di OpenAI).
 */
export async function moderationHits(texts, policy = 'content') {
  const input = texts.filter(isFilled);
  if (input.length === 0) return [];
  const results = await classify(input);
  return results && blockedCategories(results, policy);
}

async function imageHits(url, policy) {
  const results = await classify([{ type: 'image_url', image_url: { url } }]);
  return results && blockedCategories(results, policy);
}

function reject(policy, hits, message) {
  console.info(`[moderation] rifiutato (${policy}): ${hits.join(', ')}`);
  throw new AppError(422, 'CONTENT_REJECTED', message);
}

/**
 * Rifiuta la richiesta (422 CONTENT_REJECTED) se OpenAI segnala una categoria
 * della policy nei testi o nell'immagine. `undefined` e `null` (campi
 * facoltativi non inviati) passano. Va chiamata subito prima della scrittura,
 * dopo i controlli di permesso: è una chiamata di rete e non va sprecata su
 * richieste che falliscono comunque.
 *
 * Ritorna `true` se tutto è stato davvero verificato, `false` se qualcosa è
 * passato senza controllo (fail-open).
 */
export async function assertModerated(texts, { imageUrl = null, policy = 'content' } = {}) {
  const [textResult, imageResult] = await Promise.all([
    moderationHits(texts, policy),
    isFilled(imageUrl) ? imageHits(imageUrl, policy) : [],
  ]);

  if (textResult?.length) reject(policy, textResult, MESSAGES[policy]);
  if (imageResult?.length) reject(policy, imageResult, MESSAGES.image);
  return textResult !== null && imageResult !== null;
}

// --- self-check: `node src/lib/moderation.js`
// Con OPENAI_API_KEY nell'ambiente (`node --env-file=.env src/lib/moderation.js`)
// prova anche la chiamata vera: è il modo di verificare la chiave.
if (import.meta.url === `file://${process.argv[1]}`) {
  const eq = (a, b, m) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
  };

  eq(identityText('sei_un.Coglione'), 'sei un Coglione', 'separatori e camelCase');
  eq(identityText('mario_rossi99'), 'mario rossi99', 'cifre restano attaccate');
  eq(identityText(undefined), undefined, 'assente');

  const res = (cats) => ({ flagged: true, categories: Object.fromEntries(cats.map((c) => [c, true])) });
  eq(blockedCategories([res(['harassment'])], 'content'), [], 'recensione dura passa');
  eq(blockedCategories([res(['violence', 'illicit'])], 'content'), [], 'violence e illicit passano');
  eq(blockedCategories([res(['self-harm/intent'])], 'content'), [], 'self-harm/intent passa');
  eq(blockedCategories([res(['harassment'])], 'identity'), ['harassment'], 'username offensivo no');
  eq(
    blockedCategories([res([]), res(['hate', 'sexual'])], 'content'),
    ['hate', 'sexual'],
    'basta un risultato su più testi',
  );
  eq(await moderationHits([undefined, null, '  '], 'content'), [], 'niente da controllare');

  if (process.env.OPENAI_API_KEY) {
    eq(await moderationHits(['Spritz buono, barista simpatico']), [], 'live: recensione normale');
    eq(await moderationHits(['Il barista è uno stronzo, prezzi da rapina']), [], 'live: recensione dura');
    const threat = await moderationHits(['So dove abiti, stasera ti sgozzo come un maiale']);
    if (!threat?.length) throw new Error(`live: minaccia non rifiutata (${JSON.stringify(threat)})`);
    console.log('moderation self-check ok (live)');
  } else {
    eq(await moderationHits(['qualsiasi cosa']), null, 'senza chiave non verifica');
    eq(await assertModerated(['qualsiasi cosa']), false, 'fail-open senza chiave');
    console.log('moderation self-check ok (offline: OPENAI_API_KEY assente)');
  }
}
