const { json, clientId } = require('./_lib/google');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Método no permitido' });
    return json(200, { clientId: clientId() }, {
      'Cache-Control': 'no-store, max-age=0'
    });
  } catch (error) {
    console.error('drive-config', error);
    return json(error.statusCode || 500, { error: error.message || 'No se pudo cargar la configuración' });
  }
};
