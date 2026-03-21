import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(projectRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const targetDir = path.join(projectRoot, 'public', 'assets', 'mediapipe', 'wasm');

if (!fs.existsSync(sourceDir)) {
  console.warn('[vendor-mediapipe] Skipping copy because wasm assets were not found yet.');
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });

for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile()) {
    continue;
  }

  fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
}

console.log(`[vendor-mediapipe] Copied MediaPipe wasm assets to ${targetDir}`);
