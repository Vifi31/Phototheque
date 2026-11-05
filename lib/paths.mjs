// Emplacements des fichiers.
//  - ROOT : le programme (code, node_modules).
//  - HOME : les données de l'utilisateur. Par défaut ROOT (mode développement) ;
//           défini par PHOTOTHEQUE_HOME afin que le programme puisse rester en lecture
//           seule et que les données survivent aux mises à jour.
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// .env (facultatif) : ne remplace jamais une variable déjà définie dans l'environnement
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* pas de fichier .env */ }
const custom = process.env.PHOTOTHEQUE_HOME ? path.resolve(process.env.PHOTOTHEQUE_HOME) : null;
export const HOME = custom ?? ROOT;
export const INSTALLED = !!custom;
export const DATA_DIR = path.join(HOME, 'data');
export const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');   // cache de vignettes (régénérable)
export const DOCS_DIR = path.join(HOME, 'Documents');       // fichiers de travail (inclus dans les sauvegardes « données »)
export const IMPORT_DIR = path.join(HOME, 'Imports');       // destination par défaut des imports physiques
export const BACKUP_DIR = path.join(HOME, 'Sauvegardes');
export const VERSIONS_DIR = path.join(HOME, 'Versions');
export const REPORTS_DIR = path.join(HOME, 'Rapports');
export const EXPORT_DIR = path.join(HOME, 'Exports');     // photos exportées (jamais à côté des originaux)
export const PORT = Number(process.env.PHOTOTHEQUE_PORT || process.env.PORT || 3212);
