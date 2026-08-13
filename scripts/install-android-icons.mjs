import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve('resources/android-icons');
const targetRoot = path.resolve('android/app/src/main/res');

if (!fs.existsSync(targetRoot)) {
  console.log('[android] Proyecto Android no disponible; se omite el icono.');
  process.exit(0);
}
if (!fs.existsSync(sourceRoot)) {
  throw new Error(`No se encontraron los iconos preparados en ${sourceRoot}`);
}

for (const dirent of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  const srcDir = path.join(sourceRoot, dirent.name);
  const dstDir = path.join(targetRoot, dirent.name);
  fs.mkdirSync(dstDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
  }
}

console.log('[android] Icono North South aplicado al launcher.');
