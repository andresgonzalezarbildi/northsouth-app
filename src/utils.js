export const money = (value, currency = 'UYU') => new Intl.NumberFormat('es-UY', {
  style: 'currency', currency, maximumFractionDigits: 0
}).format(Number(value || 0));

export const normalizeText = value => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .trim().toUpperCase().replace(/\s+/g, ' ');

export function fuzzyMatch(value, query) {
  const haystack = normalizeText(value).replace(/\s+/g, ' ');
  const needle = normalizeText(query).replace(/\s+/g, ' ');
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  const words = needle.split(' ').filter(Boolean);
  return words.every(word => {
    let j = 0;
    for (let i = 0; i < haystack.length && j < word.length; i++) {
      if (haystack[i] === word[j]) j++;
    }
    return j === word.length;
  });
}

export const todayISO = () => {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
};

export const currentPeriod = () => todayISO().slice(0, 7);

export function addMonths(period, delta) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export const periodLabel = period => {
  if (!period) return '—';
  const [year, month] = period.split('-').map(Number);
  const text = new Intl.DateTimeFormat('es-UY', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const shortPeriodLabel = period => {
  if (!period) return '—';
  const [year, month] = period.split('-').map(Number);
  const text = new Intl.DateTimeFormat('es-UY', { month: 'short' }).format(new Date(year, month - 1, 1));
  return `${text.replace('.', '').slice(0,3)} ${String(year).slice(-2)}`;
};

export const dateLabel = iso => {
  if (!iso) return '—';
  const value = String(iso);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(Number(value.slice(0,4)), Number(value.slice(5,7)) - 1, Number(value.slice(8,10)), 12)
    : new Date(value);
  return new Intl.DateTimeFormat('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
};

export const dateTimeLabel = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return dateLabel(iso);
  return new Intl.DateTimeFormat('es-UY', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }).format(d);
};

export const nowISO = () => new Date().toISOString();
export const uid = prefix => `${prefix}-${crypto.randomUUID()}`;

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
