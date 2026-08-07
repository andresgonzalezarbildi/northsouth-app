import { addMonths, currentPeriod, fuzzyMatch, normalizeText } from './utils.js';

export const live = rows => (Array.isArray(rows) ? rows : []).filter(x => !x.deletedAt);
export const activeMembers = data => live(data.members).filter(m => m.status === 'active');
export const livePayments = data => live(data.payments);
export const liveSales = data => live(data.sales);
export const activeProducts = data => live(data.products).filter(p => p.active !== false);

export function memberName(member) {
  return member?.displayName || normalizeText(`${member?.firstName || ''} ${member?.lastName || ''}`);
}

function feeFromHistory(history, period, fallback) {
  const rows = live(history)
    .filter(x => /^\d{4}-\d{2}$/.test(x.effectiveFrom || '') && x.effectiveFrom <= period)
    .sort((a,b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
  return rows.length ? Number(rows.at(-1).amount || fallback || 0) : Number(fallback || 0);
}

export function memberFee(data, member, period = currentPeriod()) {
  if (!member) return Number(data.settings.defaultFee || 0);
  if (member.feeStartPeriod && period < member.feeStartPeriod) return 0;
  if (member.feeMode === 'custom') return feeFromHistory(member.feeHistory, period, member.monthlyFee || data.settings.defaultFee);
  return feeFromHistory(data.settings.feeHistory, period, data.settings.defaultFee);
}

export function paymentsFor(data, memberId, period = null) {
  return livePayments(data).filter(p => p.memberId === memberId && (!period || p.period === period));
}

export function paidForPeriod(data, memberId, period) {
  return paymentsFor(data, memberId, period).reduce((sum, p) => sum + Number(p.amount || 0), 0);
}

export function memberPeriodStatus(data, member, period = currentPeriod()) {
  const fee = memberFee(data, member, period);
  const paid = paidForPeriod(data, member.id, period);
  const remaining = Math.max(0, fee - paid);
  return { fee, paid, remaining, isPaid: fee > 0 ? paid >= fee : true, overpaid: Math.max(0, paid - fee), notStarted: fee === 0 };
}

export function firstUnpaidPeriod(data, member, start = currentPeriod(), maxMonths = 24) {
  for (let i = 0; i < maxMonths; i++) {
    const period = addMonths(start, i);
    const s = memberPeriodStatus(data, member, period);
    if (s.fee > 0 && !s.isPaid) return period;
  }
  return start;
}

export function paidThroughPeriod(data, member, start = currentPeriod(), maxMonths = 18) {
  let through = null;
  for (let i = 0; i < maxMonths; i++) {
    const period = addMonths(start, i);
    const s = memberPeriodStatus(data, member, period);
    if (!s.isPaid || s.fee <= 0) break;
    through = period;
  }
  return through;
}

export function expectedForPeriod(data, period = currentPeriod()) {
  return activeMembers(data).reduce((sum, m) => sum + memberFee(data, m, period), 0);
}

export function collectedForPeriod(data, period = currentPeriod()) {
  return livePayments(data).filter(p => p.period === period).reduce((sum, p) => sum + Number(p.amount || 0), 0);
}

export function pendingMembers(data, period = currentPeriod()) {
  return activeMembers(data)
    .map(member => ({ member, ...memberPeriodStatus(data, member, period) }))
    .filter(x => x.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining || memberName(a.member).localeCompare(memberName(b.member)));
}

export function periodSummary(data, period = currentPeriod()) {
  const expected = expectedForPeriod(data, period);
  const collected = collectedForPeriod(data, period);
  const pending = pendingMembers(data, period);
  const methods = { cash: 0, transfer: 0, other: 0, unknown: 0 };
  livePayments(data).filter(p => p.period === period).forEach(p => {
    const key = Object.hasOwn(methods, p.method) ? p.method : 'other';
    methods[key] += Number(p.amount || 0);
  });
  return {
    expected, collected,
    pendingAmount: pending.reduce((s, x) => s + x.remaining, 0),
    rate: expected ? Math.min(1, collected / expected) : 0,
    activeCount: activeMembers(data).length,
    pendingCount: pending.length,
    paidCount: Math.max(0, activeMembers(data).length - pending.length),
    methods
  };
}

export function recentPayments(data, limit = 8) {
  return livePayments(data).slice().sort((a, b) => movementTime(b) - movementTime(a)).slice(0, limit);
}

export function recentMovements(data, limit = 10) {
  const payments = livePayments(data).map(p => ({ ...p, movementType:'payment' }));
  const sales = liveSales(data).map(s => ({ ...s, movementType:'sale' }));
  return [...payments, ...sales].sort((a,b) => movementTime(b) - movementTime(a)).slice(0, limit);
}

function movementTime(row) {
  const raw = row.createdAt || row.updatedAt || row.paidAt || row.soldAt || '';
  const n = Date.parse(raw);
  return Number.isFinite(n) ? n : 0;
}

export function trend(data, endPeriod = currentPeriod(), count = 6) {
  return Array.from({ length: count }, (_, i) => addMonths(endPeriod, i - count + 1)).map(period => ({
    period,
    total: collectedForPeriod(data, period)
  }));
}

export function cantinaSummary(data, period = currentPeriod()) {
  const rows = liveSales(data).filter(s => String(s.soldAt || '').slice(0,7) === period);
  const total = rows.reduce((s, x) => s + Number(x.amount || 0), 0);
  const counts = new Map();
  rows.forEach(s => counts.set(s.productId, (counts.get(s.productId) || 0) + Number(s.quantity || 1)));
  const top = [...counts.entries()].sort((a,b) => b[1] - a[1])[0];
  return { total, count: rows.length, topProductId: top?.[0] || null, topQuantity: top?.[1] || 0 };
}

export function findMembers(data, query, { includeInactive = true, limit = 8 } = {}) {
  const q = normalizeText(query);
  return live(data.members)
    .filter(m => includeInactive || m.status === 'active')
    .filter(m => !q || fuzzyMatch(`${memberName(m)} ${m.phone || ''}`, q))
    .sort((a,b) => {
      const aStarts = normalizeText(memberName(a)).startsWith(q) ? 0 : 1;
      const bStarts = normalizeText(memberName(b)).startsWith(q) ? 0 : 1;
      return aStarts - bStarts || memberName(a).localeCompare(memberName(b), 'es');
    })
    .slice(0, limit);
}

export function validateMember(data, draft, editingId = null) {
  const errors = [];
  const name = normalizeText(`${draft.firstName || ''} ${draft.lastName || ''}`);
  if (!normalizeText(draft.firstName)) errors.push('El nombre es obligatorio.');
  if (draft.feeMode === 'custom' && Number(draft.monthlyFee) <= 0) errors.push('La cuota debe ser mayor a 0.');
  const duplicate = live(data.members).find(m => m.id !== editingId && normalizeText(memberName(m)) === name);
  if (duplicate) errors.push('Ya existe un socio con ese nombre.');
  return errors;
}

export function validatePayment(data, draft, editingId = null) {
  const errors = [];
  const member = live(data.members).find(m => m.id === draft.memberId);
  if (!member) errors.push('Elegí un socio.');
  if (!/^\d{4}-\d{2}$/.test(draft.period || '')) errors.push('Elegí el mes que cubre el pago.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.paidAt || '')) errors.push('Elegí la fecha de cobro.');
  const amount = Number(draft.amount);
  if (!(amount > 0)) errors.push('El monto debe ser mayor a 0.');
  return errors;
}

export function allocatePaymentAmount(data, member, startPeriod, amount, { editingId = null, maxMonths = 120 } = {}) {
  let pendingAmount = Number(amount || 0);
  const rows = [];
  if (!member || !/^\d{4}-\d{2}$/.test(startPeriod || '') || !(pendingAmount > 0)) {
    return { rows, remainder: Math.max(0, pendingAmount || 0) };
  }

  for (let i = 0; i < maxMonths && pendingAmount > 0; i++) {
    const period = addMonths(startPeriod, i);
    const fee = memberFee(data, member, period);
    if (!(fee > 0)) continue;
    const paid = livePayments(data)
      .filter(p => p.id !== editingId && p.memberId === member.id && p.period === period)
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const remaining = Math.max(0, fee - paid);
    if (!(remaining > 0)) continue;
    const applied = Math.min(pendingAmount, remaining);
    rows.push({ period, amount: applied, fee, paid, remainingBefore: remaining });
    pendingAmount -= applied;
  }

  return { rows, remainder: pendingAmount };
}

export function validateSale(data, draft, editingId = null) {
  const errors = [];
  const member = draft.memberId ? live(data.members).find(m => m.id === draft.memberId) : null;
  const product = live(data.products).find(p => p.id === draft.productId);
  if (draft.memberId && !member) errors.push('El socio seleccionado ya no está disponible.');
  if (!product) errors.push('Elegí un producto.');
  if (!(Number(draft.quantity) > 0)) errors.push('La cantidad debe ser mayor a 0.');
  if (!(Number(draft.unitPrice) > 0)) errors.push('Ingresá el precio.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.soldAt || '')) errors.push('Elegí la fecha.');
  return errors;
}
