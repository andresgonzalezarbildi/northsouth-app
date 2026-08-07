# North South Academy — v6

Gestión de socios, cuotas, pagos y cantina. El mismo frontend sirve para web/PWA de escritorio y para Android mediante Capacitor.

## Qué cambió en v6

- La app ahora exige inicio de sesión con Google antes de mostrar datos.
- Solo entran los correos definidos en `VITE_ALLOWED_EMAILS`.
- Cada cuenta tiene su propio almacenamiento local.
- Una cuenta nueva empieza vacía: los datos de la planilla ya no vienen precargados.
- `IMPORTAR-DATOS-ACTUALES.json` contiene la importación inicial de la planilla y se carga manualmente desde Ajustes.
- Socios, pagos, productos y ventas se guardan primero en `localStorage`; Drive no es necesario para trabajar.
- Después del primer inicio de sesión, la sesión queda recordada y la app puede abrir offline en ese dispositivo.
- Drive se usa únicamente como sincronización cuando hay conexión.
- El ID OAuth se configura al preparar la app; nunca se pide dentro de la interfaz.
- En desarrollo se eliminan service workers viejos de localhost para evitar cargar una versión anterior desde caché.
- Se restauró el logo como marca de agua de fondo.

## Probar en PC

1. Instalar Node.js.
2. En esta carpeta ejecutar:

```bash
npm install
```

3. Copiar `.env.example` como `.env` y completar los valores.
4. Ejecutar:

```bash
npm run dev
```

Luego abrir `http://localhost:5173`.

También se puede usar `ABRIR-APP-LOCAL.bat`; ahora hace exactamente lo mismo: instala dependencias si faltan, inicia Vite y abre localhost.

> Si modificás `.env` mientras Vite está abierto, cerrá `npm run dev` y volvelo a iniciar. Vite lee esas variables al arrancar.

## Configuración `.env`

```env
VITE_GOOGLE_WEB_CLIENT_ID=TU_CLIENT_ID_WEB.apps.googleusercontent.com
VITE_ALLOWED_EMAILS=correo1@gmail.com,correo2@gmail.com
```

`VITE_GOOGLE_WEB_CLIENT_ID` es un identificador público de OAuth, no una contraseña. No debe ponerse un client secret en esta app.

## Primera carga de los datos actuales

La app ya no trae socios ni pagos por defecto.

1. Iniciar sesión con la cuenta del profesor.
2. Ir a **Ajustes → Datos y respaldo → Importar respaldo**.
3. Elegir `IMPORTAR-DATOS-ACTUALES.json`.

A partir de ahí esos datos pertenecen al almacenamiento de esa cuenta y luego pueden sincronizarse con su Drive.

Si el navegador conserva datos creados con la versión 4, Ajustes muestra **Descargar datos de la versión anterior**. Se descargan y luego se importan en la cuenta correcta.

## Cómo funciona el guardado

El orden es deliberadamente:

1. Se modifica la app.
2. Se guarda y verifica en `localStorage` de la cuenta activa.
3. La interfaz se actualiza inmediatamente.
4. Si hay internet y Drive está autorizado, se sincroniza después.

Por lo tanto registrar socios, cuotas, pagos, productos y ventas no depende de Drive ni de internet.

La clave local queda separada por correo, por ejemplo:

```text
northsouth:data:v4:correo%40gmail.com
```

## Google Auth + Drive

En Google Cloud Console:

1. Crear el proyecto de North South.
2. Habilitar **Google Drive API**.
3. Configurar la pantalla de consentimiento OAuth.
4. Crear un **OAuth Client ID de tipo Web application**.
5. En orígenes autorizados agregar para desarrollo:

```text
http://localhost:5173
```

6. Agregar también el dominio HTTPS definitivo de la web cuando se publique.
7. Copiar ese Web Client ID a `VITE_GOOGLE_WEB_CLIENT_ID`.
8. Escribir en `VITE_ALLOWED_EMAILS` los correos que querés habilitar.

Al pulsar **Ingresar con Google**, la app solicita identidad y acceso únicamente a `drive.appdata`. No hay una clave OAuth que el usuario deba escribir.

La sincronización guarda `north-south-data.json` en `appDataFolder` de Google Drive y fusiona registros por ID/fecha antes de escribir, para no reemplazar indiscriminadamente los cambios locales de otro dispositivo.

### Importante sobre varias cuentas

`appDataFolder` pertenece a cada cuenta de Google. Si habilitás dos correos, ambos pueden usar la aplicación, pero cada uno tendrá su propio conjunto de datos de Drive. Para el uso previsto de un único profesor esto es lo adecuado. Si más adelante querés dos usuarios distintos trabajando sobre exactamente la misma base, habría que cambiar el esquema de sincronización.

## Instalar en la PC

La opción **Instalar aplicación** es la instalación PWA del navegador. Aparece cuando la versión está publicada por HTTPS y Chrome/Edge consideran que la web es instalable.

Al instalarla:

- aparece como aplicación independiente en Windows;
- abre sin pestañas del navegador;
- conserva datos localmente;
- puede seguir funcionando sin internet;
- sincroniza con Drive al recuperar conexión.

En localhost no es necesario instalarla: se usa `npm run dev` o `ABRIR-APP-LOCAL.bat`.

## Android / Capacitor

El package configurado es:

```text
uy.com.northsouth.academy
```

Comandos:

```bash
npm install
npm run build
npx cap add android
npx cap sync
npx cap open android
```

Para Google en Android hay que crear además un OAuth Client ID de tipo Android con:

- package: `uy.com.northsouth.academy`
- SHA-1 de la firma usada para el APK

El Web Client ID sigue configurado en `.env`; no se escribe desde la app.

## Tests

```bash
npm test
```

Actualmente: **18/18 tests pasando**.
