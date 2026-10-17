import { supabase } from './supabase.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { findBlockedTerm } from './textFilter.js';
import { identityText, moderationHits } from './moderation.js';

// Gli username nati alla registrazione non passano dal backend: li scrive il
// trigger `handle_new_user` dai metadati del signUp di supabase-js, o dalla
// parte locale dell'email per Google e Apple. Si controllano qui, alla prima
// GET /me, che web, Android e iOS chiamano all'apertura della home.
//
// L'esito si ricorda in `app_metadata.moderated_username`, che solo la
// service-role key può scrivere e che arriva già con `auth.getUser`: nessuna
// colonna, nessuna query in più. Si salva lo username controllato e non un
// flag, così un cambio di nome riapre il controllo da solo. Copre anche gli
// account esistenti, uno per volta, alla loro prossima apertura dell'app.

// Indirizzo dei reclami, lo stesso dei ToS e di admin.js: ogni motivazione DSA
// deve dire dove si contesta la decisione.
const CONTATTO_RECLAMI = 'abuse@rabar.it';

/** Segna lo username come già controllato. Best-effort. */
export async function markUsernameModerated(userId, username) {
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { moderated_username: username },
  });
  if (error) console.warn('[username-review] app_metadata non aggiornato:', error.message);
}

// Lo stesso schema del ripiego del trigger (`user_` + inizio dell'id), più
// lungo se è già preso. Il filtro su `username` evita di sovrascrivere un nome
// cambiato nel frattempo da una PATCH /me concorrente.
async function resetUsername(userId, current) {
  const hex = userId.replace(/-/g, '');
  for (const len of [6, 12, 24]) {
    const candidate = `user_${hex.slice(0, len)}`;
    const { data, error } = await supabase
      .from('profiles')
      .update({ username: candidate })
      .eq('id', userId)
      .eq('username', current)
      .select('id');
    if (!error) return data?.length ? candidate : null;
    if (error.code !== '23505') {
      console.error('[username-review] reset fallito:', error.message);
      return null;
    }
  }
  return null;
}

/**
 * Lo username da mostrare: quello attuale, o il ripiego `user_…` se non
 * rispetta le regole. Non lancia mai: un problema qui non deve rompere la GET /me.
 */
export async function reviewUsername(authUser, username) {
  try {
    if (authUser.app_metadata?.moderated_username === username) return username;

    const hits = findBlockedTerm(username)
      ? ['blocklist']
      : await moderationHits([identityText(username)], 'identity');
    // OpenAI spento o giù: si riprova alla prossima apertura.
    if (hits === null) return username;

    if (hits.length === 0) {
      await markUsernameModerated(authUser.id, username);
      return username;
    }

    const replacement = await resetUsername(authUser.id, username);
    if (!replacement) return username;

    await markUsernameModerated(authUser.id, replacement);
    await notify([authUser.id], {
      type: 'content_removed',
      title: 'Username cambiato',
      body: `Il tuo username non rispettava le regole della community ed è stato sostituito con «${replacement}». Puoi sceglierne un altro dalle impostazioni. Se pensi sia un errore, scrivi a ${CONTATTO_RECLAMI}.`,
      link: '/impostazioni',
    });
    await audit(null, 'user.username_reset', {
      targetType: 'user',
      targetId: authUser.id,
      payload: { from: username, to: replacement, categories: hits, automated: true },
    });
    return replacement;
  } catch (err) {
    console.error('[username-review]', err.message);
    return username;
  }
}
