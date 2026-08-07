import { normalizeData } from './storage.js';
import { nowISO } from './utils.js';

const ms = value => {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
};

export function mergeEntities(local = [], remote = []) {
  const map = new Map();
  [...local, ...remote].forEach(item => {
    if (!item?.id) return;
    const current = map.get(item.id);
    if (!current || ms(item.updatedAt) >= ms(current.updatedAt)) map.set(item.id, structuredClone(item));
  });
  return [...map.values()];
}

function mergeSettings(local, remote) {
  const latest = ms(remote.updatedAt) > ms(local.updatedAt) ? remote : local;
  const feeHistory = mergeEntities(local.feeHistory, remote.feeHistory);
  const activeFees = feeHistory.filter(x => !x.deletedAt).sort((a,b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const defaultFee = activeFees.length ? Number(activeFees.at(-1).amount) : Number(latest.defaultFee || 2500);
  return {
    ...structuredClone(latest),
    defaultFee,
    feeHistory,
    updatedAt: ms(remote.updatedAt) > ms(local.updatedAt) ? remote.updatedAt : local.updatedAt
  };
}

export function mergeData(localInput, remoteInput) {
  const local = normalizeData(localInput);
  const remote = normalizeData(remoteInput);
  if (local.datasetId !== remote.datasetId) throw new Error('Los datos remotos pertenecen a otra instalación.');
  return normalizeData({
    ...local,
    settings: mergeSettings(local.settings, remote.settings),
    members: mergeEntities(local.members, remote.members),
    payments: mergeEntities(local.payments, remote.payments),
    products: mergeEntities(local.products, remote.products),
    sales: mergeEntities(local.sales, remote.sales),
    meta: {
      ...local.meta,
      ...remote.meta,
      localRevision: Math.max(Number(local.meta.localRevision || 0), Number(remote.meta.localRevision || 0)),
      updatedAt: nowISO(),
      lastMergedAt: nowISO()
    }
  });
}
