import {
  dataKeyFor, loadData, saveData, overwriteData, emptyData, verifyLocalStorage,
  exportBackup, importBackup, getDeviceId
} from './storage.js';
import { connectGoogle, disconnectGoogle, getGoogleProfile, googleTokenExpiresAt, invalidateGoogleToken, restoreGoogleToken } from './google-auth.js';
import { syncWithDrive } from './drive-sync.js';
import { createOperation, createResetOperation, applyOperations, mergeOperations } from './journal.js';
import { mergeData } from './merge.js';
import { makeResetMarker } from './generation.js';
import { GOOGLE_WEB_CLIENT_ID } from './app-config.js';
import { loadAuthSession, saveAuthSession, clearAuthSession, normalizeEmail } from './session.js';
import {
  activeMembers, activeProducts, allocatePaymentAmount, cantinaSummary, findMembers, firstUnpaidPeriod, live, livePayments, liveSales,
  memberFee, memberName, memberPeriodStatus, paidThroughPeriod, pendingMembers, periodSummary, recentMovements, recentPayments, trend,
  validateMember, validatePayment, validateSale
} from './model.js';
import {
  addMonths, currentPeriod, dateLabel, dateTimeLabel, escapeHTML, fuzzyMatch, money,
  normalizeText, nowISO, periodLabel, shortPeriodLabel, todayISO, uid
} from './utils.js';

const APP_VERSION = '6.6.3';
const app = document.querySelector('#app');
const AUTO_SYNC_MS = 30000;
const DRIVE_LINK_PREFIX = 'northsouth:drive-linked:v1:';

const savedSession = loadAuthSession();
const state = {
  account: savedSession,
  data: savedSession ? loadData(savedSession.email) : null,
  authBusy: false,
  authError: '',
  view: 'dashboard',
  memberQuery: '', memberFilter: 'active',
  paymentQuery: '', paymentMethod: 'all', paymentPeriod: 'all',
  feeQuery: '', feeWindowStart: addMonths(currentPeriod(), -1),
  cantinaQuery: '', cantinaProductFilter: 'active',
  settingsSection: null,
  modal: null, toast: null, token: null,
  sync: {
    kind: navigator.onLine ? 'local' : 'offline',
    text: navigator.onLine ? (GOOGLE_WEB_CLIENT_ID ? 'Local · Drive sin conectar' : 'Guardado local') : 'Sin conexión · guardado local',
    lastAt: null
  },
  syncing: false, syncTimer: null, syncInterval: null, syncedOperationIds: new Set(),
  driveLinked: Boolean(savedSession && localStorage.getItem(`${DRIVE_LINK_PREFIX}${encodeURIComponent(savedSession.email)}`) === '1'),
  storageOK: verifyLocalStorage(), memberListScrollY: 0
};

if (state.driveLinked && navigator.onLine && GOOGLE_WEB_CLIENT_ID) {
  state.sync = { ...state.sync, kind:'auth', text:'Drive vinculado · comprobando autorización' };
}

const viewMeta = {
  dashboard: ['Resumen', 'Estado general de socios y cuotas'],
  members: ['Socios', 'Fichas, cuotas y cobro rápido'],
  fees: ['Cuotas', 'Vista mensual de pagos y adelantos'],
  payments: ['Pagos', 'Historial de cuotas registradas'],
  cantina: ['Cantina', 'Ventas a socios y productos'],
  settings: ['Ajustes', 'Cuota general, sincronización y respaldo']
};

const methodLabel = method => ({ cash:'Efectivo', transfer:'Transferencia', other:'Otro', unknown:'Sin especificar' }[method] || 'Otro');
const initials = name => normalizeText(name).split(' ').filter(Boolean).slice(0,2).map(x => x[0]).join('') || 'NS';
const getMember = id => live(state.data?.members).find(m => m.id === id);
const getProduct = id => live(state.data?.products).find(p => p.id === id);
const clientId = () => GOOGLE_WEB_CLIENT_ID || '';
const compactViewport = () => window.matchMedia?.('(max-width: 720px)').matches ?? window.innerWidth <= 720;
const CLEAR_PHRASE = 'borrar datos northsouthjjm';

function isKeyboardField(element) {
  if (!element?.matches?.('input, textarea, [contenteditable="true"]')) return false;
  if (element.matches('textarea, [contenteditable="true"]')) return true;
  return !['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(String(element.type || 'text').toLowerCase());
}

function usesSoftKeyboardLayout() {
  return Boolean(window.Capacitor?.isNativePlatform?.()) || window.matchMedia?.('(max-width: 1000px), (pointer: coarse)').matches;
}

function syncVisualViewport() {
  const viewport = window.visualViewport;
  const height = Math.max(180, Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight));
  const offsetTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
  document.documentElement.style.setProperty('--visual-viewport-height', `${height}px`);
  document.documentElement.style.setProperty('--visual-viewport-top', `${offsetTop}px`);
}

function revealFocusedField(field) {
  if (!isKeyboardField(field) || !document.contains(field)) return;
  syncVisualViewport();
  field.scrollIntoView({ behavior:'auto', block:'center', inline:'nearest' });
}

function keepFocusedFieldVisible(event) {
  const field = event.target;
  if (!usesSoftKeyboardLayout() || !isKeyboardField(field)) return;
  document.documentElement.classList.add('soft-keyboard-focus');
  [80, 220, 420].forEach(delay => setTimeout(() => revealFocusedField(field), delay));
}

function clearKeyboardFocusState() {
  setTimeout(() => {
    if (isKeyboardField(document.activeElement)) return;
    document.documentElement.classList.remove('soft-keyboard-focus');
    syncVisualViewport();
  }, 180);
}

function handleVisualViewportChange() {
  syncVisualViewport();
  const field = document.activeElement;
  if (usesSoftKeyboardLayout() && isKeyboardField(field)) requestAnimationFrame(() => revealFocusedField(field));
}

function driveLinkKey(email = state.account?.email) {
  return email ? `${DRIVE_LINK_PREFIX}${encodeURIComponent(String(email).trim().toLowerCase())}` : '';
}

function setDriveLinked(value) {
  state.driveLinked = Boolean(value);
  const key = driveLinkKey();
  if (!key) return;
  if (value) localStorage.setItem(key, '1');
  else localStorage.removeItem(key);
}

function syncClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString('es-UY', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function tokenExpiredInWeb() {
  const native = Boolean(window.Capacitor?.isNativePlatform?.());
  return !native && Boolean(state.token) && !googleTokenExpiresAt();
}

function startAutoSync() {
  clearInterval(state.syncInterval);
  if (!state.account) return;
  state.syncInterval = setInterval(() => {
    if (document.visibilityState !== 'visible' || !navigator.onLine || !state.token || state.syncing) return;
    syncNow(false);
  }, AUTO_SYNC_MS);
}

function stopAutoSync() {
  clearInterval(state.syncInterval);
  state.syncInterval = null;
}


function toast(message, type = 'ok') {
  state.toast = { message, type };
  render();
  setTimeout(() => {
    if (state.toast?.message === message) { state.toast = null; render(); }
  }, 2800);
}

function pendingOperationCount(data = state.data) {
  return (data?.operations || []).filter(op => !state.syncedOperationIds.has(op.id)).length;
}

function persist(message = null, { sync = true } = {}) {
  if (!state.account?.email || !state.data) return false;
  try {
    const before = loadData(state.account.email);
    const operation = createOperation(before, state.data, {
      label: message || 'Cambio guardado',
      deviceId: getDeviceId()
    });
    if (operation) state.data.operations = mergeOperations(state.data.operations, [operation]);

    state.data = saveData(state.account.email, state.data);
    const reloaded = loadData(state.account.email);
    if (reloaded.meta.localRevision !== state.data.meta.localRevision) throw new Error('La verificación local devolvió otra revisión.');
    state.data = reloaded;
    state.storageOK = true;
    const pending = pendingOperationCount();
    state.sync = !navigator.onLine
      ? { ...state.sync, kind: 'offline', text: `Guardado local · ${pending || 1} cambio${pending === 1 ? '' : 's'} pendiente${pending === 1 ? '' : 's'}` }
      : !state.token
        ? state.driveLinked
          ? { ...state.sync, kind: 'auth', text: `Guardado local · Drive requiere autorización` }
          : { ...state.sync, kind: 'local', text: 'Guardado local · Drive sin conectar' }
        : { ...state.sync, kind: 'pending', text: `Guardado · ${pending || 1} cambio${pending === 1 ? '' : 's'} pendiente${pending === 1 ? '' : 's'}` };
  } catch (e) {
    console.error(e);
    state.storageOK = false;
    toast('No se pudo guardar en este dispositivo.', 'error');
    return false;
  }
  render();
  if (message) toast(`${message} Guardado en este dispositivo.`);
  if (sync) scheduleSync();
  return true;
}

function clearPageSearches() {
  state.memberQuery = '';
  state.paymentQuery = '';
  state.feeQuery = '';
  state.cantinaQuery = '';
}

function navigate(view) {
  if (!state.account) return;
  if (view === 'fees' && compactViewport()) view = 'payments';
  state.view = view;
  state.modal = null;
  clearPageSearches();
  render({ preserveScroll:false });
}

function scheduleSync() {
  clearTimeout(state.syncTimer);
  if (!state.account || !state.data) return;
  if (!navigator.onLine) {
    state.sync = { ...state.sync, kind:'offline', text:'Sin conexión · guardado local' };
    render();
    return;
  }
  if (!clientId()) {
    state.sync = { ...state.sync, kind:'local', text:'Guardado local' };
    render();
    return;
  }
  if (!state.token) {
    state.sync = state.driveLinked
      ? { ...state.sync, kind:'auth', text:'Drive requiere autorización' }
      : { ...state.sync, kind:'local', text:'Guardado local · Drive sin conectar' };
    render();
    return;
  }
  state.syncTimer = setTimeout(() => syncNow(false), 700);
}

async function ensureDriveLogin({ selectAccount = true } = {}) {
  const cid = clientId();
  if (!cid) throw new Error('Google no está configurado en esta versión.');
  const login = await connectGoogle(cid, { selectAccount, loginHint: state.account?.email || '' });
  const email = normalizeEmail(login.profile?.email);
  if (!email) {
    await disconnectGoogle();
    throw new Error('No se pudo leer el correo de la cuenta de Google.');
  }
  return { ...login, email };
}

async function loginWithGoogle() {
  if (state.authBusy) return;
  if (!navigator.onLine) {
    state.authError = 'Necesitás internet para iniciar sesión por primera vez en este dispositivo.';
    render();
    return;
  }
  if (!clientId()) {
    state.authError = 'Google no está configurado en esta versión. Revisá el archivo .env.';
    render();
    return;
  }
  try {
    state.authBusy = true;
    state.authError = '';
    render();
    const login = await ensureDriveLogin({ selectAccount:true });
    state.account = saveAuthSession({ email:login.email, name:login.profile?.name || '' });
    state.data = loadData(state.account.email);
    state.token = login.token;
    setDriveLinked(true);
    state.syncedOperationIds = new Set();
    state.sync = { kind:'local', text:'Guardado local · preparando Drive', lastAt:null };
    state.view = 'dashboard';
    state.authBusy = false;
    startAutoSync();
    render({ preserveScroll:false });
    await syncNow(false);
  } catch (e) {
    console.error(e);
    state.authBusy = false;
    state.authError = e.message || 'No se pudo iniciar sesión.';
    render();
  }
}

async function logout() {
  await disconnectGoogle();
  setDriveLinked(false);
  clearAuthSession();
  clearTimeout(state.syncTimer);
  stopAutoSync();
  state.account = null;
  state.data = null;
  state.token = null;
  state.syncedOperationIds = new Set();
  state.modal = null;
  state.toast = null;
  state.authError = '';
  state.sync = { kind:'local', text:'Guardado local', lastAt:null };
  render({ preserveScroll:false });
}

async function syncNow(interactive = false) {
  if (state.syncing || !state.account || !state.data) {
    if (interactive && state.syncing) toast('Drive ya se está sincronizando.');
    return;
  }
  const cid = clientId();
  if (!cid) {
    if (interactive) toast('Google no está configurado en esta versión.', 'error');
    return;
  }
  if (!navigator.onLine) {
    const pending = pendingOperationCount();
    state.sync = { ...state.sync, kind:'offline', text:pending ? `Sin conexión · ${pending} cambio${pending===1?'':'s'} local${pending===1?'':'es'}` : 'Sin conexión · datos guardados localmente' };
    if (interactive) toast('Sin internet. Todo sigue guardado en este dispositivo.', 'error');
    render();
    return;
  }

  if (tokenExpiredInWeb()) {
    await invalidateGoogleToken();
    state.token = null;
  }

  let syncSucceeded = false;
  try {
    let token = state.token;
    if (!token) {
      token = await restoreGoogleToken(cid);
      if (token) {
        const profile = await getGoogleProfile(token);
        const tokenEmail = normalizeEmail(profile?.email);
        if (!tokenEmail || tokenEmail !== state.account.email) {
          await invalidateGoogleToken();
          token = null;
        }
      }
    }

    // En la web Google no permite renovar un access token vencido en segundo plano.
    // Si el usuario apretó el botón, ese click sí es el gesto necesario para renovarlo.
    if (!token && interactive) {
      const login = await ensureDriveLogin({ selectAccount:false });
      if (login.email !== state.account.email) {
        await disconnectGoogle();
        setDriveLinked(false);
        throw new Error(`Conectá Drive con ${state.account.email}.`);
      }
      token = login.token;
      setDriveLinked(true);
    }

    if (!token) {
      const pending = pendingOperationCount();
      state.sync = state.driveLinked
        ? { ...state.sync, kind:'auth', text:pending ? `Drive requiere autorización · ${pending} cambio${pending===1?'':'s'} local${pending===1?'':'es'}` : 'Drive requiere autorización', lastError:'' }
        : { ...state.sync, kind:'local', text:'Guardado local · Drive sin conectar', lastError:'' };
      render();
      return;
    }

    state.token = token;
    setDriveLinked(true);
    state.syncing = true;
    const pendingBefore = pendingOperationCount();
    state.sync = { ...state.sync, kind:'busy', text: pendingBefore ? `Drive · sincronizando ${pendingBefore} cambio${pendingBefore===1?'':'s'}…` : 'Drive · iniciando comprobación…', lastError:'' };
    render();

    const syncStartData = structuredClone(state.data);
    const result = await syncWithDrive(syncStartData, token, {
      onProgress: ({ text }) => {
        if (!state.syncing) return;
        state.sync = { ...state.sync, kind:'busy', text:text || 'Drive · sincronizando…' };
        render();
      }
    });

    // Si el usuario guardó algo mientras Drive estaba trabajando, se combina con el resultado
    // en vez de reemplazar el estado actual por una copia iniciada unos segundos antes.
    const generationChanged = state.data.datasetId !== result.data.datasetId;
    const operations = generationChanged
      ? (result.data.operations || []).filter(op => op.datasetId === result.data.datasetId)
      : mergeOperations(state.data.operations, result.data.operations);
    let combined = generationChanged ? structuredClone(result.data) : mergeData(state.data, result.data);
    combined.operations = operations;
    combined = applyOperations(combined, operations);
    combined.operations = operations;
    state.data = saveData(state.account.email, combined, { markDirty:false });
    state.syncedOperationIds = new Set(result.remoteOperationIds || []);
    const pendingAfter = pendingOperationCount();
    const syncedAt = nowISO();
    state.sync = pendingAfter
      ? { kind:'pending', text:`Drive conectado · ${pendingAfter} cambio${pendingAfter===1?'':'s'} pendiente${pendingAfter===1?'':'s'}`, lastAt:syncedAt, lastError:'' }
      : { kind:'ok', text:`Drive al día · ${syncClock(syncedAt)}`, lastAt:syncedAt, lastError:'' };
    syncSucceeded = true;
    if (interactive) toast(pendingAfter ? 'Los cambios locales están guardados; queda sincronización pendiente.' : (result.created ? 'Drive conectado y sincronizado.' : 'Drive sincronizado.'));
  } catch (e) {
    console.error(e);
    const pending = pendingOperationCount();
    const message = e.message || 'No se pudo sincronizar.';
    if (/venció|401|Unauthorized/i.test(message)) {
      await invalidateGoogleToken();
      state.token = null;
      state.sync = { ...state.sync, kind:'auth', text:pending ? `Drive requiere autorización · ${pending} cambio${pending===1?'':'s'} local${pending===1?'':'es'}` : 'Drive requiere autorización', lastError:'La autorización de Google venció. Tocá “Renovar acceso a Drive”.' };
    } else {
      state.sync = { ...state.sync, kind:'error', text:pending ? `Drive con error · ${pending} cambio${pending===1?'':'s'} seguro${pending===1?'':'s'} localmente` : 'Drive con error · datos locales seguros', lastError:message };
    }
    if (interactive) toast(message, 'error');
  } finally {
    state.syncing = false;
    render();
    if (syncSucceeded && state.token && navigator.onLine && pendingOperationCount() > 0) scheduleSync();
  }
}

function renderLogin() {
  const configured = Boolean(clientId());
  return `<main class="login-screen">
    <section class="login-card">
      <div class="login-logo-wrap"><img src="./assets/north-south-logo.jpg" alt="North South Academy"></div>
      <div class="login-kicker">NORTH SOUTH</div>
      <h1>Academy</h1>
      <p>Ingresá con Google. Cada cuenta mantiene sus propios datos, separados del resto.</p>
      ${state.authError ? `<div class="login-error">${escapeHTML(state.authError)}</div>` : ''}
      <button class="btn primary login-google" data-action="login-google" ${state.authBusy || !configured ? 'disabled' : ''}>
        <span class="google-g">G</span>${state.authBusy ? 'Ingresando…' : 'Ingresar con Google'}
      </button>
      ${!configured ? '<small>Falta VITE_GOOGLE_WEB_CLIENT_ID en .env.</small>' : ''}
      <div class="login-foot">Los datos se guardan por cuenta en este dispositivo y se sincronizan únicamente con el espacio privado de esa cuenta en Drive.</div>
    </section>
  </main>`;
}

function navButton(view, icon, label) {
  return `<button class="nav-btn ${state.view === view ? 'active' : ''}" data-view="${view}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`;
}

function shell(content) {
  const [title, subtitle] = viewMeta[state.view];
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <button class="brand brand-button" data-view="dashboard" aria-label="Ir al resumen">
          <img src="./assets/north-south-logo.jpg" alt="North South"><div><div class="brand-title">NORTH SOUTH</div><div class="brand-sub">Academy · Maldonado</div></div>
        </button>
        <nav class="nav-list">
          ${navButton('dashboard','⌂','Resumen')}
          ${navButton('members','♟','Socios')}
          ${navButton('fees','▦','Cuotas')}
          ${navButton('payments','$','Pagos')}
          ${navButton('cantina','☕','Cantina')}
          ${navButton('settings','⚙','Ajustes')}
        </nav>
        <div class="sidebar-account"><span>Cuenta</span><strong>${escapeHTML(state.account?.name || state.account?.email || '')}</strong><small>${escapeHTML(state.account?.email || '')}</small></div>
      </aside>
      <main class="main">
        <button class="mobile-brand brand-button" data-view="dashboard"><img src="./assets/north-south-logo.jpg" alt=""><strong>NORTH SOUTH ACADEMY</strong></button>
        <header class="topbar">
          <div class="topbar-left"><h1>${title}</h1><p>${subtitle}</p></div>
          <div class="top-actions">
            <div class="sync-pill ${state.sync.kind}"><span class="sync-dot"></span>${escapeHTML(state.sync.text)}</div>
            <button class="btn primary top-action" data-action="new-payment"><span class="action-icon">$</span><span>Registrar pago</span></button>
            <button class="btn cantina-btn top-action" data-action="new-sale"><span class="action-icon">☕</span><span>Venta cantina</span></button>
          </div>
        </header>
        <button class="mobile-sync-status sync-pill ${state.sync.kind}" data-view="settings"><span class="sync-dot"></span>${escapeHTML(state.sync.text)}</button>
        ${content}
      </main>
      <nav class="mobile-nav">
        <button data-view="dashboard" class="${state.view === 'dashboard' ? 'active' : ''}"><b>⌂</b>Resumen</button>
        <button data-view="members" class="${state.view === 'members' ? 'active' : ''}"><b>♟</b>Socios</button>
        <button data-view="payments" class="${state.view === 'payments' ? 'active' : ''}"><b>$</b>Pagos</button>
        <button data-view="cantina" class="${state.view === 'cantina' ? 'active' : ''}"><b>☕</b>Cantina</button>
        <button data-view="settings" class="${state.view === 'settings' ? 'active' : ''}"><b>⚙</b>Ajustes</button>
      </nav>
    </div>
    ${renderModal()}
    ${state.toast ? `<div class="toast ${state.toast.type === 'error' ? 'error' : ''}">${escapeHTML(state.toast.message)}</div>` : ''}
  `;
}

function renderDashboard() {
  const period = currentPeriod();
  const summary = periodSummary(state.data, period);
  const pending = pendingMembers(state.data, period);
  const recent = recentMovements(state.data, 8);
  const payments = recentPayments(state.data, 8).filter(p => p.period === period);
  const history = trend(state.data, period, 6);
  const rate = Math.round(summary.rate * 100);
  const maxTrend = Math.max(1, ...history.map(x => Number(x.total || 0)));
  const methodTotal = Object.values(summary.methods).reduce((sum, value) => sum + Number(value || 0), 0);
  const cashPct = methodTotal ? (summary.methods.cash / methodTotal) * 100 : 0;
  const transferPct = methodTotal ? (summary.methods.transfer / methodTotal) * 100 : 0;
  const otherPct = methodTotal ? ((summary.methods.other + summary.methods.unknown) / methodTotal) * 100 : 0;
  const cashEnd = cashPct;
  const transferEnd = cashPct + transferPct;

  const pendingRows = pending.slice(0, 8).map(item => `<div class="row-card dashboard-pending-row">
    <button class="avatar avatar-button pending" data-action="member-detail" data-id="${item.member.id}">${initials(memberName(item.member))}</button>
    <button class="row-main text-button" data-action="member-detail" data-id="${item.member.id}"><div class="row-title">${escapeHTML(memberName(item.member))}</div><div class="row-sub">Cuota de ${shortPeriodLabel(period)} pendiente</div></button>
    <button class="btn primary small" data-action="pay-member-period" data-id="${item.member.id}" data-period="${period}">Cobrar</button>
  </div>`).join('') || '<div class="empty">No hay cuotas pendientes este mes.</div>';

  const movementRows = recent.map(row => {
    if (row.movementType === 'payment') {
      const member = getMember(row.memberId);
      return `<div class="movement-row"><div class="movement-icon payment">$</div><div class="row-main"><div class="row-title">${escapeHTML(member ? memberName(member) : (row.memberNameSnapshot || 'Socio no disponible'))}</div><div class="row-sub">Pago · ${shortPeriodLabel(row.period)} · ${dateTimeLabel(row.createdAt || row.updatedAt)}</div></div></div>`;
    }
    const member = getMember(row.memberId);
    const product = getProduct(row.productId);
    return `<div class="movement-row"><div class="movement-icon sale">${escapeHTML(product?.emoji || row.productEmoji || '☕')}</div><div class="row-main"><div class="row-title">${escapeHTML(product?.name || row.productName || 'Venta cantina')}</div><div class="row-sub">${member ? escapeHTML(memberName(member)) + ' · ' : ''}${dateTimeLabel(row.createdAt || row.updatedAt)}</div></div></div>`;
  }).join('') || '<div class="empty">Todavía no hay movimientos.</div>';

  const collectionRows = payments.map(p => {
    const member = getMember(p.memberId);
    return `<div class="row-card"><div class="avatar">${initials(member ? memberName(member) : '?')}</div><div class="row-main"><div class="row-title">${escapeHTML(member ? memberName(member) : (p.memberNameSnapshot || 'Socio no disponible'))}</div><div class="row-sub">${dateLabel(p.paidAt)} · ${methodLabel(p.method)}</div></div><div class="amount">${money(p.amount)}</div></div>`;
  }).join('') || '<div class="empty">No hay cobros registrados para este mes.</div>';

  const trendBars = history.map(item => {
    const height = Math.max(4, Math.round((Number(item.total || 0) / maxTrend) * 100));
    return `<div class="bar-wrap"><div class="bar-value">${money(item.total)}</div><div class="bar" style="height:${height}%"></div><div class="bar-label">${shortPeriodLabel(item.period).split(' ')[0]}</div></div>`;
  }).join('');

  return `
    <section class="card dashboard-hero">
      <div class="hero-main">
        <div class="eyebrow">${periodLabel(period)}</div>
        <div class="hero-title">${summary.paidCount} al día <span>de ${summary.activeCount} socios activos</span></div>
        <div class="hero-sub">El resumen muestra el estado general sin exponer importes de cobros de entrada.</div>
        <div class="progress-track big"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, rate))}%"></div></div>
        <div class="progress-row"><span>${rate}% de cobranza del mes</span><span>${summary.pendingCount} pendiente${summary.pendingCount===1?'':'s'}</span></div>
      </div>
      <div class="hero-rate"><strong>${rate}%</strong><span>cobranza</span></div>
    </section>

    <div class="simple-kpis">
      <button class="card simple-kpi" data-view="members"><span class="kpi-icon">♟</span><span><small>Socios activos</small><strong>${summary.activeCount}</strong></span></button>
      <button class="card simple-kpi" data-view="members"><span class="kpi-icon">✓</span><span><small>Cuotas al día</small><strong>${summary.paidCount}</strong></span></button>
      <button class="card simple-kpi" data-view="members"><span class="kpi-icon">!</span><span><small>Pendientes</small><strong>${summary.pendingCount}</strong></span></button>
      <button class="card simple-kpi" data-action="new-payment"><span class="kpi-icon">＋</span><span><small>Acción rápida</small><strong>Registrar pago</strong></span></button>
    </div>

    <div class="dashboard-grid dashboard-clean">
      <section class="card panel">
        <div class="panel-head"><div><div class="panel-title">Cuotas pendientes</div><div class="panel-subtitle">Socios que todavía no completaron ${periodLabel(period).toLowerCase()}</div></div><span class="badge warn">${summary.pendingCount}</span></div>
        <div class="list">${pendingRows}</div>
      </section>
      <section class="card panel dashboard-side-panel">
        <div class="panel-head"><div><div class="panel-title">Últimos movimientos</div><div class="panel-subtitle">Sin mostrar importes en el resumen</div></div></div>
        <div class="movement-list">${movementRows}</div>
      </section>
    </div>

    <details class="card collections-details">
      <summary>
        <span><strong>Cobros del mes</strong><small>Importes, medios de pago y evolución</small></span>
        <span class="details-chevron">⌄</span>
      </summary>
      <div class="collections-body">
        <div class="kpi-grid collections-kpis">
          <div class="card kpi green"><div class="kpi-label">Cobrado</div><div class="kpi-value">${money(summary.collected)}</div><div class="kpi-sub">Registrado en ${periodLabel(period).toLowerCase()}</div></div>
          <div class="card kpi"><div class="kpi-label">Esperado</div><div class="kpi-value">${money(summary.expected)}</div><div class="kpi-sub">Según cuotas vigentes</div></div>
          <div class="card kpi red"><div class="kpi-label">Pendiente</div><div class="kpi-value">${money(summary.pendingAmount)}</div><div class="kpi-sub">${summary.pendingCount} socio${summary.pendingCount===1?'':'s'}</div></div>
          <div class="card kpi"><div class="kpi-label">Cobranza</div><div class="kpi-value">${rate}%</div><div class="kpi-sub">Del total esperado</div></div>
        </div>
        <div class="dashboard-grid collections-grid">
          <section class="card panel">
            <div class="panel-head"><div><div class="panel-title">Últimos cobros</div><div class="panel-subtitle">Solo del mes actual</div></div><button class="btn small ghost" data-view="payments">Ver pagos</button></div>
            <div class="list">${collectionRows}</div>
          </section>
          <div class="dashboard-side">
            <section class="card panel">
              <div class="panel-head"><div><div class="panel-title">Medios de pago</div><div class="panel-subtitle">Distribución de ${periodLabel(period).toLowerCase()}</div></div></div>
              <div class="donut-row">
                <div class="donut" style="background:conic-gradient(#df2935 0 ${cashEnd}%, #e1c466 ${cashEnd}% ${transferEnd}%, #747474 ${transferEnd}% 100%)"></div>
                <div class="legend">
                  <div class="legend-item"><span class="legend-label"><i class="legend-dot cash"></i>Efectivo</span><strong>${money(summary.methods.cash)}</strong></div>
                  <div class="legend-item"><span class="legend-label"><i class="legend-dot transfer"></i>Transferencia</span><strong>${money(summary.methods.transfer)}</strong></div>
                  <div class="legend-item"><span class="legend-label"><i class="legend-dot unknown"></i>Otros / sin especificar</span><strong>${money(summary.methods.other + summary.methods.unknown)}</strong></div>
                </div>
              </div>
            </section>
            <section class="card panel">
              <div class="panel-head"><div><div class="panel-title">Últimos 6 meses</div><div class="panel-subtitle">Cobros registrados por período</div></div></div>
              <div class="chart-bars compact">${trendBars}</div>
            </section>
          </div>
        </div>
      </div>
    </details>`;
}

function memberStatusLabel(member) {
  if (member.status === 'inactive') return { cls:'inactive', text:'Inactivo' };
  const current = memberPeriodStatus(state.data, member, currentPeriod());
  if (!current.isPaid) return { cls:'warn', text:`Debe ${money(current.remaining)}` };
  const through = paidThroughPeriod(state.data, member, currentPeriod());
  if (through && through > currentPeriod()) return { cls:'ok', text:`Al día hasta ${shortPeriodLabel(through)}` };
  return { cls:'ok', text:'Al día' };
}

function filteredMembers() {
  return live(state.data.members)
    .filter(m => state.memberFilter === 'all' || m.status === state.memberFilter)
    .filter(m => !state.memberQuery || fuzzyMatch(`${memberName(m)} ${m.phone || ''}`, state.memberQuery))
    .sort((a,b) => memberName(a).localeCompare(memberName(b),'es'));
}

function renderMemberCards(rows = filteredMembers()) {
  return rows.map(m => {
    const badge = memberStatusLabel(m);
    return `<div class="card member-card">
      <button class="avatar avatar-button" data-action="member-detail" data-id="${m.id}">${initials(memberName(m))}</button>
      <button class="row-main text-button" data-action="member-detail" data-id="${m.id}"><div class="row-title">${escapeHTML(memberName(m))}</div><div class="row-sub">Cuota ${money(memberFee(state.data,m,currentPeriod()))}${m.phone ? ` · ${escapeHTML(m.phone)}` : ''}</div></button>
      <div class="member-actions"><span class="badge ${badge.cls}">${badge.text}</span>${m.status==='active'?`<button class="btn primary small" data-action="pay-member" data-id="${m.id}">Cobrar</button>`:''}</div>
    </div>`;
  }).join('') || '<div class="empty card full-span">No hay socios que coincidan con la búsqueda.</div>';
}

function renderMembers() {
  return `
    <div class="toolbar toolbar-balanced">
      <div class="search grow"><input id="member-search" value="${escapeHTML(state.memberQuery)}" placeholder="Buscar socio…" autocomplete="off"></div>
      <div class="filter-tabs">${[['active','Activos'],['inactive','Inactivos'],['all','Todos']].map(([v,l]) => `<button class="filter-tab ${state.memberFilter===v?'active':''}" data-member-filter="${v}">${l}</button>`).join('')}</div>
      <button class="btn" data-action="new-member">＋ Nuevo socio</button>
    </div>
    <div class="member-grid" data-search-results="members">${renderMemberCards()}</div>`;
}

function filteredFeeMembers() {
  return activeMembers(state.data)
    .filter(m => !state.feeQuery || fuzzyMatch(memberName(m), state.feeQuery))
    .sort((a,b) => memberName(a).localeCompare(memberName(b),'es'));
}

function renderFeeRows(periods, rows = filteredFeeMembers()) {
  return rows.map(m => `<tr><td class="member-col"><button class="matrix-member" data-action="member-detail" data-id="${m.id}">${escapeHTML(memberName(m))}</button></td>${periods.map(p => renderFeeCell(m,p)).join('')}</tr>`).join('');
}

function renderFees() {
  const periods = Array.from({length:7}, (_,i) => addMonths(state.feeWindowStart, i));
  return `
    <div class="toolbar toolbar-balanced">
      <div class="search grow"><input id="fee-search" value="${escapeHTML(state.feeQuery)}" placeholder="Buscar socio…" autocomplete="off"></div>
      <div class="period-nav"><button class="btn small ghost" data-action="fees-prev">‹ 3 meses</button><button class="btn small" data-action="fees-today">Hoy</button><button class="btn small ghost" data-action="fees-next">3 meses ›</button></div>
    </div>
    <section class="card matrix-card">
      <div class="matrix-help">Tocá un mes pendiente para registrar el cobro. Los meses pagos por adelantado quedan marcados en verde.</div>
      <div class="fees-scroll" data-scroll-key="fees-table">
        <table class="fees-table">
          <thead><tr><th class="member-col">Socio</th>${periods.map(p=>`<th class="${p===currentPeriod()?'current-month':''}">${shortPeriodLabel(p)}</th>`).join('')}</tr></thead>
          <tbody data-search-results="fees">${renderFeeRows(periods)}</tbody>
        </table>
      </div>
    </section>`;
}

function renderFeeCell(member, period) {
  const s = memberPeriodStatus(state.data, member, period);
  if (s.notStarted) return `<td><div class="fee-cell none">—</div></td>`;
  if (s.isPaid) return `<td><button class="fee-cell paid" data-action="member-detail" data-id="${member.id}"><strong>✓ PAGO</strong><small>${money(s.paid)}</small></button></td>`;
  const future = period > currentPeriod();
  const text = s.paid > 0 ? `Falta ${money(s.remaining)}` : future ? money(s.fee) : `Debe ${money(s.remaining)}`;
  const cls = s.paid > 0 ? 'partial' : future ? 'future' : 'due';
  return `<td><button class="fee-cell ${cls}" data-action="pay-member-period" data-id="${member.id}" data-period="${period}"><strong>${text}</strong>${s.paid>0?`<small>Pagó ${money(s.paid)}</small>`:''}</button></td>`;
}

function filteredPayments() {
  return livePayments(state.data)
    .filter(p => state.paymentPeriod === 'all' || p.period === state.paymentPeriod)
    .filter(p => state.paymentMethod === 'all' || p.method === state.paymentMethod)
    .filter(p => {
      if (!state.paymentQuery) return true;
      const m = getMember(p.memberId);
      return fuzzyMatch(`${m ? memberName(m) : ''} ${p.note || ''}`, state.paymentQuery);
    })
    .sort((a,b) => Date.parse(b.createdAt || b.updatedAt || 0) - Date.parse(a.createdAt || a.updatedAt || 0));
}

function renderPaymentRows(rows = filteredPayments()) {
  return rows.map(p => { const m=getMember(p.memberId); return `<div class="row-card"><div class="avatar">${initials(m?memberName(m):'?')}</div><div class="row-main"><div class="row-title">${escapeHTML(m?memberName(m):(p.memberNameSnapshot||'Socio no disponible'))}</div><div class="row-sub">${shortPeriodLabel(p.period)} · cobro ${dateLabel(p.paidAt)} · agregado ${dateTimeLabel(p.createdAt)} · ${methodLabel(p.method)}${p.note&&p.note!=='Importado de la planilla original'?` · ${escapeHTML(p.note)}`:''}</div></div><div class="amount">${money(p.amount)}</div><div class="row-actions"><button class="btn small ghost" data-action="edit-payment" data-id="${p.id}">Editar</button><button class="btn small danger ghost-danger" data-action="delete-payment" data-id="${p.id}">Eliminar</button></div></div>`; }).join('') || '<div class="empty">No hay pagos para este filtro.</div>';
}

function renderPayments() {
  const rows = filteredPayments();
  const total = rows.reduce((s,p)=>s+Number(p.amount||0),0);
  return `
    <div class="toolbar toolbar-balanced">
      <div class="search grow"><input id="payment-search" value="${escapeHTML(state.paymentQuery)}" placeholder="Buscar socio o nota…"></div>
      <select id="payment-period"><option value="all" ${state.paymentPeriod==='all'?'selected':''}>Todos los meses</option>${Array.from({length:15},(_,i)=>addMonths(currentPeriod(),i-10)).reverse().map(p=>`<option value="${p}" ${state.paymentPeriod===p?'selected':''}>${periodLabel(p)}</option>`).join('')}</select>
      <select id="payment-method-filter"><option value="all">Todos los medios</option>${[['cash','Efectivo'],['transfer','Transferencia'],['other','Otro'],['unknown','Sin especificar']].map(([v,l])=>`<option value="${v}" ${state.paymentMethod===v?'selected':''}>${l}</option>`).join('')}</select>
    </div>
    <section class="card panel"><div class="panel-head"><div><div class="panel-title">Pagos registrados</div><div class="panel-subtitle" data-payment-count>${rows.length} movimientos · ordenados por agregado</div></div><div class="amount" data-payment-total>${money(total)}</div></div>
      <div class="list" data-search-results="payments">${renderPaymentRows(rows)}</div>
    </section>`;
}

function filteredProducts() {
  return live(state.data.products)
    .filter(p => state.cantinaProductFilter === 'all' || (state.cantinaProductFilter === 'active' ? p.active !== false : p.active === false))
    .filter(p => !state.cantinaQuery || fuzzyMatch(`${p.name} ${p.emoji}`, state.cantinaQuery))
    .sort((a,b) => Number(b.active !== false) - Number(a.active !== false) || a.name.localeCompare(b.name,'es'));
}

function renderProductCards(products = filteredProducts()) {
  return products.map(p => `<div class="card product-card ${p.active===false?'product-inactive':''}"><div class="product-emoji">${escapeHTML(p.emoji || '🛒')}</div><div class="row-main"><div class="row-title">${escapeHTML(p.name)}</div><div class="row-sub">${p.price>0?money(p.price):'Precio al vender'}${p.active===false?' · Inactivo':''}</div></div><div class="product-actions"><button class="btn small ghost" data-action="edit-product" data-id="${p.id}">Editar</button>${p.active!==false?`<button class="btn cantina-btn small" data-action="sell-product" data-id="${p.id}">Vender</button>`:'<span class="badge inactive product-status-badge">Inactivo</span>'}</div></div>`).join('') || '<div class="empty card full-span">No hay productos para este filtro.</div>';
}

function renderCantina() {
  const products = filteredProducts();
  const month = cantinaSummary(state.data, currentPeriod());
  const top = getProduct(month.topProductId);
  const sales = liveSales(state.data).slice().sort((a,b)=>Date.parse(b.createdAt||b.updatedAt||0)-Date.parse(a.createdAt||a.updatedAt||0)).slice(0,12);
  return `
    <div class="cantina-summary">
      <div class="card cantina-stat"><span>☕</span><div><small>Vendido este mes</small><strong>${money(month.total)}</strong></div></div>
      <div class="card cantina-stat"><span>🧾</span><div><small>Ventas</small><strong>${month.count}</strong></div></div>
      <div class="card cantina-stat"><span>${escapeHTML(top?.emoji || '⭐')}</span><div><small>Más vendido</small><strong>${escapeHTML(top?.name || '—')}</strong></div></div>
    </div>
    <div class="toolbar toolbar-balanced"><div class="search grow"><input id="cantina-search" value="${escapeHTML(state.cantinaQuery)}" placeholder="Buscar producto…"></div><div class="filter-tabs">${[['active','Activos'],['inactive','Inactivos'],['all','Todos']].map(([v,l])=>`<button class="filter-tab ${state.cantinaProductFilter===v?'active':''}" data-product-filter="${v}">${l}</button>`).join('')}</div><button class="btn" data-action="new-product">＋ Producto</button></div>
    <div class="product-grid" data-search-results="cantina">${renderProductCards(products)}</div>
    <section class="card panel cantina-history"><div class="panel-head"><div><div class="panel-title">Últimas ventas</div><div class="panel-subtitle">Ordenadas por cuándo las agregaste</div></div></div><div class="list">${sales.map(s=>{const m=getMember(s.memberId),p=getProduct(s.productId),buyer=m?memberName(m):s.memberId?'Socio no disponible':'Venta sin socio';return `<div class="row-card"><div class="movement-icon sale">${escapeHTML(p?.emoji||s.productEmoji||'☕')}</div><div class="row-main"><div class="row-title">${escapeHTML(buyer)} · ${escapeHTML(p?.name||s.productName||'Producto')}</div><div class="row-sub">${Number(s.quantity||1)} × ${money(s.unitPrice)} · ${dateLabel(s.soldAt)} · agregado ${dateTimeLabel(s.createdAt)}</div></div><div class="amount">${money(s.amount)}</div><button class="btn small ghost" data-action="edit-sale" data-id="${s.id}">Editar</button></div>`}).join('')||'<div class="empty">Todavía no hay ventas.</div>'}</div></section>`;
}

function settingsPanel(id, title, subtitle, icon, body, { danger = false, wide = false } = {}) {
  const open = state.settingsSection === id;
  return `<section class="card settings-card settings-accordion ${danger?'danger-zone':''} ${wide?'settings-wide':''}">
    <button type="button" class="settings-summary" data-settings-toggle="${id}" aria-expanded="${open}">
      <span class="settings-summary-icon">${icon}</span>
      <span class="settings-summary-copy"><strong>${escapeHTML(title)}</strong><small>${escapeHTML(subtitle)}</small></span>
      <span class="settings-chevron">⌄</span>
    </button>
    <div class="settings-body" ${open?'':'hidden'}>${body}</div>
  </section>`;
}

function renderSettings() {
  const imported = state.data.payments.filter(p=>p.source==='xlsx-import').length;
  const driveReady = Boolean(clientId());
  const deviceId = getDeviceId();
  const activity = (state.data.operations || []).slice().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,20);
  const pending = pendingOperationCount();
  const driveButton = state.syncing ? 'Sincronizando…' : state.token ? 'Sincronizar ahora' : state.driveLinked ? 'Renovar acceso a Drive' : 'Conectar Drive';
  const lastSync = state.sync.lastAt ? `Última sincronización correcta: ${syncClock(state.sync.lastAt)}` : 'Todavía no hubo una sincronización correcta en esta sesión.';
  const feeBody = `<p>Los meses anteriores conservan el valor que tenían.</p><form id="fee-form" class="form-grid compact-form"><div class="field"><label>Nueva cuota</label><input name="defaultFee" type="number" min="1" step="1" value="${Number(state.data.settings.defaultFee)}"></div><div class="field"><label>Rige desde</label><input name="effectiveFrom" type="month" value="${currentPeriod()}"></div><div class="field full"><button class="btn primary" type="submit">Guardar cuota</button></div></form>`;
  const driveBody = `<p>Todo se guarda primero en este equipo. Con Drive autorizado, se sincroniza después de cada cambio, cada 30 segundos y al volver a esta pestaña.</p><div class="sync-settings"><div><span class="sync-pill ${state.sync.kind}"><span class="sync-dot"></span>${escapeHTML(state.sync.text)}</span><small>${escapeHTML(state.account.email)}</small><small>${escapeHTML(lastSync)}</small>${state.sync.lastError?`<small class="sync-error-detail">${escapeHTML(state.sync.lastError)}</small>`:''}</div><div class="settings-actions"><button class="btn primary" data-action="sync-drive" ${driveReady&&!state.syncing?'':'disabled'}>${driveButton}</button></div></div>${!driveReady?'<small class="settings-note">Google se configura en .env, no dentro de la aplicación.</small>':''}`;
  const backupBody = `<p>Podés descargar una copia o importar un respaldo de North South.</p><div class="settings-actions"><button class="btn" data-action="export-backup">Descargar respaldo</button><label class="btn ghost" for="backup-file">Importar respaldo</label><input id="backup-file" type="file" accept="application/json,.json" hidden></div>`;
  const accountBody = `<div class="account-card"><div><strong>${escapeHTML(state.account.name || state.account.email)}</strong><small>${escapeHTML(state.account.email)}</small></div><button class="btn ghost" data-action="logout">Cerrar sesión</button></div>`;
  const dataBody = `<div class="detail-grid"><div class="detail-stat"><span>Socios</span><strong>${live(state.data.members).length}</strong></div><div class="detail-stat"><span>Activos</span><strong>${activeMembers(state.data).length}</strong></div><div class="detail-stat"><span>Pagos importados</span><strong>${imported}</strong></div><div class="detail-stat"><span>Ventas cantina</span><strong>${liveSales(state.data).length}</strong></div></div><small class="settings-note">Versión ${APP_VERSION} · almacenamiento local ${state.storageOK?'activo':'con problema'}</small>`;
  const clearBody = `<p>Vacía socios, pagos, cantina y el registro de cambios de esta cuenta, también en Drive. Requiere una confirmación escrita.</p><button class="btn danger" data-action="open-clear-data">Borrar todos los datos</button>`;
  const activityBody = `<div class="activity-head"><span class="badge ${pending?'warn':'ok'}">${pending?`${pending} pendiente${pending===1?'':'s'}`:'Todo sincronizado'}</span></div><p>Cada acción se guarda primero acá y después se copia a Drive como una operación independiente.</p><div class="activity-log">${activity.map(op=>{const synced=state.syncedOperationIds.has(op.id);const own=op.deviceId===deviceId;return `<div class="activity-row"><div class="activity-mark ${synced?'synced':'pending'}"></div><div class="row-main"><div class="row-title">${escapeHTML(op.label)}</div><div class="row-sub">${dateTimeLabel(op.createdAt)} · ${own?'este equipo':'otro equipo'} · ${op.type==='reset'?'borrado total':`${op.changes?.length||0} cambio${op.changes?.length===1?'':'s'}`}</div></div><span class="activity-status ${synced?'synced':'pending'}">${synced?'En Drive':'Local'}</span></div>`}).join('')||'<div class="empty">Todavía no hay cambios registrados en esta versión.</div>'}</div>`;

  return `<div class="settings-grid settings-accordion-grid">
    ${settingsPanel('fee','Cuota mensual',`Cuota actual: ${money(state.data.settings.defaultFee)}`,'$ ',feeBody)}
    ${settingsPanel('drive','Sincronización con Drive',state.sync.text,'↻',driveBody)}
    ${settingsPanel('backup','Datos y respaldo','Descargar o importar una copia','⇅',backupBody)}
    ${settingsPanel('account','Cuenta',state.account.email,'●',accountBody)}
    ${settingsPanel('data','Resumen de datos',`${live(state.data.members).length} socios · ${liveSales(state.data).length} ventas`,'▦',dataBody)}
    ${settingsPanel('activity','Registro de cambios',pending?`${pending} pendiente${pending===1?'':'s'}`:'Todo sincronizado','≡',activityBody,{wide:true})}
    ${settingsPanel('clear','Borrar todos los datos','Zona de riesgo','!',clearBody,{danger:true,wide:true})}
  </div>`;
}

function renderMemberSuggestions(draft) {
  const suggestions = findMembers(state.data, draft.memberQuery || '', { includeInactive:false, limit:7 });
  return suggestions.map(m=>`<button type="button" data-action="pick-member" data-picker="${draft.pickerType}" data-id="${m.id}"><span class="avatar tiny">${initials(memberName(m))}</span><span>${escapeHTML(memberName(m))}</span></button>`).join('') || '<div class="picker-empty">No encontré socios.</div>';
}

function renderMemberPicker(draft, pickerType) {
  const optional = pickerType === 'sale';
  const chosen = getMember(draft.memberId);
  const suggestionDraft = { ...draft, pickerType };
  return `<div class="field full member-picker"><label>Socio${optional?' <span class="muted-inline">(opcional)</span>':''}</label><input id="${pickerType}-member-search" data-member-picker="${pickerType}" value="${escapeHTML(draft.memberQuery || (chosen?memberName(chosen):''))}" placeholder="${optional?'Dejá vacío para venta sin socio':'Escribí el nombre…'}" autocomplete="off" ${optional?'':'required'}><input type="hidden" name="memberId" value="${escapeHTML(draft.memberId || '')}"><div class="picker-results ${draft.memberPickerOpen?'open':''}">${renderMemberSuggestions(suggestionDraft)}</div></div>`;
}

function paymentDue(member, period, months, editingId = null) {
  let total = 0;
  const rows = [];
  for (let i=0;i<months;i++) {
    const p = addMonths(period,i);
    const fee = memberFee(state.data,member,p);
    const paid = livePayments(state.data).filter(x=>x.id!==editingId&&x.memberId===member.id&&x.period===p).reduce((s,x)=>s+Number(x.amount||0),0);
    const remaining = Math.max(0,fee-paid);
    rows.push({period:p,fee,paid,remaining}); total += remaining;
  }
  return { total, rows };
}

function renderPaymentModal(modal) {
  const d=modal.draft, member=getMember(d.memberId), editing=modal.id?state.data.payments.find(p=>p.id===modal.id):null;
  const months = editing ? 1 : Number(d.months || 1);
  const due = member && d.period ? paymentDue(member,d.period,months,modal.id) : {total:0,rows:[]};
  const entered = Number(d.amount || 0);
  const after = Math.max(0,due.total-entered);
  const advance = !editing && months === 1 ? Math.max(0, entered - due.total) : 0;
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal" data-modal-stop data-scroll-key="modal"><div class="modal-head"><div><div class="modal-title">${editing?'Editar pago':'Registrar pago'}</div><div class="panel-subtitle">Elegí al socio y la app completa el resto.</div></div><button class="close-btn" data-action="close-modal">×</button></div>
    <form id="payment-form"><div class="modal-body">${modal.errors?.length?`<div class="form-errors">${modal.errors.map(escapeHTML).join('<br>')}</div>`:''}<div class="form-grid">
      ${renderMemberPicker(d,'payment')}
      <div class="field"><label>Mes inicial</label><input name="period" data-payment-live type="month" value="${escapeHTML(d.period)}" required></div>
      ${!editing?`<div class="field"><label>Meses que paga</label><select name="months" data-payment-live>${[1,2,3,6].map(n=>`<option value="${n}" ${months===n?'selected':''}>${n}</option>`).join('')}</select></div>`:'<input type="hidden" name="months" value="1">'}
      <div class="field"><label>Fecha de cobro</label><input name="paidAt" type="date" value="${escapeHTML(d.paidAt)}" required></div>
      <div class="field"><label>Monto</label><input id="payment-amount" name="amount" type="number" min="1" step="1" value="${escapeHTML(String(d.amount ?? due.total ?? 0))}" ${months>1?'readonly':''} required><small>${months>1?'Se calcula sumando los meses seleccionados.':'Puede ser parcial; si supera el mes, el excedente pasa a los siguientes.'}</small></div>
      <div class="field full"><label>Medio de pago</label><input type="hidden" name="method" value="${escapeHTML(d.method)}"><div class="segment">${[['cash','Efectivo'],['transfer','Transferencia'],['other','Otro']].map(([v,l])=>`<button type="button" class="${d.method===v?'active':''}" data-payment-method="${v}">${l}</button>`).join('')}</div></div>
      <div class="field full"><label>Nota <span class="muted-inline">(opcional)</span></label><input name="note" value="${escapeHTML(d.note||'')}" placeholder="Detalle del pago"></div>
    </div>${member?`<div class="payment-preview"><div><span>${months>1?'Total de los meses':'Pendiente del mes'}</span><strong>${money(due.total)}</strong></div><div><span data-payment-result-label>${advance>0?'Adelanto a meses siguientes':'Después de este pago'}</span><strong data-payment-result-value class="${after===0?'good-text':'warn-text'}">${advance>0?money(advance):after===0?'Queda pago':`Queda ${money(after)}`}</strong></div></div>`:''}</div>
    <div class="modal-foot">${editing?`<button type="button" class="btn danger" data-action="delete-payment" data-id="${editing.id}">${editing.batchId?'Eliminar pago completo':'Eliminar pago'}</button>`:''}<span class="foot-spacer"></span><button type="button" class="btn ghost" data-action="close-modal">Cancelar</button><button type="button" class="btn primary" data-action="save-payment" ${!member||entered<=0?'disabled':''}>Guardar pago</button></div></form>
  </div></div>`;
}

