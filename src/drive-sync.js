import { mergeData } from './merge.js';
import { applyOperations, mergeOperations } from './journal.js';
import { normalizeOperation } from './operation-format.js';
import { emptyData, getDeviceId, normalizeData } from './storage.js';
import { compareResetMarkers, latestResetMarker, normalizeResetMarker, resetMarkerFromData } from './generation.js';
import { nowISO } from './utils.js';

const FILE_NAME = 'north-south-data.json';
const OP_PREFIX = 'north-south-op-';
const RESET_PREFIX = 'north-south-reset-';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const REQUEST_TIMEOUT_MS = 7000;

function report(onProgress, phase, text) {
  if (typeof onProgress === 'function') onProgress({ phase, text });
}

function syncFingerprint(input) {
  const data = normalizeData(input);
  const sortRows = rows => (rows || []).slice().sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || '')));
  return JSON.stringify({
    datasetId: data.datasetId,
    settings: { ...data.settings, feeHistory: sortRows(data.settings?.feeHistory) },
    members: sortRows(data.members),
    payments: sortRows(data.payments),
    products: sortRows(data.products),
    sales: sortRows(data.sales),
    operations: sortRows(data.operations)
  });
}

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
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
      });
      if (response.ok) return response;
      const text = await response.text();
      if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt < 1) {
        await wait(350 * (attempt + 1));
        continue;
      }
      throw driveError(response.status, text);
    } catch (error) {
      if (error?.message?.startsWith('Drive respondió') || /Google Drive rechazó|sesión de Google venció/i.test(error?.message || '')) throw error;
      lastNetworkError = error?.name === 'AbortError' ? new Error('Google Drive demoró demasiado en responder.') : error;
      if (attempt < 1) {
        await wait(350 * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
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

async function findValidSnapshot(token, files, datasetId = '') {
  const candidates = files
    .filter(file => file?.name === FILE_NAME)
    .sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
  for (const file of candidates) {
    try {
      const data = await downloadSnapshot(token, file.id);
      if (datasetId && data.datasetId !== datasetId) continue;
      return { file, data };
    } catch (error) {
      if (error?.code !== 'INVALID_REMOTE_DATA') throw error;
      console.warn(`Se ignoró una copia remota inválida de ${FILE_NAME}.`, error);
    }
  }
  return { file: null, data: null };
}

const resetFileName = marker => `${RESET_PREFIX}${marker.id}.json`;
const resetIdFromName = name => {
  if (!String(name || '').startsWith(RESET_PREFIX) || !String(name).endsWith('.json')) return null;
  return String(name).slice(RESET_PREFIX.length, -5) || null;
};

function resetFiles(files) {
  const map = new Map();
  files.forEach(file => {
    const id = resetIdFromName(file?.name);
    if (id && !map.has(id)) map.set(id, file);
  });
  return map;
}

async function downloadResetMarker(token, fileId) {
  const marker = normalizeResetMarker(await downloadJSON(token, fileId));
  if (!marker) {
    const error = new Error('La marca de borrado remota no es válida.');
    error.code = 'INVALID_REMOTE_DATA';
    throw error;
  }
  return marker;
}

async function readRemoteResetMarkers(token, files) {
  const rows = [];
  for (const [resetId, file] of resetFiles(files)) {
    try { rows.push(await downloadResetMarker(token, file.id)); }
    catch (error) {
      if (error?.code !== 'INVALID_REMOTE_DATA') throw error;
      console.warn(`Se ignoró una marca de borrado remota inválida (${resetId}).`, error);
    }
  }
  return rows;
}

async function ensureResetMarkerUploaded(token, marker, files) {
  if (!marker) return false;
  const existing = resetFiles(files);
  if (existing.has(marker.id)) return false;
  await createJSONFile(token, resetFileName(marker), marker);
  return true;
}

export async function resetDriveData(dataInput, token) {
  if (!navigator.onLine) throw new Error('No hay internet. El borrado queda pendiente para Drive.');
  const data = normalizeData(dataInput);
  const marker = resetMarkerFromData(data);
  if (!marker) throw new Error('El borrado no tiene una marca de generación válida.');

  const files = await listRemoteFiles(token);
  await ensureResetMarkerUploaded(token, marker, files);

  // No se eliminan los archivos históricos acá: una limpieza agresiva puede borrar
  // una operación nueva subida concurrentemente por otro equipo. La marca de reset
  // hace que todo lo perteneciente a generaciones anteriores quede lógicamente obsoleto.
  const currentFiles = await listRemoteFiles(token);
  const snapshot = await findValidSnapshot(token, currentFiles, marker.datasetId);
  const payload = snapshot.file
    ? await uploadSnapshot(token, snapshot.file.id, data)
    : (await createSnapshot(token, data)).payload;

  return { data: payload, fileId: snapshot.file?.id || null, activeResetId: marker.id };
}

export async function syncWithDrive(localInput, token, { onProgress } = {}) {
  if (!navigator.onLine) throw new Error('No hay internet. Los cambios siguen guardados en este dispositivo.');

  let localData = normalizeData(localInput);

  // Se permiten dos pasadas. Si aparece un reset en otro equipo mientras esta
  // sincronización estaba en curso, se abandona la generación anterior y se repite.
  for (let pass = 0; pass < 2; pass++) {
    report(onProgress, 'checking', 'Drive · comprobando cambios…');
    const initialFiles = await listRemoteFiles(token);
    report(onProgress, 'generation', 'Drive · verificando versión de datos…');
    const remoteResets = await readRemoteResetMarkers(token, initialFiles);
    let remoteReset = latestResetMarker(remoteResets);
    const localReset = resetMarkerFromData(localData);

    // Un reset local todavía no publicado es una intención explícita del usuario.
    // Si es posterior al reset remoto (o no existe uno), se publica ANTES de leer
    // snapshots viejos para impedir que Drive restaure datos ya borrados.
    if (localReset && (!remoteReset || compareResetMarkers(localReset, remoteReset) > 0)) {
      await ensureResetMarkerUploaded(token, localReset, initialFiles);
      remoteReset = localReset;
    }

    const activeReset = latestResetMarker([remoteReset, localReset].filter(Boolean));
    let snapshot;

    if (activeReset) {
      snapshot = await findValidSnapshot(token, initialFiles, activeReset.datasetId);
      if (localData.datasetId !== activeReset.datasetId) {
        // El reset funciona como una barrera: nunca se mezclan entidades de una
        // generación anterior, aunque un snapshot viejo tenga modifiedTime posterior.
        localData = snapshot.data || emptyData(activeReset.datasetId);
        localData.meta.reset = activeReset;
      } else {
        localData.meta.reset = activeReset;
      }
    } else {
      snapshot = await findValidSnapshot(token, initialFiles);
      // Compatibilidad con instalaciones anteriores a las marcas de reset.
      if (snapshot.data && localData.datasetId !== snapshot.data.datasetId) {
        localData = normalizeData(snapshot.data);
      }
    }

    const activeDatasetId = localData.datasetId;
    const initialOperationFiles = operationFiles(initialFiles);
    const snapshotOperations = snapshot.data?.datasetId === activeDatasetId ? (snapshot.data.operations || []) : [];
    localData.operations = (localData.operations || []).filter(op => op.datasetId === activeDatasetId);
    const knownIds = new Set([...localData.operations, ...snapshotOperations].map(op => op.id));
    report(onProgress, 'downloading', 'Drive · leyendo cambios remotos…');
    const downloadedOperations = (await downloadUnknownOperations(token, initialOperationFiles, knownIds)).filter(op => op.datasetId === activeDatasetId);
    let operations = mergeOperations(mergeOperations(localData.operations, snapshotOperations.filter(op => op.datasetId === activeDatasetId)), downloadedOperations);

    let merged = snapshot.data ? mergeData(localData, snapshot.data) : localData;
    merged = applyOperations(merged, operations);
    merged.operations = operations;
    if (activeReset) merged.meta.reset = activeReset;

    let uploadedCount = 0;
    report(onProgress, 'uploading', operations.some(operation => !initialOperationFiles.has(operation.id)) ? 'Drive · subiendo cambios locales…' : 'Drive · comprobando cambios simultáneos…');
    for (const operation of operations) {
      if (initialOperationFiles.has(operation.id)) continue;
      await uploadOperation(token, operation);
      initialOperationFiles.set(operation.id, { id: operation.id, name: operationFileName(operation) });
      uploadedCount++;
    }

    // Segunda lectura: recoge operaciones concurrentes y, sobre todo, verifica que
    // no haya aparecido un reset nuevo antes de materializar el snapshot.
    report(onProgress, 'final-check', 'Drive · comprobación final…');
    const finalFiles = await listRemoteFiles(token);
    const finalRemoteReset = latestResetMarker(await readRemoteResetMarkers(token, finalFiles));
    if (finalRemoteReset && (!activeReset || compareResetMarkers(finalRemoteReset, activeReset) > 0)) {
      localData = emptyData(finalRemoteReset.datasetId);
      localData.meta.reset = finalRemoteReset;
      continue;
    }

    const finalOperationFiles = operationFiles(finalFiles);
    const finalKnownIds = new Set(operations.map(op => op.id));
    const concurrentOperations = (await downloadUnknownOperations(token, finalOperationFiles, finalKnownIds)).filter(op => op.datasetId === activeDatasetId);
    if (concurrentOperations.length) {
      operations = mergeOperations(operations, concurrentOperations);
      merged = applyOperations(merged, concurrentOperations);
      merged.operations = operations;
    }

    const matchingSnapshot = snapshot.file && snapshot.data?.datasetId === activeDatasetId ? snapshot.file : null;
    const needsSnapshotWrite = !matchingSnapshot || !snapshot.data || syncFingerprint(merged) !== syncFingerprint(snapshot.data);
    let finalSnapshot;
    if (needsSnapshotWrite) {
      report(onProgress, 'saving', 'Drive · guardando estado actualizado…');
      finalSnapshot = matchingSnapshot
        ? await uploadSnapshot(token, matchingSnapshot.id, merged)
        : (await createSnapshot(token, merged)).payload;
    } else {
      report(onProgress, 'done', 'Drive · sin cambios nuevos.');
      finalSnapshot = normalizeData(merged);
    }
    finalSnapshot.operations = operations;
    if (activeReset) finalSnapshot.meta.reset = activeReset;

    return {
      data: finalSnapshot,
      created: !matchingSnapshot,
      uploadedCount,
      downloadedCount: downloadedOperations.length + concurrentOperations.length,
      remoteOperationIds: [...finalOperationFiles.keys(), ...operations.filter(op => !finalOperationFiles.has(op.id)).map(op => op.id)],
      activeResetId: activeReset?.id || null
    };
  }

  throw new Error('Los datos cambiaron de generación mientras se sincronizaban. Volvé a sincronizar.');
}
