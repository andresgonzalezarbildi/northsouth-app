const {
  json,
  requestOrigin,
  assertAjaxRequest,
  accessForEvent,
  cookieHeaderForSession,
  googleFetch,
} = require('./_lib/google');

const FILE_NAME = 'cronograma-semestre-2026.json';
const MAX_RETRIES = 6;

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stateFingerprint(state) {
  const items = Array.isArray(state?.items)
    ? [...state.items].map((item) => ({ ...item })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    : [];
  return JSON.stringify({ dataVersion: state?.dataVersion || '', items });
}

function normalizeState(input) {
  const items = Array.isArray(input?.items)
    ? input.items.filter((item) => item && typeof item === 'object' && item.id).map(clone)
    : [];
  return {
    schemaVersion: 2,
    dataVersion: String(input?.dataVersion || ''),
    savedAt: validTimestamp(input?.savedAt) ? input.savedAt : '',
    items,
  };
}

function mergeStates(remoteInput, localInput, dirtyIds, stamp) {
  const remote = normalizeState(remoteInput);
  const local = normalizeState(localInput);
  const remoteById = new Map(remote.items.map((item) => [String(item.id), item]));
  const localById = new Map(local.items.map((item) => [String(item.id), item]));
  const ids = new Set([...remoteById.keys(), ...localById.keys()]);
  const items = [];

  for (const id of ids) {
    const remoteItem = remoteById.get(id);
    const localItem = localById.get(id);
    let chosen;

    if (!remoteItem) chosen = clone(localItem);
    else if (!localItem) chosen = clone(remoteItem);
    else if (dirtyIds.has(id)) chosen = clone(localItem);
    else {
      const remoteTime = validTimestamp(remoteItem.updatedAt) ? remoteItem.updatedAt : '';
      const localTime = validTimestamp(localItem.updatedAt) ? localItem.updatedAt : '';
      chosen = clone(remoteTime >= localTime ? remoteItem : localItem);
    }

    if (dirtyIds.has(id) && chosen) chosen.updatedAt = stamp;
    items.push(chosen);
  }

  return {
    schemaVersion: 2,
    dataVersion: local.dataVersion || remote.dataVersion,
    savedAt: stamp,
    items,
  };
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function listStateFiles(accessToken) {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `title='${escapeDriveQuery(FILE_NAME)}' and trashed=false`,
    fields: 'items(id,title,etag,createdDate,modifiedDate)',
    maxResults: '20',
  });
  const response = await googleFetch(accessToken, `https://www.googleapis.com/drive/v2/files?${params}`);
  const body = await response.json();
  return (body.items || []).sort((a, b) => String(a.createdDate || '').localeCompare(String(b.createdDate || '')));
}

async function getFileMetadata(accessToken, fileId) {
  const params = new URLSearchParams({ fields: 'id,title,etag,modifiedDate' });
  const response = await googleFetch(accessToken, `https://www.googleapis.com/drive/v2/files/${encodeURIComponent(fileId)}?${params}`);
  return response.json();
}

async function downloadState(accessToken, fileId) {
  const response = await googleFetch(accessToken, `https://www.googleapis.com/drive/v2/files/${encodeURIComponent(fileId)}?alt=media`);
  const text = await response.text();
  try {
    return normalizeState(JSON.parse(text));
  } catch {
    return normalizeState(null);
  }
}

async function readVersion(accessToken, fileId) {
  const metadata = await getFileMetadata(accessToken, fileId);
  const state = await downloadState(accessToken, fileId);
  return { metadata, state };
}

async function createStateFile(accessToken, state) {
  const boundary = `cronograma_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const metadata = JSON.stringify({
    name: FILE_NAME,
    mimeType: 'application/json',
    parents: ['appDataFolder'],
  });
  const content = JSON.stringify(state);
  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n`,
    `--${boundary}--`,
  ].join('');
  const response = await googleFetch(accessToken, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return response.json();
}

async function conditionalUpdate(accessToken, fileId, etag, state) {
  const response = await fetch(`https://www.googleapis.com/upload/drive/v2/files/${encodeURIComponent(fileId)}?uploadType=media`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'If-Match': etag,
    },
    body: JSON.stringify(state),
  });

  if (response.status === 412) return { conflict: true };
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || '';
    } catch {
      detail = await response.text().catch(() => '');
    }
    const error = new Error(detail || `Google Drive respondió ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return { conflict: false };
}

async function mergeDuplicateFiles(accessToken, files) {
  if (!files.length) return null;
  const canonical = files[0];
  let merged = normalizeState(null);
  for (const file of files) {
    const state = await downloadState(accessToken, file.id);
    merged = mergeStates(merged, state, new Set(), new Date().toISOString());
  }
  return { canonical, merged };
}

async function synchronize(accessToken, localState, dirtyIds) {
  let files = await listStateFiles(accessToken);
  if (!files.length) {
    const stamp = new Date().toISOString();
    const initial = mergeStates(normalizeState(null), localState, dirtyIds, stamp);
    const created = await createStateFile(accessToken, initial);
    return { state: initial, fileId: created.id, retries: 0 };
  }

  // Si alguna versión vieja creó dos archivos por una carrera, se toma siempre
  // el más antiguo como canónico y se incorporan los datos de los demás.
  let duplicateMerged = null;
  if (files.length > 1) {
    duplicateMerged = await mergeDuplicateFiles(accessToken, files);
  }
  const canonicalId = files[0].id;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const { metadata, state: remoteState } = await readVersion(accessToken, canonicalId);
    const baseRemote = duplicateMerged
      ? mergeStates(remoteState, duplicateMerged.merged, new Set(), new Date().toISOString())
      : remoteState;
    const stamp = new Date().toISOString();
    const merged = mergeStates(baseRemote, localState, dirtyIds, stamp);

    if (stateFingerprint(remoteState) === stateFingerprint(merged)) {
      return { state: merged, fileId: canonicalId, retries: attempt };
    }

    const result = await conditionalUpdate(accessToken, canonicalId, metadata.etag, merged);
    if (!result.conflict) return { state: merged, fileId: canonicalId, retries: attempt };

    // Otra PC escribió entre la lectura y la subida. Se vuelve a leer y mezclar;
    // nunca se pisa a ciegas el archivo remoto.
    duplicateMerged = null;
  }

  const error = new Error('Hubo demasiados cambios simultáneos. Se volverá a intentar automáticamente.');
  error.statusCode = 409;
  throw error;
}

exports.handler = async (event) => {
  const origin = requestOrigin(event);
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido' });
    assertAjaxRequest(event);

    const raw = event.body || '';
    if (Buffer.byteLength(raw, 'utf8') > 2_000_000) return json(413, { error: 'El estado es demasiado grande' });
    const body = JSON.parse(raw || '{}');
    const localState = normalizeState(body.state);
    const dirtyIds = new Set(Array.isArray(body.dirtyIds) ? body.dirtyIds.map(String) : []);

    const auth = await accessForEvent(event);
    const result = await synchronize(auth.accessToken, localState, dirtyIds);
    const headers = auth.refreshed ? { 'Set-Cookie': cookieHeaderForSession(auth.session, origin) } : {};

    return json(200, {
      state: result.state,
      fileId: result.fileId,
      retries: result.retries,
      syncedDirtyIds: [...dirtyIds],
    }, headers);
  } catch (error) {
    console.error('drive-sync', error);
    return json(error.statusCode || 500, { error: error.message || 'No se pudo sincronizar con Google Drive' });
  }
};