function renderMemberModal(modal) {
  const d=modal.draft;
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal" data-modal-stop data-scroll-key="modal"><div class="modal-head"><div><div class="modal-title">${modal.id?'Editar socio':'Nuevo socio'}</div><div class="panel-subtitle">La cuota general se completa automáticamente.</div></div><button class="close-btn" data-action="close-modal">×</button></div>
    <form id="member-form"><div class="modal-body">${modal.errors?.length?`<div class="form-errors">${modal.errors.map(escapeHTML).join('<br>')}</div>`:''}<div class="form-grid">
      <div class="field"><label>Nombre</label><input name="firstName" value="${escapeHTML(d.firstName||'')}" required></div><div class="field"><label>Apellido / apodo</label><input name="lastName" value="${escapeHTML(d.lastName||'')}"></div>
      <div class="field"><label>Tipo de cuota</label><select name="feeMode" data-member-fee-mode><option value="default" ${d.feeMode!=='custom'?'selected':''}>Cuota general (${money(memberFee(state.data,{...d,feeMode:'default'},currentPeriod()))})</option><option value="custom" ${d.feeMode==='custom'?'selected':''}>Cuota especial</option></select></div>
      <div class="field"><label>Cuota especial</label><input name="monthlyFee" type="number" min="1" step="1" value="${Number(d.monthlyFee||state.data.settings.defaultFee)}" ${d.feeMode==='custom'?'':'disabled'}></div>
      <div class="field"><label>Estado</label><select name="status"><option value="active" ${d.status!=='inactive'?'selected':''}>Activo</option><option value="inactive" ${d.status==='inactive'?'selected':''}>Inactivo</option></select></div><div class="field"><label>Teléfono</label><input name="phone" inputmode="tel" value="${escapeHTML(d.phone||'')}"></div>
      <div class="field"><label>Mutualista</label><input name="medicalProvider" value="${escapeHTML(d.medicalProvider||'')}"></div><div class="field"><label>Fecha de nacimiento</label><input name="birthDate" type="date" value="${escapeHTML(d.birthDate||'')}"></div>
      <div class="field"><label>Fecha de ingreso</label><input name="joinedAt" type="date" value="${escapeHTML(d.joinedAt||'')}"></div><div class="field full"><label>Notas</label><textarea name="notes">${escapeHTML(d.notes||'')}</textarea></div>
    </div></div><div class="modal-foot"><span class="foot-spacer"></span><button type="button" class="btn ghost" data-action="close-modal">Cancelar</button><button class="btn primary" type="button" data-action="save-member">Guardar socio</button></div></form>
  </div></div>`;
}

function renderMemberDetail(modal) {
  const m=getMember(modal.id); if(!m)return'';
  const history=livePayments(state.data).filter(p=>p.memberId===m.id).sort((a,b)=>Date.parse(b.createdAt||b.updatedAt||0)-Date.parse(a.createdAt||a.updatedAt||0)).slice(0,8);
  const periods=Array.from({length:6},(_,i)=>addMonths(currentPeriod(),i-1));
  const badge=memberStatusLabel(m);
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal wide" data-modal-stop data-scroll-key="modal"><div class="modal-head"><div class="modal-title">Ficha del socio</div><button class="close-btn" data-action="close-modal">×</button></div><div class="modal-body">
    <div class="detail-hero"><div class="avatar">${initials(memberName(m))}</div><div class="row-main"><div class="detail-title">${escapeHTML(memberName(m))}</div><div class="row-sub"><span class="badge ${badge.cls}">${badge.text}</span>${m.phone?` · ${escapeHTML(m.phone)}`:''}</div></div><div class="detail-actions"><button class="btn" data-action="edit-member" data-id="${m.id}">Editar</button>${m.status==='active'?`<button class="btn primary" data-action="pay-member" data-id="${m.id}">Cobrar</button>`:''}</div></div>
    <div class="mini-months">${periods.map(p=>{const s=memberPeriodStatus(state.data,m,p);return `<button class="mini-month ${s.isPaid?'paid':p>currentPeriod()?'future':'due'}" ${!s.isPaid?`data-action="pay-member-period" data-id="${m.id}" data-period="${p}"`:''}><span>${shortPeriodLabel(p)}</span><strong>${s.isPaid?'✓ Pago':s.notStarted?'—':s.paid>0?`Falta ${money(s.remaining)}`:`${money(s.remaining)}`}</strong></button>`}).join('')}</div>
    <div class="detail-grid"><div class="detail-stat"><span>Cuota actual</span><strong>${money(memberFee(state.data,m,currentPeriod()))}</strong></div><div class="detail-stat"><span>Ingreso</span><strong>${m.joinedAt?dateLabel(m.joinedAt):'Sin dato'}</strong></div><div class="detail-stat"><span>Nacimiento</span><strong>${m.birthDate?dateLabel(m.birthDate):'Sin dato'}</strong></div><div class="detail-stat"><span>Mutualista</span><strong>${escapeHTML(m.medicalProvider||'Sin dato')}</strong></div></div>
    ${m.notes?`<div class="note-box">${escapeHTML(m.notes)}</div>`:''}<div class="panel-head"><div><div class="panel-title">Últimos pagos agregados</div></div></div><div class="list">${history.map(p=>`<div class="row-card"><div class="row-main"><div class="row-title">${shortPeriodLabel(p.period)}</div><div class="row-sub">Cobro ${dateLabel(p.paidAt)} · agregado ${dateTimeLabel(p.createdAt)}</div></div><div class="amount">${money(p.amount)}</div><div class="row-actions"><button class="btn small ghost" data-action="edit-payment" data-id="${p.id}">Editar</button><button class="btn small danger ghost-danger" data-action="delete-payment" data-id="${p.id}">Eliminar</button></div></div>`).join('')||'<div class="empty">Todavía no tiene pagos.</div>'}</div>
  </div></div></div>`;
}

