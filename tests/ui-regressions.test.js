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
