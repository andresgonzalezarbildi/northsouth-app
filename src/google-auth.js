const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const WEB_TOKEN_KEY = 'northsouth:google-token-session';
let initializedFor = null;
let memoryToken = null;
let nativePlugin = null;
let gisPromise = null;

function isNative() {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

function tokenString(accessToken) {
  if (!accessToken) return null;
  if (typeof accessToken === 'string') return accessToken;
  return accessToken.token || accessToken.accessToken || null;
}

async function getNativePlugin() {
  if (!nativePlugin) {
    const mod = await import('@capgo/capacitor-social-login');
    nativePlugin = mod.SocialLogin;
  }
  return nativePlugin;
}

function loadGIS() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('No se pudo cargar el inicio de sesión de Google.'));
    document.head.appendChild(script);
  });
  return gisPromise;
}

function saveWebToken(token, expiresIn = 3500) {
  memoryToken = token;
  sessionStorage.setItem(WEB_TOKEN_KEY, JSON.stringify({
    token,
    expiresAt: Date.now() + Math.max(60, Number(expiresIn || 3500) - 60) * 1000
  }));
}

function restoreWebToken() {
  if (memoryToken) return memoryToken;
  try {
    const saved = JSON.parse(sessionStorage.getItem(WEB_TOKEN_KEY) || 'null');
    if (saved?.token && Number(saved.expiresAt) > Date.now()) {
      memoryToken = saved.token;
      return memoryToken;
    }
  } catch { /* noop */ }
  sessionStorage.removeItem(WEB_TOKEN_KEY);
  return null;
}

async function webProfile(token) {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function initGoogle(webClientId) {
  if (!webClientId) throw new Error('Falta configurar el ID de cliente Web de Google.');
  if (!isNative()) {
    await loadGIS();
    initializedFor = webClientId;
    return;
  }
  if (initializedFor === webClientId) return;
  const SocialLogin = await getNativePlugin();
  await SocialLogin.initialize({ google: { webClientId, mode: 'online' } });
  initializedFor = webClientId;
}

export async function connectGoogle(webClientId, { selectAccount = true } = {}) {
  await initGoogle(webClientId);

  if (!isNative()) {
    const tokenResult = await new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: webClientId,
        scope: `openid email profile ${DRIVE_SCOPE}`,
        callback: response => response?.error ? reject(new Error(response.error_description || response.error)) : resolve(response)
      });
      client.requestAccessToken({ prompt: selectAccount ? 'select_account' : '' });
    });
    if (!tokenResult?.access_token) throw new Error('Google no devolvió un token con acceso a Drive.');
    saveWebToken(tokenResult.access_token, tokenResult.expires_in);
    const profile = await webProfile(tokenResult.access_token);
    return { token: tokenResult.access_token, profile: profile ? { email: profile.email, name: profile.name } : null };
  }

  const SocialLogin = await getNativePlugin();
  const res = await SocialLogin.login({
    provider: 'google',
    options: { scopes: ['openid', 'email', 'profile', DRIVE_SCOPE] }
  });
  const token = tokenString(res?.result?.accessToken);
  if (!token) throw new Error('Google no devolvió un token con acceso a Drive.');
  memoryToken = token;
  return { token, profile: res?.result?.profile || null };
}

export async function restoreGoogleToken(webClientId) {
  if (!isNative()) return restoreWebToken();
  if (memoryToken) return memoryToken;
  if (!webClientId) return null;
  try {
    await initGoogle(webClientId);
    const SocialLogin = await getNativePlugin();
    const status = await SocialLogin.isLoggedIn({ provider: 'google' });
    if (!status?.isLoggedIn) return null;
    const auth = await SocialLogin.getAuthorizationCode({ provider: 'google' });
    const token = tokenString(auth?.accessToken);
    if (token) memoryToken = token;
    return token;
  } catch {
    return null;
  }
}

export async function disconnectGoogle() {
  if (!isNative()) {
    const token = restoreWebToken();
    try {
      if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => {});
    } catch { /* noop */ }
    sessionStorage.removeItem(WEB_TOKEN_KEY);
    memoryToken = null;
    return;
  }
  try {
    const SocialLogin = await getNativePlugin();
    await SocialLogin.logout({ provider: 'google' });
  } catch { /* noop */ }
  memoryToken = null;
}