function renderSaleModal(modal) {
  const d=modal.draft, member=getMember(d.memberId), product=getProduct(d.productId), editing=modal.id?state.data.sales.find(s=>s.id===modal.id):null;
  const total=Number(d.quantity||1)*Number(d.unitPrice||0);
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal" data-modal-stop data-scroll-key="modal"><div class="modal-head"><div><div class="modal-title">${editing?'Editar venta':'Venta cantina'}</div><div class="panel-subtitle">Producto y cantidad; el socio es opcional.</div></div><button class="close-btn" data-action="close-modal">×</button></div><form id="sale-form"><div class="modal-body">${modal.errors?.length?`<div class="form-errors">${modal.errors.map(escapeHTML).join('<br>')}</div>`:''}<div class="form-grid">
    ${renderMemberPicker(d,'sale')}
    <div class="field full"><label>Producto</label><input type="hidden" name="productId" value="${escapeHTML(d.productId||'')}"><div class="product-picker">${activeProducts(state.data).map(p=>`<button type="button" class="${d.productId===p.id?'active':''}" data-action="pick-product" data-id="${p.id}"><span>${escapeHTML(p.emoji||'🛒')}</span><b>${escapeHTML(p.name)}</b></button>`).join('')}</div></div>
    <div class="field"><label>Cantidad</label><input id="sale-quantity" name="quantity" type="number" min="1" step="1" value="${Number(d.quantity||1)}" required></div><div class="field"><label>Precio por unidad</label><input id="sale-unit-price" name="unitPrice" type="number" min="1" step="1" value="${Number(d.unitPrice||product?.price||0)}" required></div>
    <div class="field"><label>Fecha</label><input name="soldAt" type="date" value="${escapeHTML(d.soldAt)}" required></div><div class="field"><label>Total</label><div class="readout" data-sale-total>${money(total)}</div></div>
    <div class="field full"><label>Medio de pago</label><input type="hidden" name="method" value="${escapeHTML(d.method)}"><div class="segment">${[['cash','Efectivo'],['transfer','Transferencia'],['other','Otro']].map(([v,l])=>`<button type="button" class="${d.method===v?'active':''}" data-sale-method="${v}">${l}</button>`).join('')}</div></div>
    <div class="field full"><label>Nota <span class="muted-inline">(opcional)</span></label><input name="note" value="${escapeHTML(d.note||'')}"></div>
  </div></div><div class="modal-foot">${editing?`<button type="button" class="btn danger" data-action="delete-sale" data-id="${editing.id}">Eliminar</button>`:''}<span class="foot-spacer"></span><button type="button" class="btn ghost" data-action="close-modal">Cancelar</button><button class="btn cantina-btn" type="button" data-action="save-sale" ${!product||total<=0?'disabled':''}>Guardar venta</button></div></form></div></div>`;
}

function renderProductModal(modal) {
  const d=modal.draft;
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal small-modal" data-modal-stop data-scroll-key="modal"><div class="modal-head"><div><div class="modal-title">${modal.id?'Editar producto':'Nuevo producto'}</div><div class="panel-subtitle">El emoji aparece en los accesos de cantina.</div></div><button class="close-btn" data-action="close-modal">×</button></div><form id="product-form"><div class="modal-body">${modal.errors?.length?`<div class="form-errors">${modal.errors.map(escapeHTML).join('<br>')}</div>`:''}<div class="form-grid"><div class="field"><label>Emoji</label><input name="emoji" class="emoji-input" value="${escapeHTML(d.emoji||'🛒')}" maxlength="8"></div><div class="field"><label>Producto</label><input name="name" value="${escapeHTML(d.name||'')}" required></div><div class="field"><label>Precio habitual</label><input name="price" type="number" min="0" step="1" value="${Number(d.price||0)}"><small>Si lo dejás en 0, se ingresa al vender.</small></div><div class="field"><label>Estado</label><select name="active"><option value="active" ${d.active!==false?'selected':''}>Activo</option><option value="inactive" ${d.active===false?'selected':''}>Inactivo</option></select></div></div></div><div class="modal-foot">${modal.id?`<button type="button" class="btn danger" data-action="delete-product" data-id="${modal.id}">Eliminar</button>`:''}<span class="foot-spacer"></span><button type="button" class="btn ghost" data-action="close-modal">Cancelar</button><button class="btn cantina-btn" type="button" data-action="save-product">Guardar producto</button></div></form></div></div>`;
}


