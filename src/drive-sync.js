import { mergeData } from './merge.js';
import { getDeviceId, normalizeData } from './storage.js';
import { nowISO } from './utils.js';

const FILE_NAME = 'north-south-data.json';
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

async function findRemoteFiles(token) {
  const url = `${API}/files?spaces=appDataFolder&fields=files(id,name,modifiedTime,size)&pageSize=100`;
  const res = await request(url, token);
  const json = await res.json();
  return (json.files || [])
    .filter(file => file?.name === FILE_NAME)
    .sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
}

async function downloadRemote(token, fileId) {
  const res = await request(`${API}/files/${fileId}?alt=media`, token);
  const text = await res.text();
  if (!text.trim()) {
    const error = new Error('El archivo remoto está vacío.');
    error.code = 'INVALID_REMOTE_DATA';
    throw error;
  }
  try {
    return normalizeData(JSON.parse(text));
  } catch {
    const error = new Error('El archivo remoto no contiene datos válidos.');
    error.code = 'INVALID_REMOTE_DATA';
    throw error;
  }
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

async function createRemote(token, data) {
  const payload = preparePayload(data);
  const boundary = `northsouth-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
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
  return { file: await res.json(), payload };
}

async function uploadRemote(token, fileId, data) {
  const payload = preparePayload(data);
  await request(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,modifiedTime`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(payload)
  });
  return payload;
}

export async function syncWithDrive(localData, token) {
  if (!navigator.onLine) throw new Error('No hay internet. Los cambios siguen guardados en este dispositivo.');

  const candidates = await findRemoteFiles(token);
  let file = null;
  let remote = null;

  for (const candidate of candidates) {
    try {
      remote = await downloadRemote(token, candidate.id);
      file = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'INVALID_REMOTE_DATA') throw error;
      console.warn(`Se ignoró una copia remota inválida de ${FILE_NAME}.`, error);
    }
  }

  if (!file || !remote) {
    const created = await createRemote(token, localData);
    return { data: created.payload, created: true };
  }

  // Se mezcla registro por registro antes de escribir y se verifica otra vez después,
  // para conservar cambios hechos casi al mismo tiempo desde dos dispositivos.
  let merged = mergeData(localData, remote);
  await uploadRemote(token, file.id, merged);
  const verifyRemote = await downloadRemote(token, file.id);
  const verified = mergeData(merged, verifyRemote);
  if (JSON.stringify(verified) !== JSON.stringify(merged)) {
    merged = verified;
    await uploadRemote(token, file.id, merged);
  }
  return { data: merged, created: false };
}
