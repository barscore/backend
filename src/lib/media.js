import { randomUUID } from 'node:crypto';
import { supabase } from './supabase.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Immagini pubbliche caricate dagli utenti: foto profilo e copertine degli eventi.
 *
 * Stesso schema degli allegati di verifica (`lib/proofs.js`): il backend firma
 * un upload URL per un path che decide lui, il client fa il PUT dei byte, e poi
 * rimanda il path per confermarlo. La differenza è il bucket: `media` è
 * pubblico in lettura, perché queste immagini si vedono accanto a recensioni ed
 * eventi e un signed URL a scadenza non si può mettere in una riga.
 *
 * Path: `<kind>/<user_id>/<uuid>.<ext>`. Contiene chi ha caricato, così un
 * client non può spacciare per sua l'immagine di un altro, e la cancellazione
 * dell'account sa quale cartella svuotare.
 *
 * I client ridimensionano e convertono in JPEG prima di caricare: niente HEIC,
 * che il browser non sa mostrare.
 */
export const MEDIA_BUCKET = 'media';

/** Cartella per tipo di immagine. */
export const MEDIA_KINDS = {
  avatar: 'avatars',
  event_cover: 'events',
};

/** Estensioni ammesse → content type. Speculare al bucket in SQL (add_media.sql). */
export const MEDIA_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const EXT_RE = Object.keys(MEDIA_TYPES).join('|');

function pathRe(kind) {
  return new RegExp(`^${MEDIA_KINDS[kind]}/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(${EXT_RE})$`);
}

export function publicMediaUrl(path) {
  return supabase.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * Il path di un URL pubblico del nostro bucket, o null se l'URL punta altrove
 * (le copertine degli eventi vecchi erano link incollati a mano).
 */
export function mediaPathFromUrl(url) {
  if (typeof url !== 'string') return null;
  const marker = `/storage/v1/object/public/${MEDIA_BUCKET}/`;
  const at = url.indexOf(marker);
  if (at === -1) return null;
  return decodeURIComponent(url.slice(at + marker.length).split('?')[0]);
}

/** Un upload URL firmato per una nuova immagine di `kind`. */
export async function createMediaUpload(userId, kind, ext) {
  const path = `${MEDIA_KINDS[kind]}/${userId}/${randomUUID()}.${ext}`;
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Preparazione upload non riuscita');
  }
  return {
    path,
    url: data.signedUrl,
    token: data.token,
    content_type: MEDIA_TYPES[ext],
    public_url: publicMediaUrl(path),
  };
}

/** Il path deve essere un'immagine di `kind` nella cartella di chi la usa. */
export function assertOwnedMedia(userId, kind, path) {
  if (!pathRe(kind).test(path) || !path.startsWith(`${MEDIA_KINDS[kind]}/${userId}/`)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Immagine non valida');
  }
}

/**
 * Il file c'è davvero: un path firmato ma mai caricato (upload fallito a metà)
 * finirebbe in tabella come un'immagine rotta.
 */
export async function assertMediaUploaded(path) {
  const slash = path.lastIndexOf('/');
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 1 });
  if (error || !data?.some((f) => f.name === path.slice(slash + 1))) {
    throw new AppError(400, 'VALIDATION_ERROR', "L'immagine non è stata caricata, riprova");
  }
}

/** Best-effort, non lancia mai: un file orfano costa meno di un'azione fallita. */
export async function deleteMedia(paths) {
  const list = (paths ?? []).filter(Boolean);
  if (!list.length) return;
  try {
    await supabase.storage.from(MEDIA_BUCKET).remove(list);
  } catch {
    // Ignorato.
  }
}

/** Le altre immagini di `kind` di un utente, tranne `keep`. */
export async function deleteOtherMedia(userId, kind, keep) {
  const folder = `${MEDIA_KINDS[kind]}/${userId}`;
  try {
    const { data } = await supabase.storage.from(MEDIA_BUCKET).list(folder, { limit: 100 });
    const stale = (data ?? []).map((f) => `${folder}/${f.name}`).filter((p) => p !== keep);
    await deleteMedia(stale);
  } catch {
    // Ignorato.
  }
}

/**
 * Svuota le cartelle di un utente (art. 17 GDPR, come per gli allegati): le
 * righe se ne vanno col cascade, lo storage no. Si logga un fallimento.
 */
export async function deleteAllMediaForUser(userId) {
  for (const folder of Object.values(MEDIA_KINDS)) {
    try {
      const prefix = `${folder}/${userId}`;
      const { data, error } = await supabase.storage.from(MEDIA_BUCKET).list(prefix, { limit: 1000 });
      if (error) throw error;
      if (!data?.length) continue;
      const { error: delError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .remove(data.map((f) => `${prefix}/${f.name}`));
      if (delError) throw delError;
    } catch (e) {
      console.error(`[rabar] media non cancellati per ${userId}:`, e?.message || e);
    }
  }
}

// --- self-check: `SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x node src/lib/media.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const uid = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const file = '33333333-3333-4333-8333-333333333333';
  const rejects = (kind, path, why) => {
    try {
      assertOwnedMedia(uid, kind, path);
    } catch {
      return;
    }
    throw new Error(`should have rejected: ${why}`);
  };
  assertOwnedMedia(uid, 'avatar', `avatars/${uid}/${file}.jpg`);
  assertOwnedMedia(uid, 'event_cover', `events/${uid}/${file}.webp`);
  rejects('avatar', `avatars/${other}/${file}.jpg`, "another user's folder");
  rejects('avatar', `events/${uid}/${file}.jpg`, 'wrong kind');
  rejects('avatar', `avatars/${uid}/../${other}/${file}.jpg`, 'path traversal');
  rejects('avatar', `avatars/${uid}/${file}.heic`, 'extension not allowed');
  const url = `http://localhost/storage/v1/object/public/media/avatars/${uid}/${file}.jpg`;
  if (mediaPathFromUrl(url) !== `avatars/${uid}/${file}.jpg`) throw new Error('mediaPathFromUrl');
  if (mediaPathFromUrl('https://example.com/x.jpg') !== null) throw new Error('foreign url');
  console.log('media self-check ok');
}