function renderClearDataModal(modal) {
  const typed = String(modal.draft?.phrase || '');
  const ready = typed === CLEAR_PHRASE;
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal small-modal" data-modal-stop data-scroll-key="modal"><div class="modal-head"><div><div class="modal-title">Borrar todos los datos</div><div class="panel-subtitle">Esta acción afecta esta cuenta y su copia de Drive.</div></div><button class="close-btn" data-action="close-modal">×</button></div><div class="modal-body">${modal.errors?.length?`<div class="form-errors">${modal.errors.map(escapeHTML).join('<br>')}</div>`:''}<div class="danger-confirm"><p>Para habilitar el borrado escribí exactamente:</p><code>${CLEAR_PHRASE}</code><div class="field"><label>Confirmación</label><input id="clear-data-phrase" value="${escapeHTML(typed)}" autocomplete="off" spellcheck="false"></div></div></div><div class="modal-foot"><button type="button" class="btn ghost" data-action="close-modal">Cancelar</button><button type="button" class="btn danger" data-action="confirm-clear-data" ${ready?'':'disabled'}>Borrar definitivamente</button></div></div></div>`;
}

function renderModal() {
  if(!state.modal)return'';
  if(state.modal.type==='payment')return renderPaymentModal(state.modal);
  if(state.modal.type==='member')return renderMemberModal(state.modal);
  if(state.modal.type==='member-detail')return renderMemberDetail(state.modal);
  if(state.modal.type==='sale')return renderSaleModal(state.modal);
  if(state.modal.type==='product')return renderProductModal(state.modal);
  if(state.modal.type==='clear-data')return renderClearDataModal(state.modal);
  return'';
}

