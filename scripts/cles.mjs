// Clés de signature des distributions (Ed25519).
//
//   node scripts/cles.mjs            crée la paire de clés si elle n'existe pas
//   node scripts/cles.mjs --info     affiche l'empreinte de la clé publique
//
// La clé PRIVÉE est rangée hors du dépôt : %USERPROFILE%\.phototheque\signature\cle-privee.pem
// (ou PHOTOTHEQUE_SIGN_KEY). Sauvegardez-la en lieu sûr : sans elle, les mises à jour signées ne
// peuvent plus être produites. La clé PUBLIQUE est livrée avec le programme (distribution/cle-publique.pem).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateKeys, keyId, PUBLIC_KEY_FILE } from '../lib/dist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRIVATE_KEY = process.env.PHOTOTHEQUE_SIGN_KEY || path.join(os.homedir(), '.phototheque', 'signature', 'cle-privee.pem');
const pubFile = path.join(ROOT, ...PUBLIC_KEY_FILE.split('/'));
if (process.argv.includes('--info')) {
  console.log(fs.existsSync(pubFile) ? `Clé publique : ${pubFile}\nEmpreinte : ${keyId(fs.readFileSync(pubFile, 'utf8'))}` : 'Aucune clé publique.');
  console.log(`Clé privée : ${PRIVATE_KEY} (${fs.existsSync(PRIVATE_KEY) ? 'présente' : 'absente'})`);
  process.exit(0);
}
if (fs.existsSync(PRIVATE_KEY)) { console.log(`La clé privée existe déjà : ${PRIVATE_KEY}`); process.exit(0); }
const k = generateKeys();
fs.mkdirSync(path.dirname(PRIVATE_KEY), { recursive: true });
fs.writeFileSync(PRIVATE_KEY, k.privatePem, { mode: 0o600 });
fs.mkdirSync(path.dirname(pubFile), { recursive: true });
fs.writeFileSync(pubFile, k.publicPem);
console.log(`Clé privée : ${PRIVATE_KEY}\nClé publique : ${pubFile}\nEmpreinte : ${keyId(k.publicPem)}\nSauvegardez la clé privée en lieu sûr (hors de cet ordinateur).`);
