import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const manifest = path.resolve('android/app/src/main/AndroidManifest.xml');

try {
  await access(manifest);
} catch {
  console.log('[android] AndroidManifest no disponible todavía; se omite la configuración del teclado.');
  process.exit(0);
}

let source = await readFile(manifest, 'utf8');
if (!source.includes('android:windowSoftInputMode="adjustResize"')) {
  source = source.replace(
    /(android:launchMode=["']singleTask["'])/,
    '$1\n            android:windowSoftInputMode="adjustResize"'
  );
}

await writeFile(manifest, source);
console.log('[android] Teclado configurado con adjustResize.');