function captureScrollState() {
  const containers = {};
  document.querySelectorAll('[data-scroll-key]').forEach(el => {
    containers[el.dataset.scrollKey] = { top: el.scrollTop, left: el.scrollLeft };
  });
  const active = document.activeElement?.id ? {
    id: document.activeElement.id,
    start: document.activeElement.selectionStart,
    end: document.activeElement.selectionEnd
  } : null;
  return { windowY: window.scrollY, containers, active };
}

function restoreScrollState(snapshot) {
  window.scrollTo(0, snapshot?.windowY || 0);
  Object.entries(snapshot?.containers || {}).forEach(([key, pos]) => {
    const el = document.querySelector(`[data-scroll-key="${CSS.escape(key)}"]`);
    if (el) { el.scrollTop = pos.top || 0; el.scrollLeft = pos.left || 0; }
  });
  if (snapshot?.active?.id) {
    const el = document.getElementById(snapshot.active.id);
    if (el) {
      el.focus({ preventScroll:true });
      try { if (snapshot.active.start != null && el.setSelectionRange) el.setSelectionRange(snapshot.active.start, snapshot.active.end ?? snapshot.active.start); } catch {}
    }
  }
}

function render({ preserveScroll = true } = {}) {
  const activeSearch = document.activeElement?.matches?.('#member-search, #payment-search, #fee-search, #cantina-search, [data-member-picker]');
  if (preserveScroll && activeSearch) return;
  const scrollState = preserveScroll ? captureScrollState() : { windowY:0, containers:{} };
  if (!state.account || !state.data) { app.innerHTML = renderLogin(); return; }
  if (state.view === 'fees' && compactViewport()) state.view = 'payments';
  const content = state.view==='dashboard'?renderDashboard():state.view==='members'?renderMembers():state.view==='fees'?renderFees():state.view==='payments'?renderPayments():state.view==='cantina'?renderCantina():renderSettings();
  app.innerHTML=shell(content);
  requestAnimationFrame(() => restoreScrollState(scrollState));
}

function openPayment(memberId='', payment=null, forcedPeriod='') {
  const member=memberId?getMember(memberId):payment?getMember(payment.memberId):null;
  const period=payment?.period||forcedPeriod||(member?firstUnpaidPeriod(state.data,member,currentPeriod()):currentPeriod());
  const status=member?memberPeriodStatus(state.data,member,period):null;
  state.modal={type:'payment',id:payment?.id||null,errors:[],draft:{memberId:payment?.memberId||memberId||'',memberQuery:member?memberName(member):'',memberPickerOpen:false,period,months:1,amount:String(payment?.amount ?? status?.remaining ?? ''),method:payment?.method||state.data.settings.lastPaymentMethod||'cash',paidAt:payment?.paidAt?String(payment.paidAt).slice(0,10):todayISO(),note:payment?.note&&payment.note!=='Importado de la planilla original'?payment.note:''}};
  render();
}

function openMember(member=null) {
  state.modal={type:'member',id:member?.id||null,errors:[],draft:member?structuredClone(member):{firstName:'',lastName:'',feeMode:'default',monthlyFee:state.data.settings.defaultFee,status:'active',phone:'',medicalProvider:'',birthDate:'',joinedAt:todayISO(),notes:''}};
  render();
}

function openSale(productId='', sale=null) {
  const product=productId?getProduct(productId):sale?getProduct(sale.productId):null;
  const member=sale?getMember(sale.memberId):null;
  state.modal={type:'sale',id:sale?.id||null,errors:[],draft:{memberId:sale?.memberId||'',memberQuery:member?memberName(member):'',memberPickerOpen:false,productId:sale?.productId||productId||'',quantity:Number(sale?.quantity||1),unitPrice:Number(sale?.unitPrice||product?.price||0),soldAt:sale?.soldAt?String(sale.soldAt).slice(0,10):todayISO(),method:sale?.method||state.data.settings.lastSaleMethod||'cash',note:sale?.note||''}};
  render();
}

function openProduct(product=null) {
  state.modal={type:'product',id:product?.id||null,errors:[],draft:product?structuredClone(product):{emoji:'🛒',name:'',price:0,active:true}};
  render();
}

function updateVisibleSearch(kind) {
  const target = document.querySelector(`[data-search-results="${kind}"]`);
  if (!target) return;
  if (kind === 'members') target.innerHTML = renderMemberCards();
  if (kind === 'fees') {
    const periods = Array.from({length:7}, (_,i) => addMonths(state.feeWindowStart, i));
    target.innerHTML = renderFeeRows(periods);
  }
  if (kind === 'payments') {
    const rows = filteredPayments();
    target.innerHTML = renderPaymentRows(rows);
    const count = document.querySelector('[data-payment-count]');
    const total = document.querySelector('[data-payment-total]');
    if (count) count.textContent = `${rows.length} movimientos · ordenados por agregado`;
    if (total) total.textContent = money(rows.reduce((sum,row)=>sum+Number(row.amount||0),0));
  }
  if (kind === 'cantina') target.innerHTML = renderProductCards();
}

function updateMemberPicker(pickerType) {
  if (!state.modal?.draft) return;
  const input = document.getElementById(`${pickerType}-member-search`);
  const wrapper = input?.closest('.member-picker');
  const hidden = wrapper?.querySelector('input[type="hidden"][name="memberId"]');
  const results = wrapper?.querySelector('.picker-results');
  if (hidden) hidden.value = '';
  if (results) {
    results.innerHTML = renderMemberSuggestions({ ...state.modal.draft, pickerType });
    results.classList.add('open');
  }
}

function refreshPaymentAuto({resetAmount=true}={}) {
  if(state.modal?.type!=='payment')return;
  const d=state.modal.draft, member=getMember(d.memberId); if(!member)return;
  const months=state.modal.id?1:Number(d.months||1);
  const due=paymentDue(member,d.period,months,state.modal.id);
  if(resetAmount || months>1) d.amount=String(due.total);
}

