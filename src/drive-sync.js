import { mergeData } from './merge.js';
import { getDeviceId, normalizeData } from './storage.js';
import { nowISO } from './utils.js';

const FILE_NAME = 'north-south-data.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

async function request(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  if (response.status === 401) throw new Error('La sesión de Google venció. Volvé a conectar Drive.');
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drive respondió ${response.status}: ${text.slice(0, 180)}`);
  }
  return response;
}

async function findRemoteFile(token) {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const url = `${API}/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)&pageSize=10`;
  const res = await request(url, token);
  const json = await res.json();
  return json.files?.[0] || null;
}

async function downloadRemote(token, fileId) {
  const res = await request(`${API}/files/${fileId}?alt=media`, token);
  return normalizeData(await res.json());
}

async function createRemote(token) {
  const res = await request(`${API}/files?fields=id,name,modifiedTime`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' })
  });
  return res.json();
}

async function uploadRemote(token, fileId, data) {
  const payload = normalizeData(structuredClone(data));
  payload.meta = { ...(payload.meta || {}), updatedAt: nowISO(), lastSyncedBy: getDeviceId(), lastSyncedAt: nowISO() };
  await request(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,modifiedTime`, token, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(payload)
  });
  return payload;
}

export async function syncWithDrive(localData, token) {
  if (!navigator.onLine) throw new Error('No hay internet. Los cambios siguen guardados en este dispositivo.');
  let file = await findRemoteFile(token);
  if (!file) {
    file = await createRemote(token);
    const uploaded = await uploadRemote(token, file.id, localData);
    return { data: uploaded, created: true };
  }

  // Siempre se mezcla registro por registro antes de escribir. Luego se vuelve a leer
  // y se mezcla una segunda vez para minimizar pérdidas si otro dispositivo sincronizó a la vez.
  const remote = await downloadRemote(token, file.id);
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
