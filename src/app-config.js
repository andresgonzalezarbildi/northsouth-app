const viteEnv = import.meta.env || {};
const runtime = globalThis.NORTH_SOUTH_CONFIG || {};

export const GOOGLE_WEB_CLIENT_ID = String(
  runtime.googleWebClientId || viteEnv.VITE_GOOGLE_WEB_CLIENT_ID || ''
).trim();
