const clone = value => structuredClone(value);
const ms = value => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

export function normalizeResetMarker(input) {
  if (!input || typeof input !== 'object' || !input.id || !input.datasetId) return null;
  return {
    id: String(input.id),
    version: 1,
    type: 'reset',
    datasetId: String(input.datasetId),
    createdAt: input.createdAt || input.resetAt || new Date(0).toISOString(),
    deviceId: String(input.deviceId || '')
  };
}

export function resetMarkerFromData(data) {
  return normalizeResetMarker(data?.meta?.reset);
}

export function compareResetMarkers(aInput, bInput) {
  const a = normalizeResetMarker(aInput);
  const b = normalizeResetMarker(bInput);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const timeDiff = ms(a.createdAt) - ms(b.createdAt);
  if (timeDiff) return timeDiff;
  return a.id.localeCompare(b.id);
}

export function latestResetMarker(markers = []) {
  let latest = null;
  for (const raw of markers) {
    const marker = normalizeResetMarker(raw);
    if (marker && (!latest || compareResetMarkers(marker, latest) > 0)) latest = marker;
  }
  return latest ? clone(latest) : null;
}

export function makeResetMarker(datasetId, { id = null, createdAt = null, deviceId = '' } = {}) {
  return normalizeResetMarker({
    id: id || `reset-${crypto.randomUUID()}`,
    datasetId,
    createdAt: createdAt || new Date().toISOString(),
    deviceId
  });
}
