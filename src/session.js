export const AUTH_SESSION_KEY = 'northsouth:auth-session:v1';
const AUTH_SESSION_BACKUP_KEY = 'northsouth:auth-session:backup:v1';

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function loadAuthSession() {
  for (const key of [AUTH_SESSION_KEY, AUTH_SESSION_BACKUP_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const email = normalizeEmail(parsed?.email);
      if (!email) continue;
      const session = { email, name: String(parsed?.name || ''), verifiedAt: parsed?.verifiedAt || null };
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
      localStorage.setItem(AUTH_SESSION_BACKUP_KEY, JSON.stringify(session));
      return session;
    } catch { /* prueba la copia siguiente */ }
  }
  return null;
}

export function saveAuthSession(profile) {
  const email = normalizeEmail(profile?.email);
  if (!email) throw new Error('Google no devolvió un correo válido.');
  const session = { email, name: String(profile?.name || ''), verifiedAt: new Date().toISOString() };
  const serialized = JSON.stringify(session);
  localStorage.setItem(AUTH_SESSION_KEY, serialized);
  localStorage.setItem(AUTH_SESSION_BACKUP_KEY, serialized);
  return session;
}

export function clearAuthSession() {
  localStorage.removeItem(AUTH_SESSION_KEY);
  localStorage.removeItem(AUTH_SESSION_BACKUP_KEY);
}
