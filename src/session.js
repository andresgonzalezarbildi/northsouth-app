export const AUTH_SESSION_KEY = 'northsouth:auth-session:v1';

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function loadAuthSession() {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const email = normalizeEmail(parsed?.email);
    if (!email) {
      localStorage.removeItem(AUTH_SESSION_KEY);
      return null;
    }
    return { email, name: String(parsed?.name || ''), verifiedAt: parsed?.verifiedAt || null };
  } catch {
    return null;
  }
}

export function saveAuthSession(profile) {
  const email = normalizeEmail(profile?.email);
  if (!email) throw new Error('Google no devolvió un correo válido.');
  const session = { email, name: String(profile?.name || ''), verifiedAt: new Date().toISOString() };
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  return session;
}

export function clearAuthSession() {
  localStorage.removeItem(AUTH_SESSION_KEY);
}
