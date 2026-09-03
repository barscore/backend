import { z } from 'zod';
import { MAX_PROOF_FILES, PROOF_TYPES } from '../lib/proofs.js';

/** Allegati: da 1 a MAX_PROOF_FILES path nel bucket `proofs`. */
const proofFiles = z.array(z.string().trim().min(1).max(300)).min(1).max(MAX_PROOF_FILES);

/** Nota facoltativa, uguale su richieste e rivendicazioni. */
const note = z.string().trim().min(1).max(1000).optional();

/**
 * Richiesta account organizzatore.
 *
 * "proprietario" non si chiede più da qui: si ottiene rivendicando un bar dalla
 * sua pagina (`POST /bars/:id/claim`), che all'approvazione promuove l'utente.
 *
 * PR: con chi ha collaborato + gli allegati che lo provano.
 * Organizzatore: gli allegati che lo provano + una nota facoltativa.
 */
export const createOrganizerRequestSchema = z
  .object({
    requested_type: z.enum(['pr', 'organizzatore']),
    proof_files: proofFiles,
    note,
    collaborations: z.string().trim().min(5).max(1000).optional(),
  })
  .refine((v) => v.requested_type !== 'pr' || !!v.collaborations, {
    message: 'Indica con chi hai collaborato',
    path: ['collaborations'],
  })
  .refine((v) => v.requested_type === 'pr' || !v.collaborations, {
    message: 'Le collaborazioni valgono solo per il PR',
    path: ['collaborations'],
  });

/** Rivendicazione di un bar: allegati obbligatori, nota facoltativa. */
export const createClaimSchema = z.object({
  proof_files: proofFiles,
  note,
});

/** POST /me/uploads/proof — quante e quali estensioni firmare. */
export const proofUploadSchema = z.object({
  files: z
    .array(z.object({ ext: z.enum(Object.keys(PROOF_TYPES)) }))
    .min(1)
    .max(MAX_PROOF_FILES),
});

export const reviewSchema = z.object({
  admin_note: z.string().trim().max(500).optional(),
});
