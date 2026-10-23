import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaging prep: the OCR helper is macOS-only, so the staging dir always exists
// (electron-builder needs a stable extraResources source) but only gains the
// compiled helper on darwin. Win/Linux packages ship it empty.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'dist', 'package-native', 'native'), { recursive: true });
if (process.platform === 'darwin') {
  process.env.RLW_BUILD_DIR = path.join(root, 'dist', 'package-native');
  await import('./build-ocr-helper.mjs');
} else {
  console.log('prepare-package: OCR helper skipped (macOS only).');
}
