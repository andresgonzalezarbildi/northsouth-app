import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/drive-sync.js', import.meta.url), 'utf8');

test('las solicitudes a Drive tienen timeout y reintento acotado', () => {
  assert.match(source, /REQUEST_TIMEOUT_MS = 7000/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /attempt < 2/);
  assert.match(source, /Google Drive demoró demasiado en responder/);
});

test('la sincronización reporta progreso y no reescribe snapshots si no cambió nada', () => {
  assert.match(source, /onProgress/);
  assert.match(source, /Drive · leyendo cambios remotos/);
  assert.match(source, /needsSnapshotWrite/);
  assert.match(source, /Drive · sin cambios nuevos/);
});
