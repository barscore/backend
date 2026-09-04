import { randomUUID } from 'node:crypto';
import { supabase } from './supabase.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Allegati di verifica (rivendicazione bar, richiesta PR/organizzatore).
 *
 * Il bucket `proofs` è privato e nessun client lo tocca con la anon key: il
 * backend firma un upload URL per un path che decide lui, il client fa il PUT
 * dei byte, e in tabella finisce solo il path. In lettura vale lo stesso al
 * contrario — l'admin riceve signed URL a scadenza, mai un URL pubblico.
 *
 * Il path è `<user_id>/<uuid>.<ext>`: contiene chi ha caricato, così
 * `assertOwnedPaths` può rifiutare una richiesta che allega i file di un altro
 * utente senza interrogare lo storage.
 */
export const PROOF_BUCKET = 'proofs';
export const MAX_PROOF_FILES = 3;
export const PROOF_URL_TTL_S = 3600;

/** Estensioni ammesse → content type atteso. Speculare al bucket in SQL. */
export const PROOF_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
};

const PATH_RE = new RegExp(
  `^[0-9a-f-]{36}/[0-9a-f-]{36}\\.(${Object.keys(PROOF_TYPES).join('|')})$`,
);

/**
 * Firma un upload URL per ogni estensione richiesta.
 * Restituisce anche `content_type`, che il client deve usare nel PUT: il bucket
 * rifiuta i mime fuori lista, quindi mandarne un altro fallisce lì.
 */
export async function createProofUploadUrls(userId, exts) {
  const out = [];
  for (const ext of exts) {
    const path = `${userId}/${randomUUID()}.${ext}`;
    const { data, error } = await supabase.storage
      .from(PROOF_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      throw new AppError(500, 'INTERNAL_ERROR', 'Preparazione upload non riuscita');
    }
    out.push({
      path,
      url: data.signedUrl,
      token: data.token,
      content_type: PROOF_TYPES[ext],
    });
  }
  return out;
}

/**
 * I path allegati devono stare nella cartella di chi invia la richiesta.
 * Senza questo controllo un utente potrebbe allegare i file di un altro
 * indovinandone (o riusando) il path.
 */
export function assertOwnedPaths(userId, paths) {
  for (const p of paths) {
    if (!PATH_RE.test(p) || !p.startsWith(`${userId}/`)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Allegato non valido');
    }
  }
}

/**
 * Signed URL di lettura per l'admin. Best-effort: un file sparito diventa
 * `null` invece di far fallire l'intera lista di richieste.
 */
export async function signedProofUrls(paths) {
  if (!paths?.length) return [];
  const { data, error } = await supabase.storage
    .from(PROOF_BUCKET)
    .createSignedUrls(paths, PROOF_URL_TTL_S);
  if (error || !data) return [];
  return data.filter((d) => d.signedUrl).map((d) => ({ path: d.path, url: d.signedUrl }));
}

/**
 * Cancella i file di una richiesta chiusa (rifiutata o approvata).
 * Best-effort e non lancia mai: un file già sparito — o lo storage che fa i
 * capricci — non deve far fallire il rifiuto della richiesta, che è l'azione
 * che conta.
 */
export async function deleteProofPaths(paths) {
  if (!paths?.length) return;
  try {
    await supabase.storage.from(PROOF_BUCKET).remove(paths);
  } catch {
    // Ignorato: i file orfani si ripuliscono, una richiesta bloccata no.
  }
}

/**
 * Svuota la cartella di un utente. Serve alla cancellazione account (art. 17
 * GDPR): `auth.admin.deleteUser` fa cascadare le righe ma non tocca lo storage,
 * e qui dentro ci sono visure e documenti d'identità.
 *
 * Best-effort come sopra — la cancellazione dell'account deve andare a termine
 * comunque — ma un fallimento si logga: un documento d'identità rimasto dietro
 * dopo una richiesta di cancellazione va saputo, non ingoiato.
 */
export async function deleteAllProofsForUser(userId) {
  try {
    const { data, error } = await supabase.storage.from(PROOF_BUCKET).list(userId);
    if (error) throw error;
    if (!data?.length) return;
    const { error: delError } = await supabase.storage
      .from(PROOF_BUCKET)
      .remove(data.map((f) => `${userId}/${f.name}`));
    if (delError) throw delError;
  } catch (e) {
    console.error(`[rabar] proofs non cancellati per ${userId}:`, e?.message || e);
  }
}

// --- self-check: `SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x node src/lib/proofs.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const uid = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const ok = `${uid}/33333333-3333-4333-8333-333333333333.pdf`;
  const rejects = (paths, why) => {
    try {
      assertOwnedPaths(uid, paths);
    } catch {
      return;
    }
    throw new Error(`should have rejected: ${why}`);
  };
  assertOwnedPaths(uid, [ok]); // throws if broken
  rejects([`${other}/33333333-3333-4333-8333-333333333333.pdf`], "another user's folder");
  rejects([`${uid}/../${other}/x.pdf`], 'path traversal');
  rejects([`${uid}/33333333-3333-4333-8333-333333333333.exe`], 'extension not allowed');
  rejects([`${uid}/nope.pdf`], 'not a uuid filename');
  console.log('proofs self-check ok');
}
