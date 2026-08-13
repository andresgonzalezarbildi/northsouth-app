import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('el backdrop del modal no captura el click de los botones submit', () => {
  assert.equal(source.includes('class="modal-backdrop" data-action="close-modal"'), false);
  assert.equal(source.includes('data-modal-backdrop'), true);
  assert.match(source, /if\(event\.target\.matches\('\[data-modal-backdrop\]'\)\)/);
});

test('productos permiten estado activo/inactivo y borrado', () => {
  assert.match(source, /name="active"/);
  assert.match(source, /data-action="delete-product"/);
  assert.match(source, /data-product-filter/);
});

test('los guardados de modales tienen acciones directas', () => {
  assert.match(source, /data-action="save-member"/);
  assert.match(source, /data-action="save-payment"/);
  assert.match(source, /data-action="save-sale"/);
  assert.match(source, /data-action="save-product"/);
  assert.match(source, /requestSubmit\(\)/);
});

test('la app bloquea la interfaz hasta tener cuenta', () => {
  assert.match(source, /function renderLogin\(\)/);
  assert.match(source, /if \(!state\.account \|\| !state\.data\)/);
  assert.match(source, /data-action="login-google"/);
});

test('el monto del pago conserva el texto mientras se escribe y distribuye excedentes', () => {
  assert.match(source, /state\.modal\.draft\.amount=event\.target\.value/);
  assert.match(source, /allocatePaymentAmount\(/);
  assert.match(source, /excedente aplicado a los meses siguientes/);
});

test('cantina permite e identifica ventas sin socio', () => {
  assert.match(source, /Dejá vacío para venta sin socio/);
  assert.match(source, /Venta sin socio/);
  assert.match(source, /\$\{!product\|\|total<=0\?'disabled':''\}/);
});

test('el guardado crea un log local antes de sincronizar', () => {
  assert.match(source, /createOperation\(before, state\.data/);
  assert.match(source, /Guardado en este dispositivo/);
  assert.match(source, /Registro de cambios/);
});

test('una sincronización no reemplaza cambios hechos mientras estaba en curso', () => {
  assert.match(source, /const syncStartData = structuredClone\(state\.data\)/);
  assert.match(source, /mergeData\(state\.data, result\.data\)/);
  assert.match(source, /pendingOperationCount\(\) > 0/);
});

test('borrar un pago distribuido elimina todo el lote', () => {
  assert.match(source, /livePayments\(state\.data\)\.filter\(x=>x\.batchId===p\.batchId\)/);
  assert.match(source, /Eliminar pago completo/);
});

test('ajustes no muestra migración anterior ni instalación en esta PC', () => {
  assert.equal(source.includes('Descargar datos de la versión anterior'), false);
  assert.equal(source.includes('App en esta PC'), false);
  assert.equal(source.includes('install-app'), false);
});

test('borrado total requiere la frase exacta y una nueva generación', () => {
  assert.match(source, /borrar datos northsouthjjm/);
  assert.match(source, /data-action="confirm-clear-data"/);
  assert.match(source, /north-south-academy-main:\$\{crypto\.randomUUID\(\)\}/);
  assert.match(source, /makeResetMarker\(datasetId/);
  assert.match(source, /reset\.meta\.reset=marker/);
  assert.match(source, /scheduleSync\(\)/);
});

test('escribir montos no reconstruye el modal en cada tecla', () => {
  assert.match(source, /state\.modal\.draft\.amount=event\.target\.value;/);
  assert.equal(source.includes('state.modal.draft.amount=event.target.value;rerenderFocused'), false);
});

test('la sincronización conserva scroll interno y la vista actual', () => {
  assert.match(source, /data-scroll-key="fees-table"/);
  assert.match(source, /function captureScrollState\(\)/);
  assert.match(source, /restoreScrollState\(scrollState\)/);
});

test('cuotas no queda accesible como vista en pantallas chicas', () => {
  assert.match(source, /view === 'fees' && compactViewport\(\)/);
  const mobileNav = source.match(/<nav class="mobile-nav">([\s\S]*?)<\/nav>/)?.[1] || '';
  assert.equal(mobileNav.includes('data-view="fees"'), false);
});

test('Drive muestra estados claros y sincronización automática', () => {
  assert.match(source, /const AUTO_SYNC_MS = 30000/);
  assert.match(source, /Drive requiere autorización/);
  assert.match(source, /Renovar acceso a Drive/);
  assert.match(source, /Última sincronización correcta/);
  assert.match(source, /window\.addEventListener\('focus',\(\)=>scheduleSync\(\)\)/);
});

test('una sincronización informa sus etapas en vez de quedar solo en Comprobando', () => {
  assert.match(source, /onProgress: \(\{ text \}\)/);
  assert.match(source, /Drive · iniciando comprobación/);
});

test('el estado de Drive también es visible en móvil', () => {
  assert.match(source, /mobile-sync-status sync-pill/);
  assert.match(source, /data-view="settings"/);
});

test('los buscadores actualizan resultados sin reconstruir el input activo', () => {
  assert.match(source, /function updateVisibleSearch\(kind\)/);
  assert.match(source, /updateVisibleSearch\('members'\)/);
  assert.equal(source.includes("state.memberQuery=event.target.value;rerenderFocused"), false);
});

test('Ajustes usa secciones plegables', () => {
  assert.match(source, /data-settings-toggle/);
  assert.match(source, /Cuota mensual/);
  assert.match(source, /settingsSection/);
});

test('el teclado móvil sigue el viewport visible', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const android = await readFile(new URL('../scripts/configure-android.mjs', import.meta.url), 'utf8');
  assert.match(source, /window\.visualViewport/);
  assert.match(source, /soft-keyboard-focus/);
  assert.match(css, /--visual-viewport-height/);
  assert.match(css, /soft-keyboard-focus \.mobile-nav/);
  assert.match(android, /windowSoftInputMode="adjustResize"/);
});

test('la vista móvil conserva el scroll vertical del documento', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /html \{[\s\S]*overflow-y: auto/);
  assert.match(css, /body, #app \{[\s\S]*height: auto/);
  assert.match(css, /touch-action: pan-y/);
  assert.equal(css.includes('overscroll-behavior-y: none'), false);
});

test('el splash Android usa el logo HD centrado en vez de un fondo estirado', async () => {
  const splash = await readFile(new URL('../scripts/install-android-splash.mjs', import.meta.url), 'utf8');
  assert.match(splash, /resources\/icon\.png/);
  assert.match(splash, /android:width="280dp"/);
  assert.match(splash, /android:height="280dp"/);
  assert.match(splash, /android:gravity="center"/);
  assert.match(splash, /windowSplashScreenAnimatedIcon/);
  assert.match(splash, /fs\.rmSync\(stretchedSplash\)/);
});
