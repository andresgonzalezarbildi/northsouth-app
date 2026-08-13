import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor(){ this.map = new Map(); }
  getItem(k){ return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k,v){ this.map.set(k, String(v)); }
  removeItem(k){ this.map.delete(k); }
}

globalThis.localStorage = new MemoryStorage();

const { saveAuthSession, loadAuthSession, clearAuthSession } = await import('../src/session.js');

test('cualquier correo autenticado por Google puede tener sesión local', () => {
  saveAuthSession({ email:'Usuario.Nuevo@Example.com', name:'Usuario' });
  assert.equal(loadAuthSession().email, 'usuario.nuevo@example.com');
});

test('cerrar sesión elimina solamente la sesión de autenticación', () => {
  clearAuthSession();
  assert.equal(loadAuthSession(), null);
});

test('la UI separa sesión local de autorización temporal de Drive', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/google-auth.js', import.meta.url), 'utf8'));
  assert.match(source, /memoryTokenExpiresAt/);
  assert.match(source, /invalidateGoogleToken/);
  assert.match(source, /memoryTokenExpiresAt > Date\.now\(\)/);
});


test('Android conserva el parche nativo requerido para scopes adicionales de Google', async () => {
  const fs = await import('node:fs/promises');
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const patch = await fs.readFile(new URL('../scripts/patch-android-social-login.mjs', import.meta.url), 'utf8');

  assert.equal(packageJson.scripts['capacitor:sync:after'], 'node scripts/patch-android-social-login.mjs');
  assert.match(patch, /ModifiedMainActivityForSocialLoginPlugin/);
  assert.match(patch, /handleGoogleLoginIntent/);
  assert.match(patch, /REQUEST_AUTHORIZE_GOOGLE_MIN/);
});
