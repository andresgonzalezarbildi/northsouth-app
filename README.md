# North South Academy Manager v4

Aplicación local-first para socios, cuotas y cantina de North South Academy.

## Qué cambió en esta versión

- Corregido el error que hacía que los botones `Guardar` de los modales cerraran la ventana antes de enviar el formulario. Era la causa de que pagos, socios, productos y ventas parecieran no guardarse en localhost.
- La app funciona y persiste completamente en local sin Google Auth ni Drive. Drive es solo una capa de sincronización opcional.
- Al abrir la ficha de un socio desde una lista larga, se conserva la posición de scroll al abrir/cerrar la ficha.
- Productos de cantina: se pueden dejar activos/inactivos, filtrar por estado y eliminar.
- Al eliminar un producto se conserva su nombre/emoji en las ventas históricas.

- Todos los cambios se guardan primero en `localStorage`, aunque no haya internet ni Drive.
- Socios, pagos, productos y ventas de cantina persisten y entran en la sincronización.
- La sincronización fusiona registros por `id` + `updatedAt` en vez de reemplazar el archivo completo.
- El botón Cobrar actualiza el saldo del socio inmediatamente después de guardar.
- Últimos movimientos se ordena por `createdAt` (momento en que se agregó el movimiento), no por el mes que cubre.
- Búsqueda aproximada: por ejemplo `andes` puede encontrar `ANDRES`.
- El selector de socio en cobros y cantina es un buscador con sugerencias mientras se escribe.
- Nueva vista `Cuotas`, con socios en filas y meses en columnas, incluyendo pagos adelantados.
- La cuota general usa historial por mes: cambiarla desde septiembre no modifica julio/agosto.
- Cantina: productos con nombre, emoji, precio habitual y ventas asociadas a socios.
- El logo vuelve al Panel.
- Cada cambio de pantalla limpia el buscador de la vista anterior.
- Dos acciones fijas arriba: `Registrar pago` y `Venta cantina`.
- PWA instalable en PC para usar exactamente la misma interfaz como aplicación de escritorio.

## Probar sin instalar npm

En Windows podés ejecutar:

`ABRIR-APP-LOCAL.bat`

Levanta un servidor local con Python en `http://localhost:5173` y abre la aplicación. No necesita internet para usar los datos locales.

> Para esta modalidad, si querés probar Drive sin Vite, podés colocar temporalmente el Web Client ID en `src/app-config.js`.

## Desarrollo normal

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

Tests:

```bash
npm test
```

## Configuración de Google Drive

La configuración OAuth no se ingresa dentro de la app.

### 1. Web Client ID

Crear un archivo `.env` en la raíz a partir de `.env.example`:

```env
VITE_GOOGLE_WEB_CLIENT_ID=TU_CLIENT_ID.apps.googleusercontent.com
```

También existe `src/app-config.js` como alternativa de configuración fija para builds locales.

### 2. Google Cloud

En el mismo proyecto de Google Cloud:

1. Habilitar Google Drive API.
2. Configurar OAuth consent screen.
3. Agregar el scope `https://www.googleapis.com/auth/drive.appdata`.
4. Crear un OAuth Client ID de tipo Web application.
5. En Authorized JavaScript origins agregar las URLs usadas por la web, por ejemplo el dominio de producción y `http://localhost:5173` para desarrollo.
6. Copiar ese Web Client ID al `.env`.

La aplicación guarda `north-south-data.json` en `appDataFolder`, un espacio privado de Drive no visible como archivo normal para el usuario.

### 3. Android

El package de la app es:

`uy.com.northsouth.academy`

Después de crear Android con Capacitor:

```bash
npm run build
npx cap add android
npx cap sync
npx cap open android
```

En Google Cloud crear además un OAuth Client ID de tipo Android con:

- Package: `uy.com.northsouth.academy`
- SHA-1 de la clave que firma el APK.

Para debug:

```bash
cd android
gradlew signingReport
```

Para un APK release firmado se debe registrar el SHA-1 de esa firma. Si más adelante se publica en Play Store, también corresponde registrar el SHA-1 de Play App Signing.

El valor que usa `webClientId` dentro de la aplicación sigue siendo el Client ID **Web**, no el Client ID Android.

## Uso en PC como app de escritorio

La versión recomendada es la PWA:

1. Publicar el build web en HTTPS.
2. Abrirlo una vez en Chrome o Edge.
3. Elegir `Instalar aplicación` o usar el botón `Instalar en esta PC` si el navegador ofrece el evento de instalación.

Después queda como aplicación separada, con icono propio, almacenamiento local y funcionamiento offline. Cuando vuelve internet, sincroniza con Drive.

Esto evita Electron y mantiene exactamente el mismo código e interfaz que la web/Capacitor.

## Persistencia y sincronización

Estructura sincronizada:

- `members`
- `payments`
- `products`
- `sales`
- historial de cuota general
- ajustes simples

Cada socio/pago/producto/venta tiene `id`, `createdAt` y `updatedAt`. Al sincronizar se elige la versión más reciente de cada registro individual. Los registros nuevos de otro dispositivo se conservan.

## Tests

La versión incluye tests para:

- pagos parciales y saldo mensual;
- historial de cuota sin deuda retroactiva;
- cuotas especiales;
- búsqueda aproximada;
- orden de movimientos por agregado;
- merge entre dispositivos;
- productos y ventas de cantina;
- persistencia local de socios, pagos, productos y ventas.
