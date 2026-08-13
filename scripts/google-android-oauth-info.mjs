import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
const appId = config.appId;
const androidDir = path.join(root, 'android');
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

if (!fs.existsSync(androidDir)) {
  console.error('No existe la carpeta android. Ejecutá primero: npx cap add android');
  process.exit(1);
}

const result = spawnSync(gradle, ['signingReport'], {
  cwd: androidDir,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const output = `${result.stdout || ''}\n${result.stderr || ''}`;
if (result.status !== 0) {
  process.stdout.write(output);
  process.exit(result.status ?? 1);
}

const debugSection = output.match(/Variant:\s*debug[\s\S]*?(?=Variant:|$)/i)?.[0] || output;
const sha1 = debugSection.match(/SHA1:\s*([0-9A-F:]+)/i)?.[1] || null;

console.log('\n=== Google OAuth Android ===');
console.log(`Package: ${appId}`);
console.log(`SHA-1 debug: ${sha1 || 'No se pudo detectar automáticamente'}`);
console.log('\nEn Google Cloud creá un OAuth Client ID de tipo Android con exactamente esos dos valores.');
console.log('El webClientId del código debe seguir siendo el Client ID de tipo Web, no el Android.\n');

if (!sha1) {
  console.log('Salida completa de signingReport:\n');
  process.stdout.write(output);
}
