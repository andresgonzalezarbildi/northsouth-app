import test from 'node:test';
import assert from 'node:assert/strict';
import { compareResetMarkers, latestResetMarker, normalizeResetMarker, resetMarkerFromData } from '../src/generation.js';

test('la marca de reset conserva generación y fecha', () => {
  const marker=normalizeResetMarker({id:'reset-a',datasetId:'north-south-academy-main:a',createdAt:'2026-08-07T12:00:00Z',deviceId:'pc-a'});
  assert.equal(marker.datasetId,'north-south-academy-main:a');
  assert.equal(marker.createdAt,'2026-08-07T12:00:00Z');
});

test('entre dos borrados gana el posterior y no el que se subió último', () => {
  const oldReset={id:'reset-old',datasetId:'north-south-academy-main:old',createdAt:'2026-08-07T12:00:00Z'};
  const newReset={id:'reset-new',datasetId:'north-south-academy-main:new',createdAt:'2026-08-07T12:10:00Z'};
  assert.ok(compareResetMarkers(newReset,oldReset)>0);
  assert.equal(latestResetMarker([newReset,oldReset]).id,'reset-new');
  assert.equal(latestResetMarker([oldReset,newReset]).id,'reset-new');
});

test('un dataset puede transportar su reset pendiente hasta reconectar Drive', () => {
  const reset={id:'reset-local',datasetId:'north-south-academy-main:local',createdAt:'2026-08-07T13:00:00Z',deviceId:'pc-a'};
  const data={datasetId:reset.datasetId,meta:{reset}};
  assert.deepEqual(resetMarkerFromData(data),normalizeResetMarker(reset));
});
