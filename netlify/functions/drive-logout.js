const {
  json,
  requestOrigin,
  assertAjaxRequest,
  cookieHeaderForClear,
} = require('./_lib/google');

exports.handler = async (event) => {
  const origin = requestOrigin(event);
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido' });
    assertAjaxRequest(event);
    return json(200, { disconnected: true }, { 'Set-Cookie': cookieHeaderForClear(origin) });
  } catch (error) {
    console.error('drive-logout', error);
    return json(error.statusCode || 500, { error: error.message || 'No se pudo cerrar sesión' }, {
      'Set-Cookie': cookieHeaderForClear(origin),
    });
  }
};
