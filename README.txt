CRONOGRAMA · SEGUNDO SEMESTRE 2026 · v13

El cronograma muestra el contenido publicado por las materias, agrupado por semana. No inventa un plan diario de estudio.

Contenido:
- Redes: temas, clases OpenFing, lecturas/capítulos, prácticos útiles, monitoreos, defensas y obligatorios, evitando tarjetas redundantes.
- FuAA: temas, OpenFing, secciones del libro, prácticos, cuestionarios, controles y parciales. Se quitaron discusiones y contenido administrativo que no aportaba al seguimiento.
- FBD: cronograma semanal con temas teóricos, OpenFing y teórico-prácticos.
- IntroPLN: 20 clases OpenFing en orden, sin asignarlas a semanas mientras no haya cronograma oficial.

Interacción:
- Filtros por todas, semana actual, materia y entregas/prácticos/laboratorios.
- Al completar una tarjeta queda unos segundos visible para poder deshacer antes de pasar a Completadas.
- Completadas queda colapsado por defecto.
- Semanas colapsables con +/−.
- Importantes resaltadas.
- Reordenamiento por arrastre dentro de la semana.
- Accesos rápidos Arriba y Completadas.

Google Drive · v13:
- Sigue sin usar base de datos: el estado canónico se guarda en appDataFolder de Google Drive.
- Ahora usa Authorization Code Flow + Netlify Functions para obtener un refresh token de forma segura.
- La sesión queda en una cookie HttpOnly cifrada y se recupera automáticamente al volver a abrir el sitio. Desconectar cierra solamente esa PC.
- Los access tokens se renuevan del lado servidor; ya no hay que reconectar cada hora.
- Cada cambio local se sincroniza tras una pausa breve.
- Además se consulta Drive cada 12 segundos mientras la pestaña está visible, para recibir cambios de otras PCs.
- Las escrituras usan ETag + reintento de lectura/mezcla/escritura para evitar que dos PCs se pisen cambios simultáneos.
- Los cambios pendientes se resuelven por tarjeta y el servidor asigna la hora al sincronizarlos, por lo que no depende del reloj de cada PC.

Configuración:
Ver CONFIGURAR_GOOGLE_DRIVE.txt. Esta versión requiere Netlify Functions y tres variables de entorno: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y SESSION_SECRET. El Client ID ya no se duplica en google-drive-config.js.

Pruebas:
  node tests/validate-data.mjs
  node tests/validate-ui.mjs
