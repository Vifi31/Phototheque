// Identité de l'application, lue dans app.config.json (à la racine). Modifiez ce fichier pour renommer le modèle.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8')); } catch { /* valeurs par défaut */ }
export const APP = {
  name: 'Phototheque', slug: 'phototheque', env: 'PHOTOTHEQUE', product: 'Photothèque', holder: 'Vincent Fillaux', description: '', tagline: 'Photothèque', icon: '📷', port: 3212, features: [],
  ...cfg,
};
