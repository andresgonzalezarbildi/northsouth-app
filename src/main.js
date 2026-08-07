import {
  dataKeyFor, loadData, saveData, verifyLocalStorage, hasLegacyLocalData, exportLegacyLocalData,
  exportBackup, importBackup
} from './storage.js';
import { connectGoogle, disconnectGoogle, getGoogleProfile, restoreGoogleToken } from './google-auth.js';
import { syncWithDrive } from './drive-sync.js';
import { GOOGLE_WEB_CLIENT_ID } from './app-config.js';
import { loadAuthSession, saveAuthSession, clearAuthSession, normalizeEmail } from './session.js';
import {
  activeMembers, activeProducts, cantinaSummary, findMembers, firstUnpaidPeriod, live, livePayments, liveSales,
  memberFee, memberName, memberPeriodStatus, paidThroughPeriod, periodSummary, recentMovements, trend,
  validateMember, validatePayment, validateSale
} from './model.js';
import {
  addMonths, clamp, currentPeriod, dateLabel, dateTimeLabel, escapeHTML, fuzzyMatch, money,
  normalizeText, nowISO, periodLabel, shortPeriodLabel, todayISO, uid
} from './utils.js';

const APP_VERSION = '6.0.0';
const app = document.querySelector('#app');
let installPrompt = null;

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
  modal: null, toast: null, token: null,
  sync: {
    kind: navigator.onLine ? 'local' : 'offline',
    text: navigator.onLine ? (GOOGLE_WEB_CLIENT_ID ? 'Local · Drive sin conectar' : 'Guardado local') : 'Sin conexión · guardado local',
    lastAt: null
  },
  syncing: false, syncTimer: null,
  storageOK: verifyLocalStorage(), memberListScrollY: 0
};

const viewMeta = {
  dashboard: ['Panel', 'Lo importante de la academia, de un vistazo'],
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

function toast(message, type = 'ok') {
  state.toast = { message, type };
  render();
  setTimeout(() => {
    if (state.toast?.message === message) { state.toast = null; render(); }
  }, 2800);
}

function persist(message = null, { sync = true } = {}) {
  if (!state.account?.email || !state.data) return false;
  try {
    state.data = saveData(state.account.email, state.data);
    const reloaded = loadData(state.account.email);
    if (reloaded.meta.localRevision !== state.data.meta.localRevision) throw new Error('La verificación local devolvió otra revisión.');
    state.data = reloaded;
    state.storageOK = true;
    state.sync = navigator.onLine
      ? { ...state.sync, kind: state.token ? state.sync.kind : 'local', text: state.token ? state.sync.text : 'Guardado local · Drive sin conectar' }
      : { ...state.sync, kind: 'offline', text: 'Sin conexión · guardado local' };
  } catch (e) {
    console.error(e);
    state.storageOK = false;
    toast('No se pudo guardar en este dispositivo.', 'error');
    return false;
  }
  render();
  if (message) toast(message);
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
    state.sync = { ...state.sync, kind:'local', text:'Guardado local · Drive sin conectar' };
    render();
    return;
  }
  state.syncTimer = setTimeout(() => syncNow(false), 700);
}

async function ensureDriveLogin({ selectAccount = true } = {}) {
  const cid = clientId();
  if (!cid) throw new Error('Google no está configurado en esta versión.');
  const login = await connectGoogle(cid, { selectAccount });
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
    state.sync = { kind:'local', text:'Guardado local · preparando Drive', lastAt:null };
    state.view = 'dashboard';
    state.authBusy = false;
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
  clearAuthSession();
  clearTimeout(state.syncTimer);
  state.account = null;
  state.data = null;
  state.token = null;
  state.modal = null;
  state.toast = null;
  state.authError = '';
  state.sync = { kind:'local', text:'Guardado local', lastAt:null };
  render({ preserveScroll:false });
}

