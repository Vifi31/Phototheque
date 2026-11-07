// Verrouillage facultatif de l'application (cahier des charges §18). Mot de passe jamais conservé :
// seulement un sel et une empreinte scrypt (store.security.lock). Une fois déverrouillé, le navigateur
// reçoit un jeton de session (cookie HttpOnly, SameSite=Strict) gardé en mémoire par le serveur ; il
// expire après une période d'inactivité. Tant que l'application est verrouillée, les routes /api/*
// (dont les vignettes) répondent 401, sauf /api/lock/* et /api/ping.
// Limite, dite à l'utilisateur : ce verrou protège l'accès par l'interface ; il ne chiffre ni la base
// ni les photos, lisibles par quiconque a accès aux fichiers de l'ordinateur.
import crypto from 'crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const LOCK_COOKIE = 'phototheque_session';
const MIN_LENGTH = 6;

export function hashPassword(password, saltHex = crypto.randomBytes(16).toString('hex')) {
  return { salt: saltHex, hash: crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32, SCRYPT).toString('hex') };
}
export function checkPassword(lock, password) {
  if (!lock?.salt || !lock?.hash || typeof password !== 'string' || !password) return false;
  const h = Buffer.from(hashPassword(password, lock.salt).hash, 'hex');
  return crypto.timingSafeEqual(h, Buffer.from(lock.hash, 'hex'));
}

/** `getLock()` / `setLock(l)` : lecture et écriture de store.security.lock (setLock enregistre). */
export function createLock({ getLock, setLock, now = () => Date.now() }) {
  const sessions = new Map(); // jeton → dernier accès (ms)
  let failures = 0, blockedUntil = 0;
  const cfg = () => getLock() ?? { enabled: false };
  const idleMs = () => (cfg().idleMinutes ?? 30) * 60000;

  const tokenOf = req => {
    const c = String(req.headers?.cookie ?? '');
    const m = c.split(/;\s*/).map(x => x.split('=')).find(([k]) => k === LOCK_COOKIE);
    return m ? decodeURIComponent(m.slice(1).join('=')) : null;
  };
  function newSession() { const t = crypto.randomBytes(32).toString('hex'); sessions.set(t, now()); return t; }
  const cookie = (t, maxAge = null) => `${LOCK_COOKIE}=${t ? encodeURIComponent(t) : ''}; Path=/; HttpOnly; SameSite=Strict${maxAge === 0 ? '; Max-Age=0' : ''}`;

  /** La requête est-elle autorisée ? (verrou inactif, ou jeton valide et récent : son délai repart) */
  function allowed(req, touch = true) {
    if (!cfg().enabled) return true;
    const t = tokenOf(req); if (!t || !sessions.has(t)) return false;
    if (now() - sessions.get(t) > idleMs()) { sessions.delete(t); return false; }
    if (touch) sessions.set(t, now()); return true;
  }
  const status = req => ({ enabled: !!cfg().enabled, unlocked: allowed(req, false), idleMinutes: cfg().idleMinutes ?? 30 });

  /** Déverrouille ; après 5 erreurs, attente croissante (30 s, 60 s…). Renvoie le cookie à poser. */
  function unlock(password) {
    if (!cfg().enabled) return { cookie: null };
    if (now() < blockedUntil) throw new Error(`Trop d’essais : réessayez dans ${Math.ceil((blockedUntil - now()) / 1000)} s`);
    if (!checkPassword(cfg(), password)) {
      failures++;
      if (failures >= 5) blockedUntil = now() + 30000 * 2 ** Math.min(5, failures - 5);
      throw new Error('Mot de passe incorrect');
    }
    failures = 0; blockedUntil = 0;
    return { cookie: cookie(newSession()) };
  }
  /** Verrouille tout de suite (toutes les sessions). */
  function lockNow() { sessions.clear(); return { cookie: cookie(null, 0) }; }

  /** Active ou change le mot de passe (l'actuel est exigé s'il y en a un) ; garde la session ouverte. */
  function setPassword({ current = '', password = '', idleMinutes } = {}) {
    const l = cfg();
    if (l.enabled && !checkPassword(l, current)) throw new Error('Mot de passe actuel incorrect');
    if (String(password).length < MIN_LENGTH) throw new Error(`Mot de passe trop court (${MIN_LENGTH} caractères au moins)`);
    const h = hashPassword(password);
    setLock({ enabled: true, ...h, idleMinutes: Number.isFinite(+idleMinutes) ? +idleMinutes : l.idleMinutes ?? 30 });
    sessions.clear();
    return { cookie: cookie(newSession()) };
  }
  function setIdle({ current = '', idleMinutes } = {}) {
    const l = cfg(); if (!l.enabled) throw new Error('Verrouillage inactif');
    if (!checkPassword(l, current)) throw new Error('Mot de passe actuel incorrect');
    setLock({ ...l, idleMinutes: +idleMinutes }); return { idleMinutes: cfg().idleMinutes };
  }
  /** Désactive le verrouillage (mot de passe actuel exigé). */
  function disable({ current = '' } = {}) {
    const l = cfg(); if (!l.enabled) return { cookie: null };
    if (!checkPassword(l, current)) throw new Error('Mot de passe actuel incorrect');
    setLock({ enabled: false, salt: null, hash: null, idleMinutes: l.idleMinutes ?? 30 });
    sessions.clear(); return { cookie: cookie(null, 0) };
  }

  return { allowed, status, unlock, lockNow, setPassword, setIdle, disable, sessions };
}
