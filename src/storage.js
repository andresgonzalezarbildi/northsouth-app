import { nowISO } from './utils.js';

export const LEGACY_DATA_KEY = 'northsouth:data:v1';
const DATA_PREFIX = 'northsouth:data:v4:';
const BACKUP_PREFIX = 'northsouth:data:backup:v4:';
const DEVICE_KEY = 'northsouth:device-id:v1';
const clone = obj => structuredClone(obj);

const numberOr = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const accountId = email => encodeURIComponent(String(email || '').trim().toLowerCase());
export const dataKeyFor = email => `${DATA_PREFIX}${accountId(email)}`;
const backupKeyFor = email => `${BACKUP_PREFIX}${accountId(email)}`;

function normalizeFeeHistory(rows, fallbackAmount, fallbackUpdatedAt) {
  const source = Array.isArray(rows) ? rows : [];
  const normalized = source
    .filter(x => x && /^\d{4}-\d{2}$/.test(x.effectiveFrom || '') && numberOr(x.amount) > 0)
    .map((x, i) => ({
      id: x.id || `fee-${x.effectiveFrom}-${i}`,
      effectiveFrom: x.effectiveFrom,
      amount: numberOr(x.amount),
      createdAt: x.createdAt || x.updatedAt || fallbackUpdatedAt,
      updatedAt: x.updatedAt || x.createdAt || fallbackUpdatedAt,
      deletedAt: x.deletedAt || null
    }));
  if (!normalized.some(x => !x.deletedAt)) {
    normalized.push({
      id: 'fee-initial', effectiveFrom: '1900-01', amount: numberOr(fallbackAmount, 2500),
      createdAt: fallbackUpdatedAt, updatedAt: fallbackUpdatedAt, deletedAt: null
    });
  }
  return normalized;
}

function normalizeMember(member, defaultFee, fallbackUpdatedAt) {
  const m = member || {};
  const rawFee = numberOr(m.monthlyFee, defaultFee);
  const inferredMode = rawFee > 0 && rawFee !== defaultFee ? 'custom' : 'default';
  const feeMode = m.feeMode === 'custom' ? 'custom' : m.feeMode === 'default' ? 'default' : inferredMode;
  const memberFeeHistory = feeMode === 'custom'
    ? normalizeFeeHistory(m.feeHistory, rawFee || defaultFee, m.updatedAt || fallbackUpdatedAt)
    : (Array.isArray(m.feeHistory) ? m.feeHistory : []).map((x, i) => ({
        id: x.id || `${m.id || 'member'}-fee-${i}`,
        effectiveFrom: x.effectiveFrom || '1900-01', amount: numberOr(x.amount, defaultFee),
        createdAt: x.createdAt || x.updatedAt || fallbackUpdatedAt,
        updatedAt: x.updatedAt || x.createdAt || fallbackUpdatedAt,
        deletedAt: x.deletedAt || null
      }));
  return {
    ...m,
    id: m.id,
    firstName: String(m.firstName || ''),
    lastName: String(m.lastName || ''),
    displayName: String(m.displayName || '').trim(),
    status: m.status === 'inactive' ? 'inactive' : 'active',
    phone: String(m.phone || ''),
    medicalProvider: String(m.medicalProvider || ''),
    birthDate: String(m.birthDate || ''),
    joinedAt: String(m.joinedAt || ''),
    notes: String(m.notes || ''),
    monthlyFee: rawFee || defaultFee,
    feeMode,
    feeHistory: memberFeeHistory,
    feeStartPeriod: /^\d{4}-\d{2}$/.test(m.feeStartPeriod || '')
      ? m.feeStartPeriod
      : (/^\d{4}-\d{2}/.test(m.joinedAt || '') ? String(m.joinedAt).slice(0, 7) : '1900-01'),
    createdAt: m.createdAt || m.updatedAt || fallbackUpdatedAt,
    updatedAt: m.updatedAt || m.createdAt || fallbackUpdatedAt,
    deletedAt: m.deletedAt || null
  };
}

