import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'control-center');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const STYLES = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

export function renderControlCenter(): string {
  return INDEX;
}

export function readControlCenterAsset(name: 'app.js' | 'styles.css'): string {
  return name === 'app.js' ? APP : STYLES;
}
