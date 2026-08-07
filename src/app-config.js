const viteEnv = import.meta.env || {};
const runtime = globalThis.NORTH_SOUTH_CONFIG || {};

function splitEmails(value) {
  const source = Array.isArray(value) ? value.join(',') : String(value || '');
  return [...new Set(source.split(',').map(x => x.trim().toLowerCase()).filter(Boolean))];
}

export const GOOGLE_WEB_CLIENT_ID = String(runtime.googleWebClientId || viteEnv.VITE_GOOGLE_WEB_CLIENT_ID || '').trim();
export const ALLOWED_EMAILS = splitEmails(runtime.allowedEmails || viteEnv.VITE_ALLOWED_EMAILS || '');

export function isAllowedEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return Boolean(normalized && ALLOWED_EMAILS.includes(normalized));
}