export function normalizeData(input) {
  const data = input && typeof input === 'object' ? input : {};
  const timestamp = data.meta?.updatedAt || data.settings?.updatedAt || nowISO();
  const defaultFee = numberOr(data.settings?.defaultFee, 2500) || 2500;
  const feeHistory = normalizeFeeHistory(data.settings?.feeHistory, defaultFee, data.settings?.updatedAt || timestamp);

  return {
    schemaVersion: 4,
    datasetId: data.datasetId || 'north-south-academy-main',
    settings: {
      academyName: data.settings?.academyName || 'North South Academy',
      defaultFee,
      currency: data.settings?.currency || 'UYU',
      lastPaymentMethod: data.settings?.lastPaymentMethod || 'cash',
      lastSaleMethod: data.settings?.lastSaleMethod || data.settings?.lastPaymentMethod || 'cash',
      feeHistory,
      updatedAt: data.settings?.updatedAt || timestamp
    },
    members: (Array.isArray(data.members) ? data.members : []).filter(x => x?.id).map(m => normalizeMember(m, defaultFee, timestamp)),
    payments: (Array.isArray(data.payments) ? data.payments : []).filter(x => x?.id).map(p => ({
      ...p, amount: numberOr(p.amount), createdAt: p.createdAt || p.paidAt || p.updatedAt || timestamp,
      updatedAt: p.updatedAt || p.createdAt || p.paidAt || timestamp, deletedAt: p.deletedAt || null
    })),
    products: (Array.isArray(data.products) ? data.products : []).filter(x => x?.id).map(p => ({
      ...p, name: String(p.name || ''), emoji: String(p.emoji || '🛒'), price: Math.max(0, numberOr(p.price)),
      active: p.active !== false, createdAt: p.createdAt || p.updatedAt || timestamp,
      updatedAt: p.updatedAt || p.createdAt || timestamp, deletedAt: p.deletedAt || null
    })),
    sales: (Array.isArray(data.sales) ? data.sales : []).filter(x => x?.id).map(s => ({
      ...s, memberId: String(s.memberId || ''), quantity: Math.max(1, numberOr(s.quantity, 1)), unitPrice: Math.max(0, numberOr(s.unitPrice)),
      amount: Math.max(0, numberOr(s.amount, numberOr(s.unitPrice) * numberOr(s.quantity, 1))),
      createdAt: s.createdAt || s.soldAt || s.updatedAt || timestamp,
      updatedAt: s.updatedAt || s.createdAt || s.soldAt || timestamp, deletedAt: s.deletedAt || null
    })),
    meta: { ...(data.meta || {}), localRevision: numberOr(data.meta?.localRevision, 0), updatedAt: data.meta?.updatedAt || timestamp }
  };
}

export function emptyData() {
  const timestamp = nowISO();
  return normalizeData({
    schemaVersion: 4, datasetId: 'north-south-academy-main',
    settings: {
      academyName: 'North South Academy', defaultFee: 2500, currency: 'UYU', lastPaymentMethod: 'cash', lastSaleMethod: 'cash',
      updatedAt: timestamp, feeHistory: [{ id:'fee-initial', effectiveFrom:'1900-01', amount:2500, createdAt:timestamp, updatedAt:timestamp, deletedAt:null }]
    },
    members: [], payments: [], products: [], sales: [], meta: { updatedAt: timestamp, localRevision: 0 }
  });
}

export function loadData(email) {
  if (!email) return emptyData();
  for (const key of [dataKeyFor(email), backupKeyFor(email)]) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return normalizeData(JSON.parse(raw));
    } catch (e) {
      console.warn(`No se pudo leer ${key}`, e);
    }
  }
  return emptyData();
}

export function saveData(email, data, { markDirty = true } = {}) {
  if (!email) throw new Error('No hay una cuenta activa para guardar.');
  const normalized = normalizeData(clone(data));
  const timestamp = nowISO();
  normalized.meta.updatedAt = timestamp;
  normalized.meta.ownerEmail = String(email).trim().toLowerCase();
  normalized.meta.localRevision = numberOr(normalized.meta.localRevision, 0) + 1;
  if (markDirty) normalized.meta.localDirtyAt = timestamp;
  const serialized = JSON.stringify(normalized);
  const key = dataKeyFor(email);
  const backupKey = backupKeyFor(email);
  const previous = localStorage.getItem(key);
  if (previous) localStorage.setItem(backupKey, previous);
  localStorage.setItem(key, serialized);
  const verified = localStorage.getItem(key);
  if (verified !== serialized) throw new Error('No se pudo confirmar el guardado local.');
  return normalizeData(JSON.parse(verified));
}

export function verifyLocalStorage() {
  const key = 'northsouth:storage-check';
  const value = `${Date.now()}-${Math.random()}`;
  try {
    localStorage.setItem(key, value);
    const ok = localStorage.getItem(key) === value;
    localStorage.removeItem(key);
    return ok;
  } catch { return false; }
}

export function hasLegacyLocalData() {
  try { return Boolean(localStorage.getItem(LEGACY_DATA_KEY)); }
  catch { return false; }
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

export function exportLegacyLocalData() {
  const raw = localStorage.getItem(LEGACY_DATA_KEY);
  if (!raw) throw new Error('No hay datos de una versión anterior en este navegador.');
  downloadJSON(normalizeData(JSON.parse(raw)), 'north-south-datos-version-anterior.json');
}

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}

export function exportBackup(data, email = '') {
  const account = String(email || '').split('@')[0].replace(/[^a-z0-9_-]/gi, '-') || 'cuenta';
  downloadJSON(normalizeData(data), `north-south-${account}-${new Date().toISOString().slice(0,10)}.json`);
}

export async function importBackup(file, email) {
  const text = await file.text();
  const parsed = normalizeData(JSON.parse(text));
  if (parsed.datasetId !== 'north-south-academy-main') throw new Error('El archivo no pertenece a North South.');
  parsed.meta.ownerEmail = String(email || '').trim().toLowerCase();
  return saveData(email, parsed);
}
