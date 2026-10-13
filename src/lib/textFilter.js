import { AppError } from '../middleware/errorHandler.js';

// Prima linea contro il testo inaccettabile nei contenuti pubblici (commenti
// alle recensioni, risposte dei gestori, titolo e descrizione degli eventi).
//
// Non sostituisce la moderazione: segnalazioni, pannello admin e ban restano
// il modo in cui un contenuto viene davvero giudicato. Serve a non far
// arrivare in pubblico ciò che non richiede giudizio — gli insulti d'odio e le
// minacce — ed è il «method for filtering objectionable material» che la
// linea guida 1.2 dell'App Store chiede a un'app con contenuti degli utenti.
//
// L'elenco è corto apposta, e ci entrano solo termini senza un uso innocente:
//   * il turpiloquio comune resta fuori. «Il barista è uno str…» è una
//     recensione dura, non un contenuto da bloccare in automatico;
//   * restano fuori le parole che in un'app di bar hanno un altro significato:
//     «negro» (Negroni si salva comunque, ma negroamaro e il colore in spagnolo
//     no), «finocchio» (l'ortaggio), «zingara» (la ricetta), «terrone» (nome
//     di locali). Per queste decide una persona, su segnalazione.
//
// Limite noto: copre italiano, inglese e spagnolo. Il testo in cirillico o in
// cinese passa senza controllo.

// Parole intere, senza accenti. L'asterisco finale accetta qualsiasi desinenza.
const WORDS = [
  // en
  'nigger*',
  'nigga*',
  'faggot*',
  // it
  'froci*',
  'ricchion*',
  'culatton*',
  'negracci*',
  'ebreacci*',
  'mongoloid*',
  'subnormal*',
  // es
  'maricon*',
  'sudaca*',
  'negrata*',
];

// Minacce e istigazione all'autolesionismo: sequenze di parole intere.
const PHRASES = [
  'ti ammazzo',
  'vi ammazzo',
  'ti uccido',
  'vi uccido',
  'devi morire',
  'dovete morire',
  'ucciditi',
  'kill yourself',
  'i will kill you',
  'te voy a matar',
];

// Le sostituzioni più comuni per aggirare un filtro: «fr0c1o», «f@ggot».
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

// Ogni lettera può ripetersi («froooocio»), ma le doppie del termine restano
// obbligatorie: «nigger» non deve prendere «Niger».
const WORD_PATTERNS = WORDS.map((entry) => {
  const open = entry.endsWith('*');
  const stem = open ? entry.slice(0, -1) : entry;
  const body = [...stem].map((ch) => `${ch}+`).join('');
  return { entry, re: new RegExp(`^${body}${open ? '[a-z]*' : ''}$`) };
});

const PHRASE_PATTERNS = PHRASES.map((entry) => ({
  entry,
  re: new RegExp(`(^| )${entry}( |$)`),
}));

function tokens(text) {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[013457@$]/g, (ch) => LEET[ch])
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * La voce dell'elenco che il testo contiene, o `null`. Il valore serve ai log
 * e ai test: all'utente non si rimanda mai indietro la parola trovata.
 */
export function findBlockedTerm(text) {
  if (typeof text !== 'string' || !text) return null;
  const words = tokens(text);

  for (const word of words) {
    const hit = WORD_PATTERNS.find((p) => p.re.test(word));
    if (hit) return hit.entry;
  }

  const sentence = words.join(' ');
  return PHRASE_PATTERNS.find((p) => p.re.test(sentence))?.entry ?? null;
}

/**
 * Rifiuta la richiesta se uno dei testi contiene un termine dell'elenco.
 * `undefined` e `null` (campi facoltativi non inviati) passano.
 */
export function assertCleanText(...texts) {
  if (texts.some((text) => findBlockedTerm(text))) {
    throw new AppError(
      422,
      'CONTENT_REJECTED',
      'Il testo contiene insulti o minacce e non può essere pubblicato.',
    );
  }
}

// --- self-check: `node src/lib/textFilter.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const eq = (a, b, m) => {
    if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`);
  };

  // Ciò che in un'app di bar deve poter essere scritto.
  eq(findBlockedTerm('Negroni ottimo e un negroamaro niente male'), null, 'Negroni / negroamaro');
  eq(findBlockedTerm('Spaghetti alla puttanesca, finocchio in pinzimonio'), null, 'cucina');
  eq(findBlockedTerm('Barista scortese, prezzi alti e bagno sporco!'), null, 'recensione dura');
  eq(findBlockedTerm('Birra del Niger, aperti fino alle 10'), null, 'Niger non è la doppia g');
  eq(findBlockedTerm('Отличный бар 很好的酒吧'), null, 'altri alfabeti passano');
  eq(findBlockedTerm(''), null, 'vuoto');
  eq(findBlockedTerm(undefined), null, 'assente');

  // Ciò che non deve arrivare in pubblico, anche travestito.
  eq(findBlockedTerm('sei un frocio'), 'froci*', 'parola intera');
  eq(findBlockedTerm('FROCI di merda'), 'froci*', 'maiuscole e desinenza');
  eq(findBlockedTerm('fr0c1o'), 'froci*', 'cifre al posto delle lettere');
  eq(findBlockedTerm('frooociooo!!!'), 'froci*', 'lettere ripetute');
  eq(findBlockedTerm('maricón'), 'maricon*', 'accenti');
  eq(findBlockedTerm('Ti   ammazzo, capito?'), 'ti ammazzo', 'frase con spazi e punteggiatura');
  eq(findBlockedTerm('KILL YOURSELF'), 'kill yourself', 'frase in maiuscolo');

  let thrown = null;
  try {
    assertCleanText(undefined, 'tutto bene', 'ucciditi');
  } catch (err) {
    thrown = err;
  }
  eq(thrown?.statusCode, 422, 'assertCleanText rifiuta');
  eq(thrown?.code, 'CONTENT_REJECTED', 'con il suo codice');
  assertCleanText(undefined, null, 'Ottimo spritz');

  console.log('textFilter self-check ok');
}
