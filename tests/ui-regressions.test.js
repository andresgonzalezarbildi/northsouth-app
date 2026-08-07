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
  assert.match(source, /resetDriveData\(reset,token\)/);
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
