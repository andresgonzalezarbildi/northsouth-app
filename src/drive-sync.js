import { mergeData } from './merge.js';
import { applyOperations, mergeOperations } from './journal.js';
import { normalizeOperation } from './operation-format.js';
import { getDeviceId, normalizeData } from './storage.js';
import { nowISO } from './utils.js';

const FILE_NAME = 'north-south-data.json';
const OP_PREFIX = 'north-south-op-';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function driveError(status, text = '') {
  let detail = text;
  try {
    const parsed = JSON.parse(text || '{}');
    detail = parsed?.error?.message || parsed?.error_description || text;
  } catch { /* conserva el texto original */ }
  if (status === 401) return new Error('La sesión de Google venció. Volvé a conectar Drive.');
  if (status === 403) return new Error(`Google Drive rechazó el acceso${detail ? `: ${detail}` : '.'}`);
  return new Error(`Drive respondió ${status}${detail ? `: ${String(detail).slice(0, 220)}` : ''}`);
}

async function request(url, token, options = {}) {
  let lastNetworkError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
      });
      if (response.ok) return response;
      const text = await response.text();
      if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt < 2) {
        await wait(300 * (attempt + 1));
        continue;
      }
      throw driveError(response.status, text);
    } catch (error) {
      if (error?.message?.startsWith('Drive respondió') || /Google Drive rechazó|sesión de Google venció/i.test(error?.message || '')) throw error;
      lastNetworkError = error;
      if (attempt < 2) {
        await wait(300 * (attempt + 1));
        continue;
      }
    }
  }
  throw new Error(`No se pudo completar la solicitud a Google Drive${lastNetworkError?.message ? `: ${lastNetworkError.message}` : '.'}`);
}

