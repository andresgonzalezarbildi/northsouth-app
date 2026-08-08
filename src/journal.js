import { mergeData } from './merge.js';
import { nowISO } from './utils.js';
import { normalizeOperation, OP_COLLECTIONS as COLLECTIONS } from './operation-format.js';

const clone = value => structuredClone(value);
const json = value => JSON.stringify(value ?? null);

export function diffData(beforeInput, afterInput) {
  const before = beforeInput || {};
  const after = afterInput || {};
  const changes = [];

  for (const collection of COLLECTIONS) {
    const beforeMap = new Map((Array.isArray(before[collection]) ? before[collection] : []).filter(x => x?.id).map(x => [x.id, x]));
    const afterRows = (Array.isArray(after[collection]) ? after[collection] : []).filter(x => x?.id);
    for (const record of afterRows) {
      if (json(beforeMap.get(record.id)) !== json(record)) {
        changes.push({ collection, id: String(record.id), record: clone(record) });
      }
    }
  }

  const settings = json(before.settings) !== json(after.settings) ? clone(after.settings) : null;
  return { changes, settings };
}

export function createOperation(before, after, { label = 'Cambio guardado', deviceId = '', id = null, createdAt = null } = {}) {
  const diff = diffData(before, after);
  if (!diff.changes.length && !diff.settings) return null;
  const operation = normalizeOperation({
    id: id || `op-${crypto.randomUUID()}`,
    datasetId: after?.datasetId || before?.datasetId || 'north-south-academy-main',
    label,
    createdAt: createdAt || nowISO(),
    deviceId,
    changes: diff.changes,
    settings: diff.settings
  });
  return operation;
}


export function createResetOperation(data, { label = 'Todos los datos borrados.', deviceId = '', id = null, createdAt = null } = {}) {
  return normalizeOperation({
    id: id || `op-${crypto.randomUUID()}`,
    datasetId: data?.datasetId || 'north-south-academy-main',
    type: 'reset',
    label,
    createdAt: createdAt || nowISO(),
    deviceId,
    changes: [],
    settings: null
  });
}

export function mergeOperations(local = [], remote = []) {
  const map = new Map();
  [...local, ...remote].forEach(raw => {
    const operation = normalizeOperation(raw);
    if (operation && !map.has(operation.id)) map.set(operation.id, operation);
  });
  return [...map.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

export function applyOperation(data, rawOperation) {
  const operation = normalizeOperation(rawOperation);
  if (!operation || operation.datasetId !== data.datasetId) return data;

  const patch = {
    datasetId: data.datasetId,
    settings: operation.settings || data.settings,
    members: [], payments: [], products: [], sales: [],
    meta: { updatedAt: operation.createdAt }
  };
  operation.changes.forEach(change => patch[change.collection].push(clone(change.record)));
  return mergeData(data, patch);
}

export function applyOperations(dataInput, operations = []) {
  let data = clone(dataInput);
  for (const operation of mergeOperations([], operations)) data = applyOperation(data, operation);
  return data;
}
