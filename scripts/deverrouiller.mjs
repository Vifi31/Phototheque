// Mot de passe de verrouillage oublié : `node scripts/deverrouiller.mjs` (application ARRÊTÉE).
// Désactive le verrouillage de l'interface ; ne touche à rien d'autre. Quiconque peut lancer ce script
// a déjà accès aux fichiers de la photothèque : le verrou protège l'interface, pas les fichiers.
import { initStore, saveStore } from '../lib/store.mjs';
import { logHistory } from '../lib/db.mjs';

const { db, store } = initStore();
if (!store.security?.lock?.enabled) console.log('Le verrouillage n’est pas activé : rien à faire.');
else {
  store.security.lock = { enabled: false, salt: null, hash: null, idleMinutes: store.security.lock.idleMinutes ?? 30 };
  saveStore(db, store);
  logHistory(db, 'lock.disable', 'Verrouillage désactivé par scripts/deverrouiller.mjs');
  console.log('Verrouillage désactivé. Relancez l’application, puis définissez un nouveau mot de passe dans Paramètres si vous le souhaitez.');
}
db.close();
