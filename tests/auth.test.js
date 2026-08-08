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