app.addEventListener('click', async event => {
  if(event.target.matches('[data-modal-backdrop]')){const restore=state.modal?.type==='member-detail'?state.memberListScrollY:null;state.modal=null;render();if(restore!=null)requestAnimationFrame(()=>window.scrollTo(0,restore));return;}
  const viewEl=event.target.closest('[data-view]'); if(viewEl){navigate(viewEl.dataset.view);return;}
  const settingsToggle=event.target.closest('[data-settings-toggle]');
  if(settingsToggle){const section=settingsToggle.dataset.settingsToggle;state.settingsSection=state.settingsSection===section?null:section;render();return;}
  const actionEl=event.target.closest('[data-action]'); if(!actionEl)return;
  const action=actionEl.dataset.action,id=actionEl.dataset.id;
  if(action==='login-google'){await loginWithGoogle();return;}
  if(action==='logout'){await logout();return;}
  if(action==='save-payment'){event.preventDefault();document.querySelector('#payment-form')?.requestSubmit();return;}
  if(action==='save-member'){event.preventDefault();document.querySelector('#member-form')?.requestSubmit();return;}
  if(action==='save-sale'){event.preventDefault();document.querySelector('#sale-form')?.requestSubmit();return;}
  if(action==='save-product'){event.preventDefault();document.querySelector('#product-form')?.requestSubmit();return;}
  if(action==='close-modal'){const restore=state.modal?.type==='member-detail'?state.memberListScrollY:null;state.modal=null;render();if(restore!=null)requestAnimationFrame(()=>window.scrollTo(0,restore));return;}
  if(action==='new-payment'){openPayment();return;}
  if(action==='pay-member'){openPayment(id);return;}
  if(action==='pay-member-period'){openPayment(id,null,actionEl.dataset.period);return;}
  if(action==='new-member'){openMember();return;}
  if(action==='member-detail'){state.memberListScrollY=window.scrollY;state.modal={type:'member-detail',id};render();return;}
  if(action==='edit-member'){openMember(getMember(id));return;}
  if(action==='edit-payment'){const p=livePayments(state.data).find(x=>x.id===id);if(p)openPayment('',p);return;}
  if(action==='delete-payment'){const p=state.data.payments.find(x=>x.id===id);if(p){const batch=p.batchId?livePayments(state.data).filter(x=>x.batchId===p.batchId):[p];const text=batch.length>1?`¿Eliminar el pago completo? Se quitarán ${batch.length} movimientos distribuidos entre meses.`:'¿Eliminar este pago?';if(confirm(text)){const timestamp=nowISO();batch.forEach(row=>{row.deletedAt=timestamp;row.updatedAt=timestamp;});state.modal=null;persist(batch.length>1?'Pago completo eliminado.':'Pago eliminado.');}}return;}
  if(action==='new-sale'){openSale();return;}
  if(action==='sell-product'){openSale(id);return;}
  if(action==='edit-sale'){const s=liveSales(state.data).find(x=>x.id===id);if(s)openSale('',s);return;}
  if(action==='delete-sale'){const s=state.data.sales.find(x=>x.id===id);if(s&&confirm('¿Eliminar esta venta?')){s.deletedAt=nowISO();s.updatedAt=nowISO();state.modal=null;persist('Venta eliminada.');}return;}
  if(action==='new-product'){openProduct();return;}
  if(action==='edit-product'){openProduct(getProduct(id));return;}
  if(action==='delete-product'){const p=state.data.products.find(x=>x.id===id);if(p&&confirm(`¿Eliminar ${p.name}?`)){const timestamp=nowISO();state.data.sales.filter(s=>s.productId===p.id&&!s.deletedAt).forEach(s=>{if(!s.productName)s.productName=p.name;if(!s.productEmoji)s.productEmoji=p.emoji||'🛒';s.updatedAt=timestamp;});p.deletedAt=timestamp;p.updatedAt=timestamp;state.modal=null;persist('Producto eliminado.');}return;}
  if(action==='pick-member'&&state.modal){const m=getMember(id);if(!m)return;state.modal.draft.memberId=id;state.modal.draft.memberQuery=memberName(m);state.modal.draft.memberPickerOpen=false;if(state.modal.type==='payment'){state.modal.draft.period=firstUnpaidPeriod(state.data,m,state.modal.draft.period||currentPeriod());refreshPaymentAuto();}render();return;}
  if(action==='pick-product'&&state.modal?.type==='sale'){const p=getProduct(id);state.modal.draft.productId=id;state.modal.draft.unitPrice=Number(p?.price||0);render();return;}
  if(action==='fees-prev'){state.feeWindowStart=addMonths(state.feeWindowStart,-3);render();return;}
  if(action==='fees-next'){state.feeWindowStart=addMonths(state.feeWindowStart,3);render();return;}
  if(action==='fees-today'){state.feeWindowStart=addMonths(currentPeriod(),-1);render();return;}
  if(action==='sync-drive'){await syncNow(true);return;}
  if(action==='disconnect-drive'){await disconnectGoogle();setDriveLinked(false);state.token=null;state.sync={kind:'local',text:'Guardado local · Drive sin conectar',lastAt:state.sync.lastAt,lastError:''};render();return;}
  if(action==='export-backup'){exportBackup(state.data,state.account?.email);toast('Respaldo descargado.');return;}
  if(action==='open-clear-data'){state.modal={type:'clear-data',errors:[],draft:{phrase:''}};render();return;}
  if(action==='confirm-clear-data'){
    if(state.modal?.type!=='clear-data'||state.modal.draft.phrase!==CLEAR_PHRASE)return;
    try {
      const timestamp=nowISO(), datasetId=`north-south-academy-main:${crypto.randomUUID()}`;
      const reset=emptyData(datasetId);
      const marker=makeResetMarker(datasetId,{createdAt:timestamp,deviceId:getDeviceId()});
      reset.meta.reset=marker;
      reset.meta.generationCreatedAt=timestamp;
      reset.operations=[createResetOperation(reset,{createdAt:timestamp,deviceId:getDeviceId()})];
      state.data=overwriteData(state.account.email,reset,{markDirty:true});
      state.syncedOperationIds=new Set();
      state.modal=null;state.view='dashboard';
      state.sync=!navigator.onLine
        ? {kind:'offline',text:'Datos borrados · Drive pendiente',lastAt:state.sync.lastAt}
        : state.token
          ? {kind:'pending',text:'Datos borrados · sincronización pendiente',lastAt:state.sync.lastAt}
          : state.driveLinked
            ? {kind:'auth',text:'Datos borrados · Drive requiere autorización',lastAt:state.sync.lastAt}
            : {kind:'local',text:'Datos borrados · Drive sin conectar',lastAt:state.sync.lastAt};
      render({preserveScroll:false});
      toast(state.token&&navigator.onLine?'Todos los datos fueron borrados. Drive se actualizará ahora.':'Todos los datos fueron borrados en este equipo. Se aplicará a Drive al reconectar.');
      scheduleSync();
    } catch(e){console.error(e);state.modal.errors=[e.message||'No se pudieron borrar los datos.'];render();}
    return;
  }
});

app.addEventListener('click', event => {
  const method=event.target.closest('[data-payment-method]'); if(method&&state.modal?.type==='payment'){state.modal.draft.method=method.dataset.paymentMethod;render();return;}
  const saleMethod=event.target.closest('[data-sale-method]'); if(saleMethod&&state.modal?.type==='sale'){state.modal.draft.method=saleMethod.dataset.saleMethod;render();return;}
  const filter=event.target.closest('[data-member-filter]'); if(filter){state.memberFilter=filter.dataset.memberFilter;render();return;}
  const productFilter=event.target.closest('[data-product-filter]'); if(productFilter){state.cantinaProductFilter=productFilter.dataset.productFilter;render();}
});

app.addEventListener('input', event => {
  const id=event.target.id;
  if(id==='member-search'){state.memberQuery=event.target.value;updateVisibleSearch('members');return;}
  if(id==='payment-search'){state.paymentQuery=event.target.value;updateVisibleSearch('payments');return;}
  if(id==='fee-search'){state.feeQuery=event.target.value;updateVisibleSearch('fees');return;}
  if(id==='cantina-search'){state.cantinaQuery=event.target.value;updateVisibleSearch('cantina');return;}
  if(event.target.dataset.memberPicker&&state.modal){const pickerType=event.target.dataset.memberPicker;state.modal.draft.memberQuery=event.target.value;state.modal.draft.memberId='';state.modal.draft.memberPickerOpen=true;updateMemberPicker(pickerType);return;}
  if(id==='payment-amount'&&state.modal?.type==='payment'){
    state.modal.draft.amount=event.target.value;
    const entered=Number(event.target.value||0),member=getMember(state.modal.draft.memberId),months=state.modal.id?1:Number(state.modal.draft.months||1);
    const due=member?paymentDue(member,state.modal.draft.period,months,state.modal.id):{total:0};
    const advance=!state.modal.id&&months===1?Math.max(0,entered-due.total):0,after=Math.max(0,due.total-entered);
    const label=document.querySelector('[data-payment-result-label]'),value=document.querySelector('[data-payment-result-value]'),save=document.querySelector('[data-action="save-payment"]');
    if(label)label.textContent=advance>0?'Adelanto a meses siguientes':'Después de este pago';
    if(value){value.textContent=advance>0?money(advance):after===0?'Queda pago':`Queda ${money(after)}`;value.className=after===0?'good-text':'warn-text';}
    if(save)save.disabled=!member||entered<=0;
    return;
  }
  if(id==='sale-quantity'&&state.modal?.type==='sale'){state.modal.draft.quantity=Number(event.target.value||1);const total=Number(state.modal.draft.quantity||1)*Number(state.modal.draft.unitPrice||0),out=document.querySelector('[data-sale-total]'),save=document.querySelector('[data-action="save-sale"]');if(out)out.textContent=money(total);if(save)save.disabled=!getProduct(state.modal.draft.productId)||total<=0;return;}
  if(id==='sale-unit-price'&&state.modal?.type==='sale'){state.modal.draft.unitPrice=Number(event.target.value||0);const total=Number(state.modal.draft.quantity||1)*Number(state.modal.draft.unitPrice||0),out=document.querySelector('[data-sale-total]'),save=document.querySelector('[data-action="save-sale"]');if(out)out.textContent=money(total);if(save)save.disabled=!getProduct(state.modal.draft.productId)||total<=0;return;}
  if(id==='clear-data-phrase'&&state.modal?.type==='clear-data'){state.modal.draft.phrase=event.target.value;const btn=document.querySelector('[data-action="confirm-clear-data"]');if(btn)btn.disabled=event.target.value!==CLEAR_PHRASE;return;}
});

app.addEventListener('change', async event => {
  if(event.target.matches('[data-payment-live]')&&state.modal?.type==='payment'){state.modal.draft[event.target.name]=event.target.name==='months'?Number(event.target.value):event.target.value;refreshPaymentAuto();render();return;}
  if(event.target.matches('[data-member-fee-mode]')&&state.modal?.type==='member'){
    const form=document.querySelector('#member-form');
    if(form){
      const fd=new FormData(form);
      Object.assign(state.modal.draft,{
        firstName:String(fd.get('firstName')||''), lastName:String(fd.get('lastName')||''), feeMode:event.target.value,
        monthlyFee:Number(fd.get('monthlyFee')||state.modal.draft.monthlyFee||state.data.settings.defaultFee),
        status:String(fd.get('status')||'active'), phone:String(fd.get('phone')||''), medicalProvider:String(fd.get('medicalProvider')||''),
        birthDate:String(fd.get('birthDate')||''), joinedAt:String(fd.get('joinedAt')||''), notes:String(fd.get('notes')||'')
      });
    } else state.modal.draft.feeMode=event.target.value;
    render();return;
  }
  if(event.target.id==='payment-period'){state.paymentPeriod=event.target.value;render();return;}
  if(event.target.id==='payment-method-filter'){state.paymentMethod=event.target.value;render();return;}
  if(event.target.id==='backup-file'&&event.target.files?.[0]){if(!confirm('¿Importar estos datos en la cuenta actual?')){event.target.value='';return;}try{state.data=await importBackup(event.target.files[0],state.account?.email,{save:false,targetDatasetId:state.data.datasetId});persist('Respaldo importado.');}catch(e){toast(e.message||'No se pudo importar.','error');}return;}
});

