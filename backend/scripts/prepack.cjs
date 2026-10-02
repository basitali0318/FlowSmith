// Bundles the built React app and the repo docs into the npm package so `npx @basitali0318/flowsmith` is self-contained.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const front = path.resolve(root, '../frontend/dist');
if (!fs.existsSync(path.join(front, 'index.html'))) {
  console.error('frontend/dist not found - run `npm run build` at the repository root before packing.');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'dist/main.js'))) {
  console.error('backend/dist not found - run `npm run build` at the repository root before packing.');
  process.exit(1);
}
fs.rmSync(path.join(root, 'public'), { recursive: true, force: true });
fs.cpSync(front, path.join(root, 'public'), { recursive: true });
for (const f of ['README.md', 'LICENSE']) fs.copyFileSync(path.resolve(root, '..', f), path.join(root, f));
