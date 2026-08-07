import { nowISO } from './utils.js';

export const OP_COLLECTIONS = ['members', 'payments', 'products', 'sales'];
const clone = value => structuredClone(value);

export function normalizeOperation(input) {
  if (!input || typeof input !== 'object' || !input.id) return null;
  const changes = Array.isArray(input.changes)
    ? input.changes
        .filter(change => OP_COLLECTIONS.includes(change?.collection) && change?.record?.id)
        .map(change => ({
          collection: change.collection,
          id: String(change.record.id),
          record: clone(change.record)
        }))
    : [];
  return {
    id: String(input.id),
    version: 1,
    datasetId: input.datasetId || 'north-south-academy-main',
    type: input.type || 'mutation',
    label: String(input.label || 'Cambio guardado'),
    createdAt: input.createdAt || nowISO(),
    deviceId: String(input.deviceId || ''),
    changes,
    settings: input.settings && typeof input.settings === 'object' ? clone(input.settings) : null
  };
}
