const crypto = require('node:crypto');

const COOKIE_NAME = 'cronograma_google_session';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function env(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function clientId() {
  return env('GOOGLE_CLIENT_ID');
}

function clientSecret() {
  return env('GOOGLE_CLIENT_SECRET');
}

function encryptionKey() {
  return crypto.createHash('sha256').update(env('SESSION_SECRET')).digest();
}

function encodeSession(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const clear = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

function decodeSession(value) {
  if (!value) return null;
  try {
    const [ivRaw, tagRaw, dataRaw] = String(value).split('.');
    if (!ivRaw || !tagRaw || !dataRaw) return null;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(ivRaw, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(dataRaw, 'base64url')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(clear.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseCookies(event) {
  const raw = event.headers?.cookie || event.headers?.Cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function sessionCookie(value, { clear = false, secure = true } = {}) {
  const parts = [
    `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  if (clear) {
    parts.push('Max-Age=0');
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  } else {
    parts.push(`Max-Age=${60 * 60 * 24 * 365}`);
  }
  return parts.join('; ');
}

function clearSessionCookie(secure = true) {
  return sessionCookie('', { clear: true, secure });
}

function requestOrigin(event) {
  return String(event.headers?.origin || event.headers?.Origin || '').trim();
}

function isLocalOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin || '');
}

function secureCookieForOrigin(origin) {
  return !isLocalOrigin(origin);
}

function assertAjaxRequest(event) {
  const header = String(event.headers?.['x-requested-with'] || event.headers?.['X-Requested-With'] || '');
  if (header.toLowerCase() !== 'xmlhttprequest') {
    const error = new Error('Solicitud no válida');
    error.statusCode = 403;
    throw error;
  }
}

function readSession(event) {
  const cookies = parseCookies(event);
  return decodeSession(cookies[COOKIE_NAME]);
}

async function googleTokenRequest(params) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error_description || body.error || `Google OAuth respondió ${response.status}`);
    error.statusCode = body.error === 'invalid_grant' ? 401 : response.status;
    error.oauthError = body.error || '';
    throw error;
  }
  return body;
}

async function exchangeCode(code, redirectUri) {
  return googleTokenRequest({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
}

async function refreshTokens(refreshToken) {
  return googleTokenRequest({
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: 'refresh_token',
  });
}

function sessionFromTokenResponse(tokenResponse, previous = {}) {
  const refreshToken = tokenResponse.refresh_token || previous.refreshToken;
  if (!refreshToken) {
    const error = new Error('Google no devolvió un refresh token. Volvé a autorizar la aplicación.');
    error.statusCode = 401;
    throw error;
  }
  const expiresIn = Math.max(60, Number(tokenResponse.expires_in) || 3600);
  return {
    refreshToken,
    accessToken: tokenResponse.access_token || previous.accessToken || '',
    expiresAt: Date.now() + expiresIn * 1000,
    scope: tokenResponse.scope || previous.scope || DRIVE_SCOPE,
  };
}

async function accessForEvent(event) {
  const session = readSession(event);
  if (!session?.refreshToken) {
    const error = new Error('No hay una sesión de Google activa');
    error.statusCode = 401;
    throw error;
  }

  if (session.accessToken && Number(session.expiresAt) > Date.now() + 90_000) {
    return { accessToken: session.accessToken, session, refreshed: false };
  }

  const refreshed = await refreshTokens(session.refreshToken);
  const nextSession = sessionFromTokenResponse(refreshed, session);
  return { accessToken: nextSession.accessToken, session: nextSession, refreshed: true };
}

function authHeaders(accessToken, extra = {}) {
  return { Authorization: `Bearer ${accessToken}`, ...extra };
}

async function googleFetch(accessToken, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: authHeaders(accessToken, options.headers || {}),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || body?.error_description || body?.error || '';
    } catch {
      detail = await response.text().catch(() => '');
    }
    const error = new Error(detail || `Google API respondió ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return response;
}

async function fetchDriveUser(accessToken) {
  const response = await googleFetch(
    accessToken,
    'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,permissionId)'
  );
  const body = await response.json();
  return body.user || {};
}

async function revokeToken(token) {
  if (!token) return;
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }).catch(() => {});
}

function cookieHeaderForSession(session, origin) {
  return sessionCookie(encodeSession(session), { secure: secureCookieForOrigin(origin) });
}

function cookieHeaderForClear(origin) {
  return clearSessionCookie(secureCookieForOrigin(origin));
}

module.exports = {
  COOKIE_NAME,
  DRIVE_SCOPE,
  json,
  clientId,
  requestOrigin,
  assertAjaxRequest,
  exchangeCode,
  sessionFromTokenResponse,
  accessForEvent,
  fetchDriveUser,
  revokeToken,
  readSession,
  cookieHeaderForSession,
  cookieHeaderForClear,
  secureCookieForOrigin,
  googleFetch,
};
