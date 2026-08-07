const {
  json,
  requestOrigin,
  accessForEvent,
  fetchDriveUser,
  cookieHeaderForSession,
  cookieHeaderForClear,
} = require('./_lib/google');

exports.handler = async (event) => {
  const origin = requestOrigin(event);
  try {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Método no permitido' });
    const auth = await accessForEvent(event);
    const user = await fetchDriveUser(auth.accessToken);
    const headers = auth.refreshed ? { 'Set-Cookie': cookieHeaderForSession(auth.session, origin) } : {};
    return json(200, { authenticated: true, user }, headers);
  } catch (error) {
    const headers = error.statusCode === 401 ? { 'Set-Cookie': cookieHeaderForClear(origin) } : {};
    if (error.statusCode !== 401) console.error('drive-session', error);
    return json(error.statusCode || 500, {
      authenticated: false,
      error: error.message || 'No se pudo recuperar la sesión',
    }, headers);
  }
};