async function syncNow(interactive = false) {
  if (state.syncing || !state.account || !state.data) return;
  const cid = clientId();
  if (!cid) {
    if (interactive) toast('Google no está configurado en esta versión.', 'error');
    return;
  }
  if (!navigator.onLine) {
    state.sync = { ...state.sync, kind:'offline', text:'Sin conexión · guardado local' };
    if (interactive) toast('Sin internet. Todo sigue guardado en este dispositivo.', 'error');
    render();
    return;
  }
  try {
    state.syncing = true;
    state.sync = { ...state.sync, kind:'busy', text:'Sincronizando…' };
    render();
    let token = state.token;
    if (!token) {
      token = await restoreGoogleToken(cid);
      if (token) {
        const profile = await getGoogleProfile(token);
        const tokenEmail = normalizeEmail(profile?.email);
        if (!tokenEmail || tokenEmail !== state.account.email) {
          await disconnectGoogle();
          throw new Error(`La cuenta de Drive no coincide con ${state.account.email}. Volvé a iniciar sesión.`);
        }
      }
    }
    if (!token && interactive) {
      const login = await ensureDriveLogin({ selectAccount:false });
      if (login.email !== state.account.email) {
        await disconnectGoogle();
        throw new Error(`Conectá Drive con ${state.account.email}.`);
      }
      token = login.token;
    }
    if (!token) {
      state.sync = { ...state.sync, kind:'local', text:'Guardado local · Drive sin conectar' };
      render();
      return;
    }
    state.token = token;
    const result = await syncWithDrive(state.data, token);
    state.data = saveData(state.account.email, result.data, { markDirty:false });
    state.sync = { kind:'ok', text:'Drive al día', lastAt:nowISO() };
    if (interactive) toast(result.created ? 'Drive conectado.' : 'Datos sincronizados.');
  } catch (e) {
    console.error(e);
    state.sync = { ...state.sync, kind:'error', text:'Drive pendiente', lastAt:state.sync.lastAt };
    if (interactive) toast(e.message || 'No se pudo sincronizar.', 'error');
    if (/venció|401/i.test(e.message || '')) state.token = null;
  } finally {
    state.syncing = false;
    render();
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
        <button class="brand brand-button" data-view="dashboard" aria-label="Ir al panel">
          <img src="./assets/north-south-logo.jpg" alt="North South"><div><div class="brand-title">NORTH SOUTH</div><div class="brand-sub">Academy · Maldonado</div></div>
        </button>
        <nav class="nav-list">
          ${navButton('dashboard','◫','Panel')}
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
        ${content}
      </main>
      <nav class="mobile-nav">
        <button data-view="dashboard" class="${state.view === 'dashboard' ? 'active' : ''}"><b>◫</b>Panel</button>
        <button data-view="members" class="${state.view === 'members' ? 'active' : ''}"><b>♟</b>Socios</button>
        <button data-view="fees" class="${state.view === 'fees' ? 'active' : ''}"><b>▦</b>Cuotas</button>
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
  const cantina = cantinaSummary(state.data, period);
  const movements = recentMovements(state.data, 10);
  const futurePeriods = [1,2,3].map(i => addMonths(period, i));
  const futurePaid = futurePeriods.map(p => ({ period:p, count:activeMembers(state.data).filter(m => memberPeriodStatus(state.data,m,p).isPaid).length }));
  const bars = trend(state.data, period, 6);
  const maxBar = Math.max(...bars.map(x => x.total), 1);
  const isEmptyAccount = !state.data.members.length && !state.data.payments.length && !state.data.products.length && !state.data.sales.length;

  return `${isEmptyAccount ? `<section class="card empty-account-hint"><div><strong>Esta cuenta todavía no tiene datos</strong><span>Para cargar la planilla inicial: Ajustes → Importar respaldo → IMPORTAR-DATOS-ACTUALES.json</span></div><button class="btn" data-view="settings">Ir a Ajustes</button></section>` : ''}` + `
    <section class="dashboard-hero card">
      <div class="hero-main">
        <div class="eyebrow">${periodLabel(period)}</div>
        <div class="hero-title">${money(summary.collected)} <span>cobrados</span></div>
        <div class="hero-sub">Faltan ${money(summary.pendingAmount)} para completar las cuotas del mes</div>
        <div class="progress-track big"><div class="progress-fill" style="width:${clamp(summary.rate*100,0,100)}%"></div></div>
      </div>
      <div class="hero-rate"><strong>${Math.round(summary.rate*100)}%</strong><span>cobrado</span></div>
    </section>

    <div class="simple-kpis">
      <button class="card simple-kpi" data-view="members"><span class="kpi-icon">🥋</span><span><small>Socios activos</small><strong>${summary.activeCount}</strong></span></button>
      <button class="card simple-kpi" data-view="fees"><span class="kpi-icon">✓</span><span><small>Al día este mes</small><strong>${summary.paidCount}</strong></span></button>
      <button class="card simple-kpi" data-view="fees"><span class="kpi-icon">⏩</span><span><small>Pagaron mes siguiente</small><strong>${futurePaid[0].count}</strong></span></button>
      <button class="card simple-kpi" data-view="cantina"><span class="kpi-icon">☕</span><span><small>Cantina este mes</small><strong>${money(cantina.total)}</strong></span></button>
    </div>

    <div class="dashboard-grid dashboard-clean">
      <section class="card panel">
        <div class="panel-head"><div><div class="panel-title">Últimos movimientos</div><div class="panel-subtitle">Ordenados por cuándo los agregaste</div></div></div>
        <div class="movement-list">
          ${movements.map(renderMovement).join('') || '<div class="empty">Todavía no hay movimientos.</div>'}
        </div>
      </section>

      <div class="dashboard-side">
        <section class="card panel">
          <div class="panel-head"><div><div class="panel-title">Próximos meses</div><div class="panel-subtitle">Socios que ya dejaron la cuota paga</div></div><button class="btn small ghost" data-view="fees">Ver cuotas</button></div>
          <div class="future-months">
            ${futurePaid.map(x => `<div><span>${shortPeriodLabel(x.period)}</span><strong>${x.count}</strong><small>socios pagos</small></div>`).join('')}
          </div>
        </section>
        <section class="card panel">
          <div class="panel-head"><div><div class="panel-title">Cobros de los últimos meses</div></div></div>
          <div class="chart-bars compact">
            ${bars.map(x => `<div class="bar-wrap"><div class="bar-value">${x.total ? Math.round(x.total/1000)+'k' : '0'}</div><div class="bar" style="height:${Math.max(5,x.total/maxBar*105)}px"></div><div class="bar-label">${shortPeriodLabel(x.period).split(' ')[0]}</div></div>`).join('')}
          </div>
        </section>
      </div>
    </div>`;
}

function renderMovement(movement) {
  const member = getMember(movement.memberId);
  if (movement.movementType === 'sale') {
    const product = getProduct(movement.productId);
    return `<div class="movement-row">
      <div class="movement-icon sale">${escapeHTML(product?.emoji || movement.productEmoji || '☕')}</div>
      <div class="row-main"><div class="row-title">${escapeHTML(member ? memberName(member) : 'Socio')} · ${escapeHTML(product?.name || movement.productName || 'Cantina')}</div><div class="row-sub">Venta del ${dateLabel(movement.soldAt)} · agregada ${dateTimeLabel(movement.createdAt)}</div></div>
      <div class="amount">${money(movement.amount)}</div>
    </div>`;
  }
  return `<div class="movement-row">
    <div class="movement-icon payment">$</div>
    <div class="row-main"><div class="row-title">${escapeHTML(member ? memberName(member) : 'Socio no disponible')}</div><div class="row-sub">Cuota ${shortPeriodLabel(movement.period)} · cobro ${dateLabel(movement.paidAt)} · agregado ${dateTimeLabel(movement.createdAt)}</div></div>
    <div class="amount">${money(movement.amount)}</div>
  </div>`;
}

function memberStatusLabel(member) {
  if (member.status === 'inactive') return { cls:'inactive', text:'Inactivo' };
  const current = memberPeriodStatus(state.data, member, currentPeriod());
  if (!current.isPaid) return { cls:'warn', text:`Debe ${money(current.remaining)}` };
  const through = paidThroughPeriod(state.data, member, currentPeriod());
  if (through && through > currentPeriod()) return { cls:'ok', text:`Al día hasta ${shortPeriodLabel(through)}` };
  return { cls:'ok', text:'Al día' };
}

function renderMembers() {
  const rows = live(state.data.members)
    .filter(m => state.memberFilter === 'all' || m.status === state.memberFilter)
    .filter(m => !state.memberQuery || fuzzyMatch(`${memberName(m)} ${m.phone || ''}`, state.memberQuery))
    .sort((a,b) => memberName(a).localeCompare(memberName(b),'es'));
  return `
    <div class="toolbar toolbar-balanced">
      <div class="search grow"><input id="member-search" value="${escapeHTML(state.memberQuery)}" placeholder="Buscar socio…" autocomplete="off"></div>
      <div class="filter-tabs">${[['active','Activos'],['inactive','Inactivos'],['all','Todos']].map(([v,l]) => `<button class="filter-tab ${state.memberFilter===v?'active':''}" data-member-filter="${v}">${l}</button>`).join('')}</div>
      <button class="btn" data-action="new-member">＋ Nuevo socio</button>
    </div>
    <div class="member-grid">
      ${rows.map(m => {
        const badge = memberStatusLabel(m);
        return `<div class="card member-card">
          <button class="avatar avatar-button" data-action="member-detail" data-id="${m.id}">${initials(memberName(m))}</button>
          <button class="row-main text-button" data-action="member-detail" data-id="${m.id}"><div class="row-title">${escapeHTML(memberName(m))}</div><div class="row-sub">Cuota ${money(memberFee(state.data,m,currentPeriod()))}${m.phone ? ` · ${escapeHTML(m.phone)}` : ''}</div></button>
          <div class="member-actions"><span class="badge ${badge.cls}">${badge.text}</span>${m.status==='active'?`<button class="btn primary small" data-action="pay-member" data-id="${m.id}">Cobrar</button>`:''}</div>
        </div>`;
      }).join('') || '<div class="empty card full-span">No hay socios que coincidan con la búsqueda.</div>'}
    </div>`;
}

function renderFees() {
  const periods = Array.from({length:7}, (_,i) => addMonths(state.feeWindowStart, i));
  const rows = activeMembers(state.data)
    .filter(m => !state.feeQuery || fuzzyMatch(memberName(m), state.feeQuery))
    .sort((a,b) => memberName(a).localeCompare(memberName(b),'es'));
  return `
    <div class="toolbar toolbar-balanced">
      <div class="search grow"><input id="fee-search" value="${escapeHTML(state.feeQuery)}" placeholder="Buscar socio…" autocomplete="off"></div>
      <div class="period-nav"><button class="btn small ghost" data-action="fees-prev">‹ 3 meses</button><button class="btn small" data-action="fees-today">Hoy</button><button class="btn small ghost" data-action="fees-next">3 meses ›</button></div>
    </div>
    <section class="card matrix-card">
      <div class="matrix-help">Tocá un mes pendiente para registrar el cobro. Los meses pagos por adelantado quedan marcados en verde.</div>
      <div class="fees-scroll">
        <table class="fees-table">
          <thead><tr><th class="member-col">Socio</th>${periods.map(p=>`<th class="${p===currentPeriod()?'current-month':''}">${shortPeriodLabel(p)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(m => `<tr><td class="member-col"><button class="matrix-member" data-action="member-detail" data-id="${m.id}">${escapeHTML(memberName(m))}</button></td>${periods.map(p => renderFeeCell(m,p)).join('')}</tr>`).join('')}</tbody>
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

function renderPayments() {
  const rows = livePayments(state.data)
    .filter(p => state.paymentPeriod === 'all' || p.period === state.paymentPeriod)
    .filter(p => state.paymentMethod === 'all' || p.method === state.paymentMethod)
    .filter(p => {
      if (!state.paymentQuery) return true;
      const m = getMember(p.memberId);
      return fuzzyMatch(`${m ? memberName(m) : ''} ${p.note || ''}`, state.paymentQuery);
    })
    .sort((a,b) => Date.parse(b.createdAt || b.updatedAt || 0) - Date.parse(a.createdAt || a.updatedAt || 0));
  const total = rows.reduce((s,p)=>s+Number(p.amount||0),0);
  return `
    <div class="toolbar toolbar-balanced">
      <div class="search grow"><input id="payment-search" value="${escapeHTML(state.paymentQuery)}" placeholder="Buscar socio o nota…"></div>
      <select id="payment-period"><option value="all" ${state.paymentPeriod==='all'?'selected':''}>Todos los meses</option>${Array.from({length:15},(_,i)=>addMonths(currentPeriod(),i-10)).reverse().map(p=>`<option value="${p}" ${state.paymentPeriod===p?'selected':''}>${periodLabel(p)}</option>`).join('')}</select>
      <select id="payment-method-filter"><option value="all">Todos los medios</option>${[['cash','Efectivo'],['transfer','Transferencia'],['other','Otro'],['unknown','Sin especificar']].map(([v,l])=>`<option value="${v}" ${state.paymentMethod===v?'selected':''}>${l}</option>`).join('')}</select>
    </div>
    <section class="card panel"><div class="panel-head"><div><div class="panel-title">Pagos registrados</div><div class="panel-subtitle">${rows.length} movimientos · ordenados por agregado</div></div><div class="amount">${money(total)}</div></div>
      <div class="list">${rows.map(p => { const m=getMember(p.memberId); return `<div class="row-card"><div class="avatar">${initials(m?memberName(m):'?')}</div><div class="row-main"><div class="row-title">${escapeHTML(m?memberName(m):'Socio no disponible')}</div><div class="row-sub">${shortPeriodLabel(p.period)} · cobro ${dateLabel(p.paidAt)} · agregado ${dateTimeLabel(p.createdAt)} · ${methodLabel(p.method)}${p.note&&p.note!=='Importado de la planilla original'?` · ${escapeHTML(p.note)}`:''}</div></div><div class="amount">${money(p.amount)}</div><button class="btn small ghost" data-action="edit-payment" data-id="${p.id}">Editar</button></div>`; }).join('') || '<div class="empty">No hay pagos para este filtro.</div>'}</div>
    </section>`;
}

function renderCantina() {
  const products = live(state.data.products)
    .filter(p => state.cantinaProductFilter === 'all' || (state.cantinaProductFilter === 'active' ? p.active !== false : p.active === false))
    .filter(p => !state.cantinaQuery || fuzzyMatch(`${p.name} ${p.emoji}`, state.cantinaQuery))
    .sort((a,b) => Number(b.active !== false) - Number(a.active !== false) || a.name.localeCompare(b.name,'es'));
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
    <div class="product-grid">${products.map(p => `<div class="card product-card ${p.active===false?'product-inactive':''}"><div class="product-emoji">${escapeHTML(p.emoji || '🛒')}</div><div class="row-main"><div class="row-title">${escapeHTML(p.name)}</div><div class="row-sub">${p.price>0?money(p.price):'Precio al vender'}${p.active===false?' · Inactivo':''}</div></div><div class="product-actions"><button class="btn small ghost" data-action="edit-product" data-id="${p.id}">Editar</button>${p.active!==false?`<button class="btn cantina-btn small" data-action="sell-product" data-id="${p.id}">Vender</button>`:'<span class="badge inactive product-status-badge">Inactivo</span>'}</div></div>`).join('') || '<div class="empty card full-span">No hay productos para este filtro.</div>'}</div>
    <section class="card panel cantina-history"><div class="panel-head"><div><div class="panel-title">Últimas ventas</div><div class="panel-subtitle">Ordenadas por cuándo las agregaste</div></div></div><div class="list">${sales.map(s=>{const m=getMember(s.memberId),p=getProduct(s.productId);return `<div class="row-card"><div class="movement-icon sale">${escapeHTML(p?.emoji||s.productEmoji||'☕')}</div><div class="row-main"><div class="row-title">${escapeHTML(m?memberName(m):'Socio')} · ${escapeHTML(p?.name||s.productName||'Producto')}</div><div class="row-sub">${Number(s.quantity||1)} × ${money(s.unitPrice)} · ${dateLabel(s.soldAt)} · agregado ${dateTimeLabel(s.createdAt)}</div></div><div class="amount">${money(s.amount)}</div><button class="btn small ghost" data-action="edit-sale" data-id="${s.id}">Editar</button></div>`}).join('')||'<div class="empty">Todavía no hay ventas.</div>'}</div></section>`;
}

function renderSettings() {
  const imported = state.data.payments.filter(p=>p.source==='xlsx-import').length;
  const driveReady = Boolean(clientId());
  const legacyAvailable = hasLegacyLocalData();
  return `<div class="settings-grid">
    <section class="card settings-card"><h3>Cuota general</h3><p>Los meses anteriores conservan el valor que tenían.</p><form id="fee-form" class="form-grid compact-form"><div class="field"><label>Nueva cuota</label><input name="defaultFee" type="number" min="1" step="1" value="${Number(state.data.settings.defaultFee)}"></div><div class="field"><label>Rige desde</label><input name="effectiveFrom" type="month" value="${currentPeriod()}"></div><div class="field full"><button class="btn primary" type="submit">Guardar cuota</button></div></form></section>
    <section class="card settings-card"><h3>Sincronización con Drive</h3><p>La app guarda primero en este equipo. Drive combina los cambios cuando hay conexión.</p><div class="sync-settings"><div><span class="sync-pill ${state.sync.kind}"><span class="sync-dot"></span>${escapeHTML(state.sync.text)}</span><small>${escapeHTML(state.account.email)}</small></div><div class="settings-actions"><button class="btn primary" data-action="sync-drive" ${driveReady?'':'disabled'}>${state.token?'Sincronizar ahora':'Conectar Drive'}</button></div></div>${!driveReady?'<small class="settings-note">Google se configura en .env, no dentro de la aplicación.</small>':''}</section>
    <section class="card settings-card"><h3>Datos y respaldo</h3><p>Una cuenta nueva empieza vacía. El archivo inicial se importa una sola vez.</p><div class="settings-actions"><button class="btn" data-action="export-backup">Descargar respaldo</button><label class="btn ghost" for="backup-file">Importar respaldo</label><input id="backup-file" type="file" accept="application/json,.json" hidden>${legacyAvailable?'<button class="btn ghost" data-action="export-legacy">Descargar datos de la versión anterior</button>':''}</div></section>
    <section class="card settings-card"><h3>App en esta PC</h3><p>Al instalarla abre en su propia ventana y sigue usando el almacenamiento local aunque no haya internet.</p>${installPrompt?'<div class="settings-actions"><button class="btn" data-action="install-app">Instalar aplicación</button></div>':'<small class="settings-note">El botón aparece al abrir la versión publicada por HTTPS en Chrome o Edge. En localhost usá npm run dev o ABRIR-APP-LOCAL.bat.</small>'}</section>
    <section class="card settings-card"><h3>Cuenta</h3><div class="account-card"><div><strong>${escapeHTML(state.account.name || state.account.email)}</strong><small>${escapeHTML(state.account.email)}</small></div><button class="btn ghost" data-action="logout">Cerrar sesión</button></div></section>
    <section class="card settings-card"><h3>Datos</h3><div class="detail-grid"><div class="detail-stat"><span>Socios</span><strong>${live(state.data.members).length}</strong></div><div class="detail-stat"><span>Activos</span><strong>${activeMembers(state.data).length}</strong></div><div class="detail-stat"><span>Pagos importados</span><strong>${imported}</strong></div><div class="detail-stat"><span>Ventas cantina</span><strong>${liveSales(state.data).length}</strong></div></div><small class="settings-note">Versión ${APP_VERSION} · almacenamiento local ${state.storageOK?'activo':'con problema'}</small></section>
  </div>`;
}

function renderMemberPicker(draft, pickerType) {
  const suggestions = findMembers(state.data, draft.memberQuery || '', { includeInactive:false, limit:7 });
  const chosen = getMember(draft.memberId);
  return `<div class="field full member-picker"><label>Socio</label><input id="${pickerType}-member-search" data-member-picker="${pickerType}" value="${escapeHTML(draft.memberQuery || (chosen?memberName(chosen):''))}" placeholder="Escribí el nombre…" autocomplete="off" required><input type="hidden" name="memberId" value="${escapeHTML(draft.memberId || '')}"><div class="picker-results ${draft.memberPickerOpen?'open':''}">${suggestions.map(m=>`<button type="button" data-action="pick-member" data-picker="${pickerType}" data-id="${m.id}"><span class="avatar tiny">${initials(memberName(m))}</span><span>${escapeHTML(memberName(m))}</span></button>`).join('') || '<div class="picker-empty">No encontré socios.</div>'}</div></div>`;
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
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal" data-modal-stop><div class="modal-head"><div><div class="modal-title">${editing?'Editar pago':'Registrar pago'}</div><div class="panel-subtitle">Elegí al socio y la app completa el resto.</div></div><button class="close-btn" data-action="close-modal">×</button></div>
    <form id="payment-form"><div class="modal-body">${modal.errors?.length?`<div class="form-errors">${modal.errors.map(escapeHTML).join('<br>')}</div>`:''}<div class="form-grid">
      ${renderMemberPicker(d,'payment')}
      <div class="field"><label>Mes inicial</label><input name="period" data-payment-live type="month" value="${escapeHTML(d.period)}" required></div>
      ${!editing?`<div class="field"><label>Meses que paga</label><select name="months" data-payment-live>${[1,2,3,6].map(n=>`<option value="${n}" ${months===n?'selected':''}>${n}</option>`).join('')}</select></div>`:'<input type="hidden" name="months" value="1">'}
      <div class="field"><label>Fecha de cobro</label><input name="paidAt" type="date" value="${escapeHTML(d.paidAt)}" required></div>
      <div class="field"><label>Monto</label><input id="payment-amount" name="amount" type="number" min="1" step="1" value="${Number(d.amount||due.total||0)}" ${months>1?'readonly':''} required><small>${months>1?'Se calcula sumando los meses seleccionados.':'Puede ser un pago parcial.'}</small></div>
      <div class="field full"><label>Medio de pago</label><input type="hidden" name="method" value="${escapeHTML(d.method)}"><div class="segment">${[['cash','Efectivo'],['transfer','Transferencia'],['other','Otro']].map(([v,l])=>`<button type="button" class="${d.method===v?'active':''}" data-payment-method="${v}">${l}</button>`).join('')}</div></div>
      <div class="field full"><label>Nota <span class="muted-inline">(opcional)</span></label><input name="note" value="${escapeHTML(d.note||'')}" placeholder="Detalle del pago"></div>
    </div>${member?`<div class="payment-preview"><div><span>${months>1?'Total de los meses':'Pendiente del mes'}</span><strong>${money(due.total)}</strong></div><div><span>Después de este pago</span><strong class="${after===0?'good-text':'warn-text'}">${after===0?'Queda pago':`Queda ${money(after)}`}</strong></div></div>`:''}</div>
    <div class="modal-foot">${editing?`<button type="button" class="btn danger" data-action="delete-payment" data-id="${editing.id}">Eliminar</button>`:''}<span class="foot-spacer"></span><button type="button" class="btn ghost" data-action="close-modal">Cancelar</button><button type="button" class="btn primary" data-action="save-payment" ${!member||due.total<=0?'disabled':''}>Guardar pago</button></div></form>
  </div></div>`;
}

function renderMemberModal(modal) {
  const d=modal.draft;
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal" data-modal-stop><div class="modal-head"><div><div class="modal-title">${modal.id?'Editar socio':'Nuevo socio'}</div><div class="panel-subtitle">La cuota general se completa automáticamente.</div></div><button class="close-btn" data-action="close-modal">×</button></div>
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
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal wide" data-modal-stop><div class="modal-head"><div class="modal-title">Ficha del socio</div><button class="close-btn" data-action="close-modal">×</button></div><div class="modal-body">
    <div class="detail-hero"><div class="avatar">${initials(memberName(m))}</div><div class="row-main"><div class="detail-title">${escapeHTML(memberName(m))}</div><div class="row-sub"><span class="badge ${badge.cls}">${badge.text}</span>${m.phone?` · ${escapeHTML(m.phone)}`:''}</div></div><div class="detail-actions"><button class="btn" data-action="edit-member" data-id="${m.id}">Editar</button>${m.status==='active'?`<button class="btn primary" data-action="pay-member" data-id="${m.id}">Cobrar</button>`:''}</div></div>
    <div class="mini-months">${periods.map(p=>{const s=memberPeriodStatus(state.data,m,p);return `<button class="mini-month ${s.isPaid?'paid':p>currentPeriod()?'future':'due'}" ${!s.isPaid?`data-action="pay-member-period" data-id="${m.id}" data-period="${p}"`:''}><span>${shortPeriodLabel(p)}</span><strong>${s.isPaid?'✓ Pago':s.notStarted?'—':s.paid>0?`Falta ${money(s.remaining)}`:`${money(s.remaining)}`}</strong></button>`}).join('')}</div>
    <div class="detail-grid"><div class="detail-stat"><span>Cuota actual</span><strong>${money(memberFee(state.data,m,currentPeriod()))}</strong></div><div class="detail-stat"><span>Ingreso</span><strong>${m.joinedAt?dateLabel(m.joinedAt):'Sin dato'}</strong></div><div class="detail-stat"><span>Nacimiento</span><strong>${m.birthDate?dateLabel(m.birthDate):'Sin dato'}</strong></div><div class="detail-stat"><span>Mutualista</span><strong>${escapeHTML(m.medicalProvider||'Sin dato')}</strong></div></div>
    ${m.notes?`<div class="note-box">${escapeHTML(m.notes)}</div>`:''}<div class="panel-head"><div><div class="panel-title">Últimos pagos agregados</div></div></div><div class="list">${history.map(p=>`<div class="row-card"><div class="row-main"><div class="row-title">${shortPeriodLabel(p.period)}</div><div class="row-sub">Cobro ${dateLabel(p.paidAt)} · agregado ${dateTimeLabel(p.createdAt)}</div></div><div class="amount">${money(p.amount)}</div><button class="btn small ghost" data-action="edit-payment" data-id="${p.id}">Editar</button></div>`).join('')||'<div class="empty">Todavía no tiene pagos.</div>'}</div>
  </div></div></div>`;
}

function renderSaleModal(modal) {
  const d=modal.draft, member=getMember(d.memberId), product=getProduct(d.productId), editing=modal.id?state.data.sales.find(s=>s.id===modal.id):null;
  const total=Number(d.quantity||1)*Number(d.unitPrice||0);
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal" data-modal-stop><div class="modal-head"><div><div class="modal-title">${editing?'Editar venta':'Venta cantina'}</div><div class="panel-subtitle">Socio, producto y cantidad.</div></div><button class="close-btn" data-action="close-modal">×</button></div><form id="sale-form"><div class="modal-body">${modal.errors?.length?`<div class="form-errors">${modal.errors.map(escapeHTML).join('<br>')}</div>`:''}<div class="form-grid">
    ${renderMemberPicker(d,'sale')}
    <div class="field full"><label>Producto</label><input type="hidden" name="productId" value="${escapeHTML(d.productId||'')}"><div class="product-picker">${activeProducts(state.data).map(p=>`<button type="button" class="${d.productId===p.id?'active':''}" data-action="pick-product" data-id="${p.id}"><span>${escapeHTML(p.emoji||'🛒')}</span><b>${escapeHTML(p.name)}</b></button>`).join('')}</div></div>
    <div class="field"><label>Cantidad</label><input id="sale-quantity" name="quantity" type="number" min="1" step="1" value="${Number(d.quantity||1)}" required></div><div class="field"><label>Precio por unidad</label><input id="sale-unit-price" name="unitPrice" type="number" min="1" step="1" value="${Number(d.unitPrice||product?.price||0)}" required></div>
    <div class="field"><label>Fecha</label><input name="soldAt" type="date" value="${escapeHTML(d.soldAt)}" required></div><div class="field"><label>Total</label><div class="readout">${money(total)}</div></div>
    <div class="field full"><label>Medio de pago</label><input type="hidden" name="method" value="${escapeHTML(d.method)}"><div class="segment">${[['cash','Efectivo'],['transfer','Transferencia'],['other','Otro']].map(([v,l])=>`<button type="button" class="${d.method===v?'active':''}" data-sale-method="${v}">${l}</button>`).join('')}</div></div>
    <div class="field full"><label>Nota <span class="muted-inline">(opcional)</span></label><input name="note" value="${escapeHTML(d.note||'')}"></div>
  </div></div><div class="modal-foot">${editing?`<button type="button" class="btn danger" data-action="delete-sale" data-id="${editing.id}">Eliminar</button>`:''}<span class="foot-spacer"></span><button type="button" class="btn ghost" data-action="close-modal">Cancelar</button><button class="btn cantina-btn" type="button" data-action="save-sale" ${!member||!product||total<=0?'disabled':''}>Guardar venta</button></div></form></div></div>`;
}

function renderProductModal(modal) {
  const d=modal.draft;
  return `<div class="modal-backdrop" data-modal-backdrop><div class="modal small-modal" data-modal-stop><div class="modal-head"><div><div class="modal-title">${modal.id?'Editar producto':'Nuevo producto'}</div><div class="panel-subtitle">El emoji aparece en los accesos de cantina.</div></div><button class="close-btn" data-action="close-modal">×</button></div><form id="product-form"><div class="modal-body">${modal.errors?.length?`<div class="form-errors">${modal.errors.map(escapeHTML).join('<br>')}</div>`:''}<div class="form-grid"><div class="field"><label>Emoji</label><input name="emoji" class="emoji-input" value="${escapeHTML(d.emoji||'🛒')}" maxlength="8"></div><div class="field"><label>Producto</label><input name="name" value="${escapeHTML(d.name||'')}" required></div><div class="field"><label>Precio habitual</label><input name="price" type="number" min="0" step="1" value="${Number(d.price||0)}"><small>Si lo dejás en 0, se ingresa al vender.</small></div><div class="field"><label>Estado</label><select name="active"><option value="active" ${d.active!==false?'selected':''}>Activo</option><option value="inactive" ${d.active===false?'selected':''}>Inactivo</option></select></div></div></div><div class="modal-foot">${modal.id?`<button type="button" class="btn danger" data-action="delete-product" data-id="${modal.id}">Eliminar</button>`:''}<span class="foot-spacer"></span><button type="button" class="btn ghost" data-action="close-modal">Cancelar</button><button class="btn cantina-btn" type="button" data-action="save-product">Guardar producto</button></div></form></div></div>`;
}

function renderModal() {
  if(!state.modal)return'';
  if(state.modal.type==='payment')return renderPaymentModal(state.modal);
  if(state.modal.type==='member')return renderMemberModal(state.modal);
  if(state.modal.type==='member-detail')return renderMemberDetail(state.modal);
  if(state.modal.type==='sale')return renderSaleModal(state.modal);
  if(state.modal.type==='product')return renderProductModal(state.modal);
  return'';
}

function render({ preserveScroll = true } = {}) {
  const previousScrollY = preserveScroll ? window.scrollY : 0;
  if (!state.account || !state.data) { app.innerHTML = renderLogin(); return; }
  const content = state.view==='dashboard'?renderDashboard():state.view==='members'?renderMembers():state.view==='fees'?renderFees():state.view==='payments'?renderPayments():state.view==='cantina'?renderCantina():renderSettings();
  app.innerHTML=shell(content);
  requestAnimationFrame(() => window.scrollTo(0, previousScrollY));
}

function openPayment(memberId='', payment=null, forcedPeriod='') {
  const member=memberId?getMember(memberId):payment?getMember(payment.memberId):null;
  const period=payment?.period||forcedPeriod||(member?firstUnpaidPeriod(state.data,member,currentPeriod()):currentPeriod());
  const status=member?memberPeriodStatus(state.data,member,period):null;
  state.modal={type:'payment',id:payment?.id||null,errors:[],draft:{memberId:payment?.memberId||memberId||'',memberQuery:member?memberName(member):'',memberPickerOpen:false,period,months:1,amount:Number(payment?.amount||status?.remaining||0),method:payment?.method||state.data.settings.lastPaymentMethod||'cash',paidAt:payment?.paidAt?String(payment.paidAt).slice(0,10):todayISO(),note:payment?.note&&payment.note!=='Importado de la planilla original'?payment.note:''}};
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

function rerenderFocused(id, caret=null) {
  render();
  requestAnimationFrame(()=>{const el=document.getElementById(id);if(el){el.focus();if(caret!=null&&el.setSelectionRange)el.setSelectionRange(caret,caret);}});
}

function refreshPaymentAuto({resetAmount=true}={}) {
  if(state.modal?.type!=='payment')return;
  const d=state.modal.draft, member=getMember(d.memberId); if(!member)return;
  const months=state.modal.id?1:Number(d.months||1);
  const due=paymentDue(member,d.period,months,state.modal.id);
  if(resetAmount || months>1) d.amount=due.total;
}

app.addEventListener('click', async event => {
  if(event.target.matches('[data-modal-backdrop]')){const restore=state.modal?.type==='member-detail'?state.memberListScrollY:null;state.modal=null;render();if(restore!=null)requestAnimationFrame(()=>window.scrollTo(0,restore));return;}
  const viewEl=event.target.closest('[data-view]'); if(viewEl){navigate(viewEl.dataset.view);return;}
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
  if(action==='delete-payment'){const p=state.data.payments.find(x=>x.id===id);if(p&&confirm('¿Eliminar este pago?')){p.deletedAt=nowISO();p.updatedAt=nowISO();state.modal=null;persist('Pago eliminado.');}return;}
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
  if(action==='disconnect-drive'){await disconnectGoogle();state.token=null;state.sync={kind:'local',text:'Guardado local · Drive sin conectar',lastAt:state.sync.lastAt};render();return;}
  if(action==='export-backup'){exportBackup(state.data,state.account?.email);toast('Respaldo descargado.');return;}
  if(action==='export-legacy'){try{exportLegacyLocalData();toast('Datos anteriores descargados.');}catch(e){toast(e.message,'error');}return;}
  if(action==='install-app'&&installPrompt){installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;render();return;}
});

app.addEventListener('click', event => {
  const method=event.target.closest('[data-payment-method]'); if(method&&state.modal?.type==='payment'){state.modal.draft.method=method.dataset.paymentMethod;render();return;}
  const saleMethod=event.target.closest('[data-sale-method]'); if(saleMethod&&state.modal?.type==='sale'){state.modal.draft.method=saleMethod.dataset.saleMethod;render();return;}
  const filter=event.target.closest('[data-member-filter]'); if(filter){state.memberFilter=filter.dataset.memberFilter;render();return;}
  const productFilter=event.target.closest('[data-product-filter]'); if(productFilter){state.cantinaProductFilter=productFilter.dataset.productFilter;render();}
});

app.addEventListener('input', event => {
  const id=event.target.id, caret=event.target.selectionStart;
  if(id==='member-search'){state.memberQuery=event.target.value;rerenderFocused(id,caret);return;}
  if(id==='payment-search'){state.paymentQuery=event.target.value;rerenderFocused(id,caret);return;}
  if(id==='fee-search'){state.feeQuery=event.target.value;rerenderFocused(id,caret);return;}
  if(id==='cantina-search'){state.cantinaQuery=event.target.value;rerenderFocused(id,caret);return;}
  if(event.target.dataset.memberPicker&&state.modal){state.modal.draft.memberQuery=event.target.value;state.modal.draft.memberId='';state.modal.draft.memberPickerOpen=true;rerenderFocused(id,caret);return;}
  if(id==='payment-amount'&&state.modal?.type==='payment'){state.modal.draft.amount=Number(event.target.value||0);rerenderFocused(id,caret);return;}
  if(id==='sale-quantity'&&state.modal?.type==='sale'){state.modal.draft.quantity=Number(event.target.value||1);rerenderFocused(id,caret);return;}
  if(id==='sale-unit-price'&&state.modal?.type==='sale'){state.modal.draft.unitPrice=Number(event.target.value||0);rerenderFocused(id,caret);return;}
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
  if(event.target.id==='backup-file'&&event.target.files?.[0]){if(!confirm('¿Importar estos datos en la cuenta actual?')){event.target.value='';return;}try{state.data=await importBackup(event.target.files[0],state.account?.email);render();toast('Datos importados.');scheduleSync();}catch(e){toast(e.message||'No se pudo importar.','error');}return;}
});

app.addEventListener('submit', event => {
  event.preventDefault();
  if(event.target.id==='payment-form'){
    const fd=new FormData(event.target),months=state.modal.id?1:Number(fd.get('months')||1);
    const baseDraft={memberId:String(fd.get('memberId')||''),period:String(fd.get('period')||''),paidAt:String(fd.get('paidAt')||''),amount:Number(fd.get('amount')),method:String(fd.get('method')||'cash'),note:String(fd.get('note')||'').trim()};
    const member=getMember(baseDraft.memberId); let errors=[];
    if(months===1) errors=validatePayment(state.data,baseDraft,state.modal.id);
    else if(!member) errors=['Elegí un socio.'];
    else {
      if(!/^\d{4}-\d{2}$/.test(baseDraft.period)) errors.push('Elegí el mes inicial.');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(baseDraft.paidAt)) errors.push('Elegí la fecha de cobro.');
      if(!errors.length) {
        const due=paymentDue(member,baseDraft.period,months,null);
        if(due.total<=0) errors.push('Esos meses ya están pagos.');
      }
    }
    if(errors.length){state.modal.draft={...state.modal.draft,...baseDraft,months};state.modal.errors=errors;render();return;}
    const timestamp=nowISO(),paidAt=`${baseDraft.paidAt}T12:00:00`;
    if(state.modal.id){const p=state.data.payments.find(x=>x.id===state.modal.id);Object.assign(p,baseDraft,{paidAt,updatedAt:timestamp});}
    else if(months===1){state.data.payments.push({id:uid('p'),...baseDraft,paidAt,createdAt:timestamp,updatedAt:timestamp,deletedAt:null,source:'app'});}
    else {
      const batchId=uid('batch'); const due=paymentDue(member,baseDraft.period,months,null);
      due.rows.filter(x=>x.remaining>0).forEach(x=>state.data.payments.push({id:uid('p'),memberId:baseDraft.memberId,period:x.period,amount:x.remaining,method:baseDraft.method,paidAt,note:baseDraft.note,batchId,createdAt:timestamp,updatedAt:timestamp,deletedAt:null,source:'app'}));
    }
    state.data.settings.lastPaymentMethod=baseDraft.method;state.data.settings.updatedAt=timestamp;state.modal=null;persist(months>1?'Meses cobrados y guardados.':'Pago guardado.');return;
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
window.addEventListener('online',()=>{state.sync={...state.sync,kind:'local',text:'Conexión recuperada'};render();scheduleSync();});
window.addEventListener('offline',()=>{state.sync={...state.sync,kind:'offline',text:'Sin conexión · guardado local'};render();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')scheduleSync();});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;render();});
window.addEventListener('appinstalled',()=>{installPrompt=null;toast('Aplicación instalada en esta PC.');});

if(import.meta.env?.DEV && 'serviceWorker' in navigator){
  // Evita que una PWA vieja instalada en localhost siga sirviendo JS anterior durante desarrollo.
  navigator.serviceWorker.getRegistrations().then(rows=>Promise.all(rows.map(r=>r.unregister()))).catch(()=>{});
  if('caches' in window) caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('north-south-')).map(k=>caches.delete(k)))).catch(()=>{});
}
if(import.meta.env?.PROD&&'serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(console.warn);
render();

window.addEventListener('storage', event => {
  if (!state.account?.email || event.key !== dataKeyFor(state.account.email) || !event.newValue || state.modal) return;
  try { state.data = loadData(state.account.email); render(); } catch { /* conserva la copia actual */ }
});

async function bootstrapSession() {
  if (!state.account || !clientId() || !navigator.onLine) return;
  try {
    const token = await restoreGoogleToken(clientId());
    if (token) { state.token = token; await syncNow(false); }
  } catch { /* la app local sigue funcionando */ }
}
bootstrapSession();