app.addEventListener('submit', event => {
  event.preventDefault();
  if(event.target.id==='payment-form'){
    const fd=new FormData(event.target),months=state.modal.id?1:Number(fd.get('months')||1),amountRaw=String(fd.get('amount')||'');
    const baseDraft={memberId:String(fd.get('memberId')||''),period:String(fd.get('period')||''),paidAt:String(fd.get('paidAt')||''),amount:Number(amountRaw),method:String(fd.get('method')||'cash'),note:String(fd.get('note')||'').trim()};
    const member=getMember(baseDraft.memberId); let errors=validatePayment(state.data,baseDraft,state.modal.id),allocation=null;
    if(!errors.length&&state.modal.id){
      const editableDue=paymentDue(member,baseDraft.period,1,state.modal.id).total;
      if(baseDraft.amount>editableDue) errors.push(`Para editar este movimiento el máximo es ${money(editableDue)}. Los adelantos se distribuyen al registrar un pago nuevo.`);
    } else if(!errors.length&&months===1){
      allocation=allocatePaymentAmount(state.data,member,baseDraft.period,baseDraft.amount);
      if(!allocation.rows.length) errors.push('No encontré una cuota pendiente desde ese mes.');
      else if(allocation.remainder>0) errors.push('El monto es demasiado grande para distribuirlo entre los meses siguientes.');
    } else if(!errors.length&&months>1){
      const due=paymentDue(member,baseDraft.period,months,null);
      if(due.total<=0) errors.push('Esos meses ya están pagos.');
    }
    if(errors.length){state.modal.draft={...state.modal.draft,...baseDraft,amount:amountRaw,months};state.modal.errors=errors;render();return;}
    const timestamp=nowISO(),paidAt=`${baseDraft.paidAt}T12:00:00`;
    let distributedCount=1;
    if(state.modal.id){
      const p=state.data.payments.find(x=>x.id===state.modal.id);Object.assign(p,baseDraft,{paidAt,updatedAt:timestamp});
    } else if(months===1){
      const rows=allocation?.rows||[]; distributedCount=rows.length;
      const batchId=rows.length>1?uid('batch'):null;
      rows.forEach(row=>state.data.payments.push({id:uid('p'),memberId:baseDraft.memberId,period:row.period,amount:row.amount,method:baseDraft.method,paidAt,note:baseDraft.note,...(batchId?{batchId}:{}),createdAt:timestamp,updatedAt:timestamp,deletedAt:null,source:'app'}));
    } else {
      const batchId=uid('batch'); const due=paymentDue(member,baseDraft.period,months,null);
      due.rows.filter(x=>x.remaining>0).forEach(x=>state.data.payments.push({id:uid('p'),memberId:baseDraft.memberId,period:x.period,amount:x.remaining,method:baseDraft.method,paidAt,note:baseDraft.note,batchId,createdAt:timestamp,updatedAt:timestamp,deletedAt:null,source:'app'}));
    }
    state.data.settings.lastPaymentMethod=baseDraft.method;state.data.settings.updatedAt=timestamp;state.modal=null;
    persist(months>1?'Meses cobrados y guardados.':distributedCount>1?'Pago guardado y excedente aplicado a los meses siguientes.':'Pago guardado.');return;
  }
  if(event.target.id==='member-form'){
    const fd=new FormData(event.target),feeMode=String(fd.get('feeMode')||'default');
    const draft={firstName:normalizeText(fd.get('firstName')),lastName:normalizeText(fd.get('lastName')),feeMode,monthlyFee:feeMode==='custom'?Number(fd.get('monthlyFee')):Number(state.data.settings.defaultFee),status:String(fd.get('status')||'active'),phone:String(fd.get('phone')||'').trim(),medicalProvider:String(fd.get('medicalProvider')||'').trim(),birthDate:String(fd.get('birthDate')||''),joinedAt:String(fd.get('joinedAt')||''),notes:String(fd.get('notes')||'').trim()};
    const errors=validateMember(state.data,draft,state.modal.id);if(errors.length){state.modal.draft={...state.modal.draft,...draft};state.modal.errors=errors;render();return;}
    const timestamp=nowISO(),displayName=normalizeText(`${draft.firstName} ${draft.lastName}`),effectiveFrom=currentPeriod();
    if(state.modal.id){const m=state.data.members.find(x=>x.id===state.modal.id);const oldMode=m.feeMode,oldFee=memberFee(state.data,m,effectiveFrom);Object.assign(m,draft,{displayName,updatedAt:timestamp,feeStartPeriod:m.feeStartPeriod||((draft.joinedAt||'').slice(0,7)||'1900-01')});if(draft.feeMode==='custom'&&(oldMode!=='custom'||Number(draft.monthlyFee)!==Number(oldFee))){m.feeHistory=[...(m.feeHistory||[]),{id:uid('mfee'),effectiveFrom,amount:Number(draft.monthlyFee),createdAt:timestamp,updatedAt:timestamp,deletedAt:null}];}}
    else {state.data.members.push({id:uid('m'),legacyId:'',...draft,displayName,feeStartPeriod:(draft.joinedAt||'').slice(0,7)||currentPeriod(),feeHistory:draft.feeMode==='custom'?[{id:uid('mfee'),effectiveFrom,amount:Number(draft.monthlyFee),createdAt:timestamp,updatedAt:timestamp,deletedAt:null}]:[],createdAt:timestamp,updatedAt:timestamp,deletedAt:null});}
    state.modal=null;persist('Socio guardado.');return;
  }
  if(event.target.id==='fee-form'){
    const fd=new FormData(event.target),fee=Number(fd.get('defaultFee')),effectiveFrom=String(fd.get('effectiveFrom')||currentPeriod());if(!(fee>0)){toast('La cuota debe ser mayor a 0.','error');return;}if(!/^\d{4}-\d{2}$/.test(effectiveFrom)){toast('Elegí desde qué mes rige.','error');return;}
    const timestamp=nowISO();state.data.settings.feeHistory.push({id:uid('fee'),effectiveFrom,amount:fee,createdAt:timestamp,updatedAt:timestamp,deletedAt:null});if(effectiveFrom<=currentPeriod())state.data.settings.defaultFee=fee;else state.data.settings.defaultFee=fee;state.data.settings.updatedAt=timestamp;persist(`Cuota guardada desde ${periodLabel(effectiveFrom)}.`);return;
  }
  if(event.target.id==='sale-form'){
    const fd=new FormData(event.target);
    const draft={memberId:String(fd.get('memberId')||''),productId:String(fd.get('productId')||''),quantity:Number(fd.get('quantity')),unitPrice:Number(fd.get('unitPrice')),soldAt:String(fd.get('soldAt')||''),method:String(fd.get('method')||'cash'),note:String(fd.get('note')||'').trim()};
    draft.amount=draft.quantity*draft.unitPrice;
    const errors=validateSale(state.data,draft,state.modal.id);
    if(errors.length){state.modal.draft={...state.modal.draft,...draft};state.modal.errors=errors;render();return;}
    const timestamp=nowISO(),soldAt=`${draft.soldAt}T12:00:00`,product=getProduct(draft.productId);
    const snapshot={productName:product?.name||state.modal.draft.productName||'Producto',productEmoji:product?.emoji||state.modal.draft.productEmoji||'🛒'};
    if(state.modal.id){const sale=state.data.sales.find(x=>x.id===state.modal.id);Object.assign(sale,draft,snapshot,{soldAt,updatedAt:timestamp});}
    else{state.data.sales.push({id:uid('sale'),...draft,...snapshot,soldAt,createdAt:timestamp,updatedAt:timestamp,deletedAt:null});}
    state.data.settings.lastSaleMethod=draft.method;state.data.settings.updatedAt=timestamp;state.modal=null;persist('Venta guardada.');return;
  }
  if(event.target.id==='product-form'){
    const fd=new FormData(event.target),draft={emoji:String(fd.get('emoji')||'🛒').trim()||'🛒',name:normalizeText(fd.get('name')),price:Math.max(0,Number(fd.get('price')||0)),active:String(fd.get('active')||'active')!=='inactive'};
    if(!draft.name){state.modal.errors=['El nombre es obligatorio.'];state.modal.draft={...state.modal.draft,...draft};render();return;}
    const duplicate=live(state.data.products).find(p=>p.id!==state.modal.id&&normalizeText(p.name)===draft.name);
    if(duplicate){state.modal.errors=['Ya existe un producto con ese nombre.'];state.modal.draft={...state.modal.draft,...draft};render();return;}
    const timestamp=nowISO();
    if(state.modal.id){const product=state.data.products.find(x=>x.id===state.modal.id);Object.assign(product,draft,{updatedAt:timestamp});}
    else{state.data.products.push({id:uid('prod'),...draft,createdAt:timestamp,updatedAt:timestamp,deletedAt:null});}
    state.modal=null;persist('Producto guardado.');return;
  }
});

document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.modal){state.modal=null;render();}});
document.addEventListener('focusin',keepFocusedFieldVisible);
document.addEventListener('focusout',clearKeyboardFocusState);
window.visualViewport?.addEventListener('resize',handleVisualViewportChange);
window.visualViewport?.addEventListener('scroll',handleVisualViewportChange);
window.addEventListener('orientationchange',()=>setTimeout(handleVisualViewportChange,120));
window.addEventListener('online',()=>{state.sync={...state.sync,kind:state.token?'pending':state.driveLinked?'auth':'local',text:state.token?'Conexión recuperada · comprobando Drive':state.driveLinked?'Conexión recuperada · Drive requiere autorización':'Conexión recuperada · guardado local'};render();scheduleSync();});
window.addEventListener('offline',()=>{const pending=pendingOperationCount();state.sync={...state.sync,kind:'offline',text:pending?`Sin conexión · ${pending} cambio${pending===1?'':'s'} local${pending===1?'':'es'}`:'Sin conexión · datos guardados localmente'};render();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')scheduleSync();});
window.addEventListener('focus',()=>scheduleSync());

window.addEventListener('resize',()=>{if(state.view==='fees'&&compactViewport())navigate('payments');});
syncVisualViewport();

if(import.meta.env?.DEV && 'serviceWorker' in navigator){
  // Evita que una PWA vieja instalada en localhost siga sirviendo JS anterior durante desarrollo.
  navigator.serviceWorker.getRegistrations().then(rows=>Promise.all(rows.map(r=>r.unregister()))).catch(()=>{});
  if('caches' in window) caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('north-south-')).map(k=>caches.delete(k)))).catch(()=>{});
}
if(import.meta.env?.PROD&&'serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(console.warn);
if (state.account && state.data) openPayment();
else render();

window.addEventListener('storage', event => {
  if (!state.account?.email || event.key !== dataKeyFor(state.account.email) || !event.newValue || state.modal) return;
  try { state.data = loadData(state.account.email); render(); } catch { /* conserva la copia actual */ }
});

async function bootstrapSession() {
  if (!state.account) return;
  startAutoSync();
  if (!clientId() || !navigator.onLine) return;
  try {
    const token = await restoreGoogleToken(clientId());
    if (token) {
      state.token = token;
      setDriveLinked(true);
      await syncNow(false);
    } else if (state.driveLinked) {
      state.sync = { ...state.sync, kind:'auth', text:'Drive requiere autorización', lastError:'Google necesita que renueves el acceso desde el botón de Drive.' };
      render();
    }
  } catch {
    state.sync = state.driveLinked
      ? { ...state.sync, kind:'auth', text:'Drive requiere autorización' }
      : state.sync;
    render();
  }
}
bootstrapSession();