async function listRemoteFiles(token) {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      fields: 'nextPageToken,files(id,name,modifiedTime,size)',
      pageSize: '1000'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await request(`${API}/files?spaces=appDataFolder&${params.toString()}`, token);
    const json = await res.json();
    files.push(...(json.files || []));
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function downloadJSON(token, fileId) {
  const res = await request(`${API}/files/${fileId}?alt=media`, token);
  const text = await res.text();
  if (!text.trim()) {
    const error = new Error('El archivo remoto está vacío.');
    error.code = 'INVALID_REMOTE_DATA';
    throw error;
  }
  try { return JSON.parse(text); }
  catch {
    const error = new Error('El archivo remoto no contiene datos válidos.');
    error.code = 'INVALID_REMOTE_DATA';
    throw error;
  }
}

async function downloadSnapshot(token, fileId) {
  return normalizeData(await downloadJSON(token, fileId));
}

async function downloadOperation(token, fileId) {
  const operation = normalizeOperation(await downloadJSON(token, fileId));
  if (!operation) {
    const error = new Error('La operación remota no es válida.');
    error.code = 'INVALID_REMOTE_DATA';
    throw error;
  }
  return operation;
}

function preparePayload(data) {
  const payload = normalizeData(structuredClone(data));
  const timestamp = nowISO();
  payload.meta = {
    ...(payload.meta || {}),
    updatedAt: timestamp,
    lastSyncedBy: getDeviceId(),
    lastSyncedAt: timestamp
  };
  return payload;
}

async function createJSONFile(token, name, payload) {
  const boundary = `northsouth-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, parents: ['appDataFolder'], mimeType: 'application/json' });
  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(payload)}\r\n`,
    `--${boundary}--`
  ].join('');
  const res = await request(`${UPLOAD}/files?uploadType=multipart&fields=id,name,modifiedTime`, token, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  return await res.json();
}

async function createSnapshot(token, data) {
  const payload = preparePayload(data);
  const file = await createJSONFile(token, FILE_NAME, payload);
  return { file, payload };
}

async function uploadSnapshot(token, fileId, data) {
  const payload = preparePayload(data);
  await request(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,modifiedTime`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(payload)
  });
  return payload;
}

const operationFileName = operation => `${OP_PREFIX}${operation.id}.json`;
const operationIdFromName = name => {
  if (!String(name || '').startsWith(OP_PREFIX) || !String(name).endsWith('.json')) return null;
  return String(name).slice(OP_PREFIX.length, -5) || null;
};

async function uploadOperation(token, operation) {
  return createJSONFile(token, operationFileName(operation), operation);
}

function operationFiles(files) {
  const map = new Map();
  files.forEach(file => {
    const id = operationIdFromName(file?.name);
    if (id && !map.has(id)) map.set(id, file);
  });
  return map;
}

async function downloadUnknownOperations(token, filesByOperationId, knownIds) {
  const rows = [];
  for (const [operationId, file] of filesByOperationId) {
    if (knownIds.has(operationId)) continue;
    try {
      const operation = await downloadOperation(token, file.id);
      rows.push(operation);
      knownIds.add(operation.id);
    } catch (error) {
      if (error?.code !== 'INVALID_REMOTE_DATA') throw error;
      console.warn(`Se ignoró una operación remota inválida (${operationId}).`, error);
    }
  }
  return rows;
}

async function findValidSnapshot(token, files) {
  const candidates = files
    .filter(file => file?.name === FILE_NAME)
    .sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
  for (const file of candidates) {
    try { return { file, data: await downloadSnapshot(token, file.id) }; }
    catch (error) {
      if (error?.code !== 'INVALID_REMOTE_DATA') throw error;
      console.warn(`Se ignoró una copia remota inválida de ${FILE_NAME}.`, error);
    }
  }
  return { file: null, data: null };
}

export async function resetDriveData(dataInput, token) {
  if (!navigator.onLine) throw new Error('Necesitás internet para borrar también la copia de Drive.');
  const data = normalizeData(dataInput);

  // Primero publica la nueva generación. Así, cualquier otro equipo que sincronice
  // durante el borrado ve el reset antes de poder reintroducir la generación vieja.
  const created = await createSnapshot(token, data);
  const keepId = created.file.id;

  for (let pass = 0; pass < 2; pass++) {
    const files = await listRemoteFiles(token);
    for (const file of files) {
      if (file.id === keepId) continue;
      await request(`${API}/files/${file.id}`, token, { method: 'DELETE' });
    }
    if (pass === 0) await wait(180);
  }

  return { data: created.payload, fileId: keepId };
}

export async function syncWithDrive(localInput, token) {
  if (!navigator.onLine) throw new Error('No hay internet. Los cambios siguen guardados en este dispositivo.');

  let localData = normalizeData(localInput);
  const initialFiles = await listRemoteFiles(token);
  const snapshot = await findValidSnapshot(token, initialFiles);

  // El snapshot más reciente define la generación vigente. Si otro equipo hizo
  // un borrado total, una copia vieja adopta esa nueva generación en vez de
  // volver a subir datos anteriores.
  if (snapshot.data && localData.datasetId !== snapshot.data.datasetId) {
    localData = normalizeData(snapshot.data);
  }

  const initialOperationFiles = operationFiles(initialFiles);
  const snapshotOperations = snapshot.data?.datasetId === localData.datasetId ? (snapshot.data.operations || []) : [];
  localData.operations = (localData.operations || []).filter(op => op.datasetId === localData.datasetId);
  const knownIds = new Set([...localData.operations, ...snapshotOperations].map(op => op.id));
  const downloadedOperations = (await downloadUnknownOperations(token, initialOperationFiles, knownIds)).filter(op => op.datasetId === localData.datasetId);
  let operations = mergeOperations(mergeOperations(localData.operations, snapshotOperations.filter(op => op.datasetId === localData.datasetId)), downloadedOperations);

  // El snapshot acelera la carga y mantiene compatibilidad con versiones anteriores.
  // El log de operaciones es el que evita perder cambios concurrentes.
  let merged = snapshot.data ? mergeData(localData, snapshot.data) : localData;
  merged = applyOperations(merged, operations);
  merged.operations = operations;

  // Cada operación se crea como un archivo inmutable e independiente. Dos equipos pueden
  // subir a la vez sin escribir sobre el mismo archivo.
  let uploadedCount = 0;
  for (const operation of operations) {
    if (initialOperationFiles.has(operation.id)) continue;
    await uploadOperation(token, operation);
    initialOperationFiles.set(operation.id, { id: operation.id, name: operationFileName(operation) });
    uploadedCount++;
  }

  // Segunda lectura: recoge operaciones que otro equipo haya subido mientras éste sincronizaba.
  const finalFiles = await listRemoteFiles(token);
  const finalOperationFiles = operationFiles(finalFiles);
  const finalKnownIds = new Set(operations.map(op => op.id));
  const concurrentOperations = (await downloadUnknownOperations(token, finalOperationFiles, finalKnownIds)).filter(op => op.datasetId === localData.datasetId);
  if (concurrentOperations.length) {
    operations = mergeOperations(operations, concurrentOperations);
    merged = applyOperations(merged, concurrentOperations);
    merged.operations = operations;
  }

  // Snapshot materializado: si dos equipos lo pisan no se pierden operaciones, porque éstas
  // quedan guardadas por separado y se vuelven a aplicar en la próxima sincronización.
  const finalSnapshot = snapshot.file
    ? await uploadSnapshot(token, snapshot.file.id, merged)
    : (await createSnapshot(token, merged)).payload;
  finalSnapshot.operations = operations;

  return {
    data: finalSnapshot,
    created: !snapshot.file,
    uploadedCount,
    downloadedCount: downloadedOperations.length + concurrentOperations.length,
    remoteOperationIds: [...finalOperationFiles.keys(), ...operations.filter(op => !finalOperationFiles.has(op.id)).map(op => op.id)]
  };
}
