// Vérifie une distribution ou une installation de Photothèque (empreintes SHA-256 et signature Ed25519).
//
//   node scripts/verifier.mjs [dossier] [--cle fichier.pem] [--signature-obligatoire] [--json]
//
// Sans --cle, la clé publique livrée dans le dossier est utilisée (contrôle d'intégrité). Pour une mise à
// jour, l'installateur passe la clé de la version déjà installée. Code de sortie : 0 si tout est conforme.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyDist } from '../lib/dist.mjs';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const dir = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--cle') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const keyFile = opt('--cle');
const r = verifyDist(dir, { publicPem: keyFile ? fs.readFileSync(keyFile, 'utf8') : null, requireSignature: args.includes('--signature-obligatoire') });
if (args.includes('--json')) console.log(JSON.stringify(r));
else {
  console.log(`Dossier : ${dir}`);
  console.log(`Fichiers contrôlés : ${r.files ?? 0}`);
  console.log(`Intégrité : ${r.intact ? 'conforme' : 'NON CONFORME'}`);
  console.log(`Signature : ${r.signed ? `valide (clé ${r.keyId})` : r.hasSignature ? 'INVALIDE' : 'absente'}`);
  for (const [k, l] of [['modified', 'modifié'], ['missing', 'manquant'], ['added', 'ajouté']]) for (const f of (r[k] ?? []).slice(0, 20)) console.log(`  ${l} : ${f}`);
  if (r.error) console.log(r.error);
}
process.exit(r.ok ? 0 : 1);
