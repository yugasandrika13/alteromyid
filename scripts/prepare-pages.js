const fs = require('fs');
const path = require('path');

const root = process.cwd();
const outDir = path.join(root, 'public');

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { }
}

function mkdirp(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function shouldSkip(rel) {
  const top = rel.split(path.sep)[0];
  if (top === 'public') return true;
  if (top === 'node_modules') return true;
  if (top === '.git') return true;
  if (top === '.github') return true;
  if (top === '.sync-meta') return true;
  if (top === 'scripts' && rel !== 'scripts') return false;
  if (rel === 'scripts') return true;
  if (rel === '_worker.js') return true;
  if (rel === 'wrangler.jsonc') return true;
  if (rel === 'package.json') return true;
  if (rel === 'package-lock.json') return true;
  if (top === 'tests') return true;
  return false;
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function walkAndCopy(srcRoot, destRoot, relBase = '') {
  const dir = path.join(srcRoot, relBase);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const rel = path.join(relBase, ent.name);
    if (shouldSkip(rel)) continue;
    const srcPath = path.join(srcRoot, rel);
    const destPath = path.join(destRoot, rel);
    if (ent.isDirectory()) {
      walkAndCopy(srcRoot, destRoot, rel);
    } else if (ent.isFile()) {
      copyFile(srcPath, destPath);
    }
  }
}

rmrf(outDir);
mkdirp(outDir);
walkAndCopy(root, outDir, '');
process.stdout.write(`Built Pages assets to: ${outDir}\n`);

