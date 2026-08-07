const {
  json,
  clientId,
  requestOrigin,
  assertAjaxRequest,
  exchangeCode,
  sessionFromTokenResponse,
  fetchDriveUser,
  cookieHeaderForSession,
} = require('./_lib/google');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido' });
    assertAjaxRequest(event);

    const origin = requestOrigin(event);
    const body = JSON.parse(event.body || '{}');
    const code = String(body.code || '').trim();
    const redirectUri = String(body.redirectUri || '').trim();
    if (!code || !redirectUri) return json(400, { error: 'Falta el código de autorización' });
    if (!origin || redirectUri !== origin) return json(403, { error: 'Origen de autorización inválido' });

    const tokenResponse = await exchangeCode(code, redirectUri);
    const session = sessionFromTokenResponse(tokenResponse);
    const user = await fetchDriveUser(session.accessToken);

    return json(200, {
      authenticated: true,
      user,
      clientId: clientId(),
    }, {
      'Set-Cookie': cookieHeaderForSession(session, origin),
    });
  } catch (error) {
    console.error('drive-auth', error);
    return json(error.statusCode || 500, { error: error.message || 'No se pudo iniciar sesión con Google' });
  }
};
