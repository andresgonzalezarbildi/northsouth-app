import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const drive = await readFile(new URL('../src/drive-sync.js', import.meta.url), 'utf8');

async function doesNotExist(url) {
  try { await access(url); return false; }
  catch { return true; }
}

test('Drive usa exclusivamente appDataFolder', () => {
  assert.match(drive, /spaces=appDataFolder/);
  assert.match(drive, /parents: \['appDataFolder'\]/);
});

test('la app no depende de una whitelist de correos', () => {
  assert.equal(main.includes('VITE_ALLOWED_EMAILS'), false);
  assert.equal(main.includes('isAllowedEmail'), false);
});

test('se valida que el token restaurado pertenezca a la misma cuenta local', () => {
  assert.match(main, /tokenEmail !== state\.account\.email/);
});

test('los archivos con datos precargados no forman parte del proyecto', async () => {
  assert.equal(await doesNotExist(new URL('../src/seed-data.js', import.meta.url)), true);
  assert.equal(await doesNotExist(new URL('../migration/legacy-seed.js', import.meta.url)), true);
});
