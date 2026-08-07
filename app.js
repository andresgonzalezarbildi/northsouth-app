(() => {
  "use strict";

  const DATA = window.PLAN_DATA;
  if (!DATA) throw new Error("No se pudo cargar data.js");

  const STORAGE_KEY = "semester_schedule_2026_v3";
  const DRIVE_CONFIG = window.GOOGLE_DRIVE_SYNC_CONFIG || {};
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  const DRIVE_FILE_NAME = String(DRIVE_CONFIG.fileName || "cronograma-semestre-2026.json");
  const DRIVE_MIGRATION_KEY = `${STORAGE_KEY}_drive_migrated`;
  const DRIVE_SYNC_DELAY_MS = 650;
  const DRIVE_PULL_INTERVAL_MS = 12000;
  const DRIVE_FUNCTION_BASE = "/.netlify/functions";
  const DELIVERABLE_TYPES = new Set([
    "practical",
    "questionnaire",
    "workshop",
    "assignment-published",
    "deadline",
    "monitoring",
    "defense"
  ]);
  const IMPORTANT_TYPES = new Set(["control", "partial", "deadline", "defense", "assignment-published"]);
  const INFORMATIONAL_TYPES = new Set(["holiday", "no-class", "partial-window", "notice"]);
  const COMPLETION_DELAY_MS = 5000;

  const elements = {
    subjectOverview: document.querySelector("#subjectOverview"),
    completedCount: document.querySelector("#completedCount"),
    pendingCount: document.querySelector("#pendingCount"),
    weekCount: document.querySelector("#weekCount"),
    nextDeadline: document.querySelector("#nextDeadline"),
    progressBar: document.querySelector("#progressBar"),
    timeline: document.querySelector("#timeline"),
    undatedSection: document.querySelector("#undatedSection"),
    undatedList: document.querySelector("#undatedList"),
    undatedCount: document.querySelector("#undatedCount"),
    emptyState: document.querySelector("#emptyState"),
    filters: document.querySelector("#filters"),
    searchInput: document.querySelector("#searchInput"),
    addButton: document.querySelector("#addButton"),
    driveSync: document.querySelector("#driveSync"),
    driveStatus: document.querySelector("#driveStatus"),
    driveButton: document.querySelector("#driveButton"),
    driveDisconnectButton: document.querySelector("#driveDisconnectButton"),
    driveAccount: document.querySelector("#driveAccount"),
    driveMenuButton: document.querySelector("#driveMenuButton"),
    driveMenu: document.querySelector("#driveMenu"),
    taskDialog: document.querySelector("#taskDialog"),
    taskForm: document.querySelector("#taskForm"),
    taskDialogTitle: document.querySelector("#taskDialogTitle"),
    taskId: document.querySelector("#taskId"),
    taskTitle: document.querySelector("#taskTitle"),
    taskSubject: document.querySelector("#taskSubject"),
    taskType: document.querySelector("#taskType"),
    taskWeek: document.querySelector("#taskWeek"),
    taskEventDate: document.querySelector("#taskEventDate"),
    taskDetails: document.querySelector("#taskDetails"),
    deleteButton: document.querySelector("#deleteButton"),
    cancelDialogButton: document.querySelector("#cancelDialogButton"),
    completedJumpButton: document.querySelector("#completedJumpButton"),
    topButton: document.querySelector("#topButton"),
    toast: document.querySelector("#toast")
  };

  let activeFilter = "all";
  let currentStorageKey = STORAGE_KEY;
  let state = loadState(currentStorageKey);
  let dirtyItems = readDirtyItems(currentStorageKey);
  let mutationSequence = 0;
  let activeDrag = null;
  let toastTimer = null;
  const pendingCompletionIds = new Set();
  const completionTimers = new Map();
  const weekOpenOverrides = new Map();
  let completedZoneOpen = false;
  let completedUndatedOpen = false;
  const drive = {
    codeClient: null,
    connected: false,
    syncing: false,
    syncAgain: false,
    syncTimer: null,
    fileId: "",
    user: null,
    storageKey: "",
    hadAccountState: false,
    legacyCandidate: null,
    pullTimer: null
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function validTimestamp(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
  }

  function nowTimestamp() {
    return new Date().toISOString();
  }

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function dirtyStorageKey(storageKey = currentStorageKey) {
    return `${storageKey}_drive_dirty`;
  }

  function readDirtyItems(storageKey = currentStorageKey) {
    const raw = safeStorageGet(dirtyStorageKey(storageKey));
    if (!raw) return new Map();
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
      return new Map(Object.entries(parsed).filter(([id, token]) => id && typeof token === "string"));
    } catch {
      return new Map();
    }
  }

  function persistDirtyItems() {
    safeStorageSet(dirtyStorageKey(), JSON.stringify(Object.fromEntries(dirtyItems)));
  }

  function markItemDirty(item) {
    if (!item?.id) return;
    const token = `${Date.now()}-${++mutationSequence}`;
    dirtyItems.set(item.id, token);
    persistDirtyItems();
  }

  function clearSyncedDirty(snapshot) {
    for (const [id, token] of snapshot) {
      if (dirtyItems.get(id) === token) dirtyItems.delete(id);
    }
    persistDirtyItems();
  }

  function finiteOrder(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function validISO(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
  }

  function parseISO(iso) {
    const [year, month, day] = String(iso).split("-").map(Number);
    return new Date(year, month - 1, day, 12, 0, 0);
  }

  function isoFromDate(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function startOfWeekISO(iso) {
    if (!validISO(iso)) return "";
    const date = parseISO(iso);
    const day = date.getDay();
    date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
    return isoFromDate(date);
  }

  function todayISO() {
    return isoFromDate(new Date());
  }

  function addDaysISO(iso, days) {
    if (!validISO(iso)) return "";
    const date = parseISO(iso);
    date.setDate(date.getDate() + days);
    return isoFromDate(date);
  }

  function defaultWeekOpen(week, completed, items = []) {
    if (completed) return true;
    if (elements.searchInput.value.trim() || activeFilter === "current-week") return true;
    const currentWeek = startOfWeekISO(todayISO());
    const nextWeek = addDaysISO(currentWeek, 7);
    if (week === currentWeek || week === nextWeek) return true;
    return week < currentWeek && items.some(isActionable);
  }

  function isWeekOpen(week, completed, items = []) {
    if (elements.searchInput.value.trim() || activeFilter === "current-week") return true;
    const key = `${completed ? "completed" : "pending"}|${week}`;
    return weekOpenOverrides.has(key) ? weekOpenOverrides.get(key) : defaultWeekOpen(week, completed, items);
  }

  function dateLabel(iso, includeYear = false) {
    if (!validISO(iso)) return "";
    return parseISO(iso).toLocaleDateString("es-UY", {
      day: "2-digit",
      month: "2-digit",
      ...(includeYear ? { year: "numeric" } : {})
    });
  }

  function weekLabel(week) {
    return `Semana del ${dateLabel(week)}`;
  }

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function typeLabel(type) {
    return DATA.typeLabels[type] || type;
  }


  function sanitizeItem(item, fallbackId, fallbackOrder = 0) {
    const subject = DATA.subjects[item.subject] ? item.subject : "fuaa";
    const week = validISO(item.week) ? startOfWeekISO(item.week) : "";
    const eventDate = validISO(item.eventDate) ? item.eventDate : "";
    return {
      id: String(item.id || fallbackId),
      week,
      eventDate,
      subject,
      type: String(item.type || "course-class"),
      title: String(item.title || "Elemento sin título").slice(0, 140),
      details: String(item.details || "").slice(0, 500),
      periodLabel: String(item.periodLabel || "").slice(0, 100),
      source: String(item.source || "Agregado manualmente").slice(0, 120),
      fixed: Boolean(item.fixed),
      important: Boolean(item.important),
      priority: ["normal", "high", "critical"].includes(item.priority) ? item.priority : "normal",
      order: finiteOrder(item.order, fallbackOrder),
      updatedAt: validTimestamp(item.updatedAt) ? item.updatedAt : ""
    };
  }

  function seedItems() {
    return DATA.items.map((item, index) => ({
      ...sanitizeItem(item, item.id, index * 10),
      done: false,
      deleted: false,
      edited: false,
      manual: false
    }));
  }

  function initialState() {
    return {
      dataVersion: DATA.version,
      items: seedItems(),
      savedAt: ""
    };
  }

  function stateFromSaved(saved) {
    const fresh = initialState();
    if (!saved || !Array.isArray(saved.items)) return fresh;

    const fallbackUpdatedAt = validTimestamp(saved.savedAt) ? saved.savedAt : "";
    const savedById = new Map(saved.items.map((item) => [String(item.id || ""), item]));
    fresh.items = fresh.items.map((item) => {
      const previous = savedById.get(item.id);
      if (!previous) return item;
      const merged = {
        ...item,
        done: Boolean(previous.done),
        deleted: Boolean(previous.deleted),
        important: Boolean(previous.important),
        order: finiteOrder(previous.order, item.order),
        updatedAt: validTimestamp(previous.updatedAt) ? previous.updatedAt : fallbackUpdatedAt
      };
      if (previous.edited) {
        Object.assign(merged, sanitizeItem(previous, item.id, item.order), {
          edited: true,
          manual: false,
          updatedAt: validTimestamp(previous.updatedAt) ? previous.updatedAt : fallbackUpdatedAt
        });
      }
      return merged;
    });

    const manualItems = saved.items
      .filter((item) => item.manual && item.id)
      .map((item, index) => ({
        ...sanitizeItem(item, item.id, DATA.items.length * 10 + index * 10),
        done: Boolean(item.done),
        deleted: Boolean(item.deleted),
        edited: true,
        manual: true,
        updatedAt: validTimestamp(item.updatedAt) ? item.updatedAt : fallbackUpdatedAt
      }));
    fresh.items.push(...manualItems);
    fresh.savedAt = validTimestamp(saved.savedAt) ? saved.savedAt : "";
    return fresh;
  }

  function readStoredState(storageKey) {
    const raw = safeStorageGet(storageKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && Array.isArray(parsed.items) ? stateFromSaved(parsed) : null;
    } catch {
      return null;
    }
  }

  function loadState(storageKey = currentStorageKey) {
    return readStoredState(storageKey) || initialState();
  }

  function persistLocalState(nextState = state) {
    safeStorageSet(currentStorageKey, JSON.stringify(nextState));
  }

  function saveState(nextState = state, options = {}) {
    nextState.savedAt = nowTimestamp();
    persistLocalState(nextState);
    if (options.sync !== false) scheduleDriveSync();
  }

  function touchItem(item) {
    if (!item) return;
    item.updatedAt = nowTimestamp();
    markItemDirty(item);
  }

  function stateFingerprint(candidate) {
    const items = candidate.items
      .map((item) => ({ ...item }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return JSON.stringify({ dataVersion: candidate.dataVersion, items });
  }

  function mergeStates(localState, remoteState, preferLocalIds = new Set()) {
    const localById = new Map(localState.items.map((item) => [item.id, item]));
    const remoteById = new Map(remoteState.items.map((item) => [item.id, item]));
    const ids = new Set([...localById.keys(), ...remoteById.keys()]);
    const mergedItems = [];

    for (const id of ids) {
      const localItem = localById.get(id);
      const remoteItem = remoteById.get(id);
      if (!localItem) {
        mergedItems.push(clone(remoteItem));
        continue;
      }
      if (!remoteItem) {
        mergedItems.push(clone(localItem));
        continue;
      }
      if (preferLocalIds.has(id)) {
        mergedItems.push(clone(localItem));
        continue;
      }
      const localTime = validTimestamp(localItem.updatedAt) ? localItem.updatedAt : "";
      const remoteTime = validTimestamp(remoteItem.updatedAt) ? remoteItem.updatedAt : "";
      mergedItems.push(clone(remoteTime > localTime ? remoteItem : localItem));
    }

    const savedAt = [localState.savedAt, remoteState.savedAt]
      .filter(validTimestamp)
      .sort()
      .at(-1) || "";
    return stateFromSaved({ dataVersion: DATA.version, items: mergedItems, savedAt });
  }

  function configuredClientId() {
    const clientId = String(DRIVE_CONFIG.clientId || "").trim();
    return clientId.endsWith(".apps.googleusercontent.com") && !clientId.includes("PEGAR_CLIENT_ID");
  }

  function setDriveMenuOpen(open) {
    const shouldOpen = Boolean(open);
    elements.driveMenu.hidden = !shouldOpen;
    elements.driveMenuButton.setAttribute("aria-expanded", String(shouldOpen));
    elements.driveMenuButton.classList.toggle("is-open", shouldOpen);
  }

  function toggleDriveMenu() {
    setDriveMenuOpen(elements.driveMenu.hidden);
  }

  function setDriveStatus(stateName, text) {
    elements.driveStatus.dataset.state = stateName;
    elements.driveStatus.textContent = text;
  }

  async function driveApi(functionName, options = {}) {
    const response = await fetch(`${DRIVE_FUNCTION_BASE}/${functionName}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: {
        "X-Requested-With": "XmlHttpRequest",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });

    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }

    if (!response.ok) {
      const error = new Error(body.error || `La sincronización respondió ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function scheduleDriveSync() {
    if (!drive.connected) return;
    window.clearTimeout(drive.syncTimer);
    setDriveStatus("pending", "Cambios pendientes de sincronizar");
    drive.syncTimer = window.setTimeout(() => syncDriveState(), DRIVE_SYNC_DELAY_MS);
  }

  async function syncDriveState(options = {}) {
    if (!drive.connected) return;
    if (drive.syncing) {
      drive.syncAgain = true;
      return;
    }

    drive.syncing = true;
    drive.syncAgain = false;
    window.clearTimeout(drive.syncTimer);
    if (!options.background) setDriveStatus("syncing", "Sincronizando…");

    const dirtySnapshot = new Map(dirtyItems);
    const localBefore = stateFingerprint(state);

    try {
      const result = await driveApi("drive-sync", {
        method: "POST",
        body: JSON.stringify({
          state,
          dirtyIds: [...dirtySnapshot.keys()]
        })
      });

      const canonical = stateFromSaved(result.state);
      const remoteFingerprint = stateFingerprint(canonical);

      // Si no hubo nuevos cambios mientras la petición estaba en curso, se adopta
      // el estado canónico que devuelve el servidor. Si sí los hubo, primero se
      // mezclan para no borrar una acción que el usuario acaba de hacer.
      const changedDuringSync = [...dirtyItems.entries()].some(([id, token]) => dirtySnapshot.get(id) !== token);
      if (changedDuringSync) {
        state = mergeStates(state, canonical, new Set(dirtyItems.keys()));
      } else if (localBefore !== remoteFingerprint) {
        state = canonical;
      } else {
        state.savedAt = canonical.savedAt || state.savedAt;
      }

      persistLocalState(state);
      clearSyncedDirty(dirtySnapshot);
      render();

      drive.hadAccountState = true;
      drive.legacyCandidate = null;
      safeStorageSet(DRIVE_MIGRATION_KEY, drive.user?.permissionId || drive.user?.emailAddress || "done");

      if (dirtyItems.size) {
        drive.syncAgain = true;
        setDriveStatus("pending", "Hay cambios nuevos pendientes de sincronizar");
      } else {
        setDriveStatus("synced", `Sincronizado · ${new Date().toLocaleTimeString("es-UY", { hour: "2-digit", minute: "2-digit" })}`);
      }
    } catch (error) {
      if (error.status === 401) {
        drive.connected = false;
        stopDrivePulling();
        elements.driveButton.textContent = "Conectar Drive";
        setDriveStatus("warning", "La sesión de Google ya no es válida");
      } else if (!options.background) {
        setDriveStatus("error", "No se pudo sincronizar · los cambios siguen guardados localmente");
      }
      console.error(error);
      if (!options.background) showToast(error.message || "No se pudo sincronizar con Google Drive");
    } finally {
      drive.syncing = false;
      if (drive.syncAgain && drive.connected) syncDriveState();
    }
  }

  function accountStorageKey(user) {
    const accountId = String(user.permissionId || user.emailAddress || "google").replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${STORAGE_KEY}_google_${accountId}`;
  }

  function startDrivePulling() {
    stopDrivePulling();
    drive.pullTimer = window.setInterval(() => {
      if (drive.connected && document.visibilityState === "visible") {
        syncDriveState({ background: true });
      }
    }, DRIVE_PULL_INTERVAL_MS);
  }

  function stopDrivePulling() {
    if (drive.pullTimer) window.clearInterval(drive.pullTimer);
    drive.pullTimer = null;
  }

  async function activateDriveSession(user, options = {}) {
    drive.connected = true;
    drive.user = user || {};
    drive.storageKey = accountStorageKey(drive.user);

    const accountState = readStoredState(drive.storageKey);
    const anonymousState = readStoredState(STORAGE_KEY);
    const alreadyMigrated = Boolean(safeStorageGet(DRIVE_MIGRATION_KEY));
    drive.hadAccountState = Boolean(accountState);
    drive.legacyCandidate = !accountState && !alreadyMigrated ? anonymousState : null;

    currentStorageKey = drive.storageKey;
    state = accountState || drive.legacyCandidate || initialState();
    dirtyItems = readDirtyItems(currentStorageKey);
    persistLocalState(state);

    const accountLabel = drive.user.emailAddress || drive.user.displayName || "Cuenta de Google";
    elements.driveAccount.textContent = accountLabel;
    elements.driveAccount.hidden = false;
    elements.driveDisconnectButton.hidden = false;
    elements.driveButton.textContent = "Sincronizar ahora";
    setDriveStatus("synced", "Sesión de Google activa");
    render();
    startDrivePulling();

    if (options.sync !== false) await syncDriveState();
  }

  async function finishCodeConnection(response) {
    if (response.error || !response.code) {
      throw new Error(response.error_description || response.error || "Google no devolvió un código de autorización válido");
    }

    setDriveStatus("syncing", "Guardando sesión de Google…");
    const result = await driveApi("drive-auth", {
      method: "POST",
      body: JSON.stringify({
        code: response.code,
        redirectUri: location.origin
      })
    });
    await activateDriveSession(result.user);
  }

  async function loadDriveRuntimeConfig() {
    try {
      const result = await driveApi("drive-config", { method: "GET" });
      if (result.clientId) DRIVE_CONFIG.clientId = String(result.clientId).trim();
      return configuredClientId();
    } catch (error) {
      console.error(error);
      setDriveStatus("warning", "No se pudo leer la configuración de Google");
      return false;
    }
  }

  function initializeDriveClient() {
    if (!configuredClientId()) {
      elements.driveButton.textContent = "Configurar Drive";
      setDriveStatus("warning", "Falta pegar el Client ID");
      return false;
    }
    if (location.protocol === "file:") {
      setDriveStatus("warning", "Drive requiere publicar el sitio en Netlify");
      return false;
    }
    if (!window.google?.accounts?.oauth2) {
      setDriveStatus("error", "No se cargó Google Identity Services");
      return false;
    }
    if (!drive.codeClient) {
      drive.codeClient = google.accounts.oauth2.initCodeClient({
        client_id: DRIVE_CONFIG.clientId,
        scope: DRIVE_SCOPE,
        ux_mode: "popup",
        callback: (response) => {
          setDriveStatus("syncing", "Conectando con tu cuenta…");
          finishCodeConnection(response).catch((error) => {
            drive.connected = false;
            setDriveStatus("error", "No se pudo conectar Google Drive");
            showToast(error.message || "No se pudo conectar Google Drive");
          });
        },
        error_callback: () => {
          setDriveStatus("local", "Conexión cancelada · sigue guardado localmente");
        }
      });
    }
    return true;
  }

  async function restoreDriveSession() {
    if (!configuredClientId() || location.protocol === "file:") return;
    setDriveStatus("syncing", "Recuperando sesión…");
    try {
      const result = await driveApi("drive-session", { method: "GET" });
      if (result.authenticated && result.user) {
        await activateDriveSession(result.user);
      }
    } catch (error) {
      if (error.status === 401) {
        setDriveStatus("local", "Conectar Google Drive");
        elements.driveButton.textContent = "Conectar Drive";
        return;
      }
      setDriveStatus("warning", "No se pudo comprobar la sesión");
      console.error(error);
    }
  }

  function connectOrSyncDrive() {
    if (drive.connected) {
      syncDriveState();
      return;
    }
    if (!initializeDriveClient()) {
      showToast(configuredClientId()
        ? "Publicá el cronograma mediante Netlify para usar la sesión persistente"
        : "Revisá GOOGLE_CLIENT_ID en las variables de entorno de Netlify");
      return;
    }
    setDriveStatus("syncing", "Esperando autorización…");
    drive.codeClient.requestCode();
  }

  async function disconnectDrive() {
    setDriveMenuOpen(false);
    window.clearTimeout(drive.syncTimer);
    stopDrivePulling();

    try {
      await driveApi("drive-logout", { method: "POST", body: "{}" });
    } catch (error) {
      console.error(error);
    }

    Object.assign(drive, {
      connected: false,
      syncing: false,
      syncAgain: false,
      fileId: "",
      user: null,
      storageKey: "",
      hadAccountState: false,
      legacyCandidate: null
    });
    currentStorageKey = STORAGE_KEY;
    state = loadState(currentStorageKey);
    dirtyItems = readDirtyItems(currentStorageKey);
    elements.driveAccount.hidden = true;
    elements.driveDisconnectButton.hidden = true;
    elements.driveButton.textContent = configuredClientId() ? "Conectar Drive" : "Configurar Drive";
    setDriveStatus("local", "Sesión cerrada manualmente");
    render();
  }

  function isActionable(item) {
    return !INFORMATIONAL_TYPES.has(item.type);
  }

  function itemDateForSorting(item) {
    return item.eventDate || item.week || "9999-12-31";
  }

  function compareItems(a, b) {
    return (a.week || "9999-12-31").localeCompare(b.week || "9999-12-31")
      || finiteOrder(a.order) - finiteOrder(b.order)
      || itemDateForSorting(a).localeCompare(itemDateForSorting(b))
      || a.id.localeCompare(b.id);
  }

  function itemMatchesSearch(item, query) {
    if (!query) return true;
    const subject = DATA.subjects[item.subject]?.name || "";
    const haystack = `${item.title} ${item.details} ${item.periodLabel} ${item.source} ${subject} ${typeLabel(item.type)}`.toLocaleLowerCase("es");
    return haystack.includes(query);
  }

  function itemMatchesFilter(item) {
    if (item.deleted) return false;
    if (activeFilter === "all") return true;
    if (activeFilter === "current-week") return item.week === startOfWeekISO(todayISO());
    if (activeFilter === "deliverables") return DELIVERABLE_TYPES.has(item.type);
    return item.subject === activeFilter;
  }

  function visibleItems() {
    const query = elements.searchInput.value.trim().toLocaleLowerCase("es");
    return state.items.filter(itemMatchesFilter).filter((item) => itemMatchesSearch(item, query)).sort(compareItems);
  }

  function render() {
    renderSubjectOverview();
    renderSummary();
    renderTimeline();
    renderUndated();
    updateControls();
  }

  function renderSubjectOverview() {
    elements.subjectOverview.replaceChildren();
    Object.entries(DATA.subjects).forEach(([key, subject]) => {
      const subjectItems = state.items.filter((item) => item.subject === key && !item.deleted);
      const actionable = subjectItems.filter(isActionable);
      const pending = actionable.filter((item) => !item.done);
      const deliverables = pending.filter((item) => DELIVERABLE_TYPES.has(item.type));
      const datedWeeks = new Set(subjectItems.filter((item) => item.week).map((item) => item.week));
      const today = todayISO();
      const next = subjectItems
        .filter((item) => !item.done && itemDateForSorting(item) >= today && (item.important || IMPORTANT_TYPES.has(item.type)))
        .sort((a, b) => itemDateForSorting(a).localeCompare(itemDateForSorting(b)))[0];

      const card = document.createElement("button");
      card.type = "button";
      card.className = `subject-card ${activeFilter === key ? "active" : ""}`;
      card.style.setProperty("--subject", subject.color);
      card.innerHTML = `
        <span class="subject-card__short">${escapeHtml(subject.short)}</span>
        <strong>${escapeHtml(subject.name)}</strong>
        <small>${escapeHtml(subject.status)}</small>
        <div class="subject-card__meta">
          <span>${pending.length} pendientes</span>
          <span>${deliverables.length} entregas/lab.</span>
          <span>${datedWeeks.size} semanas</span>
        </div>
        <p>${next ? `${dateLabel(itemDateForSorting(next))} · ${escapeHtml(next.title)}` : "Sin próxima fecha publicada"}</p>
      `;
      card.addEventListener("click", () => {
        activeFilter = key;
        render();
      });
      elements.subjectOverview.append(card);
    });
  }

  function renderSummary() {
    const actionable = state.items.filter((item) => !item.deleted && isActionable(item));
    const completed = actionable.filter((item) => item.done);
    const pending = actionable.filter((item) => !item.done);
    const currentWeek = startOfWeekISO(todayISO());
    const weekItems = pending.filter((item) => item.week === currentWeek);
    const today = todayISO();
    const nextImportant = pending
      .filter((item) => (item.eventDate || item.week) >= today && (item.important || IMPORTANT_TYPES.has(item.type)))
      .sort((a, b) => itemDateForSorting(a).localeCompare(itemDateForSorting(b)) || finiteOrder(a.order) - finiteOrder(b.order))[0];

    elements.completedCount.textContent = `${completed.length}/${actionable.length}`;
    elements.pendingCount.textContent = String(pending.length);
    elements.weekCount.textContent = String(weekItems.length);
    elements.nextDeadline.textContent = nextImportant
      ? `${dateLabel(itemDateForSorting(nextImportant))} · ${nextImportant.title}`
      : "—";
    elements.progressBar.style.width = `${actionable.length ? Math.round(completed.length / actionable.length * 100) : 0}%`;
  }

  function renderTimeline() {
    const dated = visibleItems().filter((item) => item.week);
    const pending = dated.filter((item) => !item.done || pendingCompletionIds.has(item.id));
    const completed = dated.filter((item) => item.done && !pendingCompletionIds.has(item.id));
    elements.timeline.replaceChildren();

    if (pending.length) elements.timeline.append(createTimelineZone(pending, false));
    if (completed.length) elements.timeline.append(createTimelineZone(completed, true));
  }

  function createTimelineZone(items, completed) {
    const zone = document.createElement(completed ? "details" : "section");
    zone.className = `timeline-zone ${completed ? "timeline-zone--completed" : "timeline-zone--pending"}`;
    if (completed) {
      zone.id = "completedTimeline";
      zone.open = completedZoneOpen;
      zone.innerHTML = `
        <summary class="timeline-zone__heading timeline-zone__heading--toggle">
          <div>
            <p>Historial</p>
            <h2>Completadas</h2>
          </div>
          <span class="timeline-zone__heading-side">
            <span>${items.length} ${items.length === 1 ? "elemento" : "elementos"}</span>
            <strong class="collapse-sign" aria-hidden="true"></strong>
          </span>
        </summary>
        <div class="timeline-zone__weeks"></div>
      `;
      zone.addEventListener("toggle", () => { completedZoneOpen = zone.open; });
    } else {
      zone.innerHTML = `
        <header class="timeline-zone__heading">
          <div>
            <p>Cronogramas</p>
            <h2>Pendientes</h2>
          </div>
          <span>${items.length} ${items.length === 1 ? "elemento" : "elementos"}</span>
        </header>
        <div class="timeline-zone__weeks"></div>
      `;
    }

    const weeksNode = zone.querySelector(".timeline-zone__weeks");
    const groups = new Map();
    items.forEach((item) => {
      if (!groups.has(item.week)) groups.set(item.week, []);
      groups.get(item.week).push(item);
    });

    for (const [week, weekItems] of groups) {
      if (!weekItems.length) continue;
      const subjects = new Set(weekItems.map((item) => item.subject));
      const labels = [...new Set(weekItems.map((item) => item.periodLabel).filter(Boolean))];
      const headingLabel = labels.length === 1 && weekItems.every((item) => item.periodLabel === labels[0])
        ? labels[0]
        : weekLabel(week);
      const section = document.createElement("details");
      section.className = "week-section";
      section.open = isWeekOpen(week, completed, weekItems);
      section.innerHTML = `
        <summary class="week-heading">
          <span class="week-heading__main">
            <span class="week-heading__label">${escapeHtml(headingLabel)}</span>
            <span class="week-heading__count">${weekItems.length} ${weekItems.length === 1 ? "elemento" : "elementos"}</span>
          </span>
          <span class="week-heading__side">
            <span>${subjects.size} ${subjects.size === 1 ? "materia" : "materias"}</span>
            <strong class="collapse-sign" aria-hidden="true"></strong>
          </span>
        </summary>
        <div class="week-items" data-group="${completed ? "completed" : "pending"}|${week}" data-week="${week}" data-completed="${completed ? "true" : "false"}"></div>
      `;
      const overrideKey = `${completed ? "completed" : "pending"}|${week}`;
      section.addEventListener("toggle", () => { weekOpenOverrides.set(overrideKey, section.open); });
      const container = section.querySelector(".week-items");
      weekItems.forEach((item) => container.append(createItemCard(item, true)));
      weeksNode.append(section);
    }
    return zone;
  }

  function createItemCard(item, draggable) {
    const subject = DATA.subjects[item.subject];
    const article = document.createElement("article");
    const isCompleting = pendingCompletionIds.has(item.id);
    article.className = `task-card ${item.done ? "done" : ""} ${isCompleting ? "is-completing" : ""} ${item.important ? "is-important" : ""} priority-${item.priority}`;
    article.style.setProperty("--subject", subject.color);
    article.dataset.id = item.id;

    const checkDisabled = INFORMATIONAL_TYPES.has(item.type);
    article.innerHTML = `
      <div class="task-kind" aria-hidden="true" title="${escapeHtml(subject.name)}">
        <strong>${escapeHtml(subject.short)}</strong>
        <small>${escapeHtml(subject.name)}</small>
      </div>
      <label class="task-check ${checkDisabled ? "task-check--disabled" : ""}" title="${checkDisabled ? "Elemento informativo" : "Marcar como completado"}">
        <input type="checkbox" ${item.done ? "checked" : ""} ${checkDisabled ? "disabled" : ""}>
        <span></span>
      </label>
      <div class="task-content">
        <div class="task-meta">
          <span class="subject-badge">${escapeHtml(subject.short)}</span>
          <span>${escapeHtml(typeLabel(item.type))}</span>
          <span>${item.fixed ? "cronograma oficial" : "agregado manualmente"}</span>
          ${item.eventDate ? `<span class="exact-date">fecha ${dateLabel(item.eventDate)}</span>` : ""}
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        ${item.details ? `<p>${escapeHtml(item.details)}</p>` : ""}
        ${item.source ? `<small class="task-source">${escapeHtml(item.source)}</small>` : ""}
        ${isCompleting ? `<span class="completion-delay">Pasa a completadas en unos segundos · podés desmarcarla</span>` : ""}
      </div>
      <div class="task-actions">
        <button class="task-important" type="button" aria-pressed="${item.important}" aria-label="${item.important ? "Quitar importancia" : "Marcar como importante"}" title="${item.important ? "Quitar importancia" : "Marcar como importante"}">★</button>
        <button class="task-edit" type="button" aria-label="Editar ${escapeHtml(item.title)}">Editar</button>
        ${draggable ? `<button class="task-drag-handle" type="button" aria-label="Reordenar ${escapeHtml(item.title)}" title="Mantener presionado y arrastrar">⋮⋮</button>` : ""}
      </div>
    `;

    const checkbox = article.querySelector("input[type=checkbox]");
    if (!checkDisabled) {
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          item.done = true;
          touchItem(item);
          saveState();
          scheduleCompletionMove(item, article);
          renderSubjectOverview();
          renderSummary();
          updateControls();
          return;
        }

        const wasWaiting = pendingCompletionIds.has(item.id);
        cancelCompletionMove(item.id);
        item.done = false;
        touchItem(item);
        saveState();
        if (wasWaiting) {
          article.classList.remove("done", "is-completing");
          article.querySelector(".completion-delay")?.remove();
          renderSubjectOverview();
          renderSummary();
          updateControls();
        } else {
          render();
        }
      });
    }

    article.querySelector(".task-important").addEventListener("click", () => {
      item.important = !item.important;
      touchItem(item);
      saveState();
      render();
      showToast(item.important ? "Marcado como importante" : "Importancia quitada");
    });
    article.querySelector(".task-edit").addEventListener("click", () => openTaskDialog(item.id));
    if (draggable) installCardDragging(article);
    return article;
  }

  function scheduleCompletionMove(item, article) {
    cancelCompletionMove(item.id);
    pendingCompletionIds.add(item.id);
    article.classList.add("done", "is-completing");
    if (!article.querySelector(".completion-delay")) {
      const notice = document.createElement("span");
      notice.className = "completion-delay";
      notice.textContent = "Pasa a completadas en unos segundos · podés desmarcarla";
      article.querySelector(".task-content")?.append(notice);
    }

    const timer = window.setTimeout(() => {
      completionTimers.delete(item.id);
      pendingCompletionIds.delete(item.id);
      render();
    }, COMPLETION_DELAY_MS);
    completionTimers.set(item.id, timer);
  }

  function cancelCompletionMove(itemId) {
    const timer = completionTimers.get(itemId);
    if (timer) window.clearTimeout(timer);
    completionTimers.delete(itemId);
    pendingCompletionIds.delete(itemId);
  }


  function installCardDragging(card) {
    const handle = card.querySelector(".task-drag-handle");
    handle.addEventListener("pointerdown", (event) => prepareCardDrag(card, event, true));
    card.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse") return;
      if (event.target.closest("button, input, label, a, textarea, select")) return;
      prepareCardDrag(card, event, false);
    });
  }

  function prepareCardDrag(card, event, forceHandle) {
    if (activeDrag || event.button !== 0) return;
    if (forceHandle) event.preventDefault();
    const sourceContainer = card.closest(".week-items");
    if (!sourceContainer) return;

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    let ghost = null;
    let timer = null;

    const clearListeners = () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", onMove, { capture: true });
      window.removeEventListener("pointerup", onEnd, { capture: true });
      window.removeEventListener("pointercancel", onEnd, { capture: true });
    };

    const begin = (currentEvent) => {
      if (started || activeDrag) return;
      started = true;
      const rect = card.getBoundingClientRect();
      ghost = card.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      document.body.append(ghost);
      activeDrag = {
        card,
        ghost,
        sourceContainer,
        group: sourceContainer.dataset.group,
        offsetX: Math.min(Math.max(startX - rect.left, 20), rect.width - 20),
        offsetY: Math.min(Math.max(startY - rect.top, 20), rect.height - 20)
      };
      card.classList.add("is-dragging");
      document.body.classList.add("dragging-card");
      updateDragGhost(currentEvent || event);
    };

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!started) {
        if (distance <= (forceHandle ? 8 : 10)) return;
        begin(moveEvent);
      }
      moveEvent.preventDefault();
      updateDragGhost(moveEvent);
      reorderCardAtPoint(moveEvent.clientX, moveEvent.clientY);
    };

    const onEnd = (endEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      clearListeners();
      if (!started) return;
      endEvent.preventDefault();
      persistRenderedOrder(card.closest(".week-items"));
      cleanupDrag();
      saveState();
      render();
      showToast("Orden actualizado");
    };

    timer = setTimeout(() => begin(event), forceHandle ? 120 : 190);
    window.addEventListener("pointermove", onMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onEnd, { capture: true, passive: false });
    window.addEventListener("pointercancel", onEnd, { capture: true, passive: false });
  }

  function updateDragGhost(event) {
    if (!activeDrag) return;
    activeDrag.ghost.style.transform = `translate3d(${event.clientX - activeDrag.offsetX}px, ${event.clientY - activeDrag.offsetY}px, 0)`;
  }

  function reorderCardAtPoint(clientX, clientY) {
    if (!activeDrag) return;
    const target = document.elementFromPoint(clientX, clientY);
    const container = target?.closest(".week-items");
    if (!container || container.dataset.group !== activeDrag.group) return;
    const candidates = [...container.querySelectorAll(".task-card:not(.is-dragging)")];
    const next = candidates.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    if (next) container.insertBefore(activeDrag.card, next);
    else container.append(activeDrag.card);
  }

  function cleanupDrag() {
    if (!activeDrag) return;
    activeDrag.card.classList.remove("is-dragging");
    activeDrag.ghost.remove();
    document.body.classList.remove("dragging-card");
    activeDrag = null;
  }

  function persistRenderedOrder(container) {
    if (!container) return;
    const week = container.dataset.week;
    const completed = container.dataset.completed === "true";
    const displayedIds = [...container.querySelectorAll(".task-card")].map((card) => card.dataset.id);
    const displayedSet = new Set(displayedIds);
    const fullGroup = state.items
      .filter((item) => !item.deleted && item.week === week && Boolean(item.done) === completed)
      .sort(compareItems);
    const slots = fullGroup.map((item, index) => displayedSet.has(item.id) ? index : -1).filter((index) => index >= 0);
    if (slots.length !== displayedIds.length) return;
    const byId = new Map(fullGroup.map((item) => [item.id, item]));
    const reordered = [...fullGroup];
    slots.forEach((slot, index) => { reordered[slot] = byId.get(displayedIds[index]); });
    reordered.forEach((item, index) => {
      const nextOrder = index * 10;
      if (item.order !== nextOrder) {
        item.order = nextOrder;
        touchItem(item);
      }
    });
  }

  function renderUndated() {
    const undated = visibleItems().filter((item) => !item.week);
    const pending = undated.filter((item) => !item.done || pendingCompletionIds.has(item.id));
    const completed = undated.filter((item) => item.done && !pendingCompletionIds.has(item.id));
    elements.undatedList.replaceChildren();
    elements.undatedCount.textContent = `${undated.length} ${undated.length === 1 ? "elemento" : "elementos"}`;

    if (pending.length) elements.undatedList.append(createUndatedGroup("Pendientes", pending));
    if (completed.length) elements.undatedList.append(createUndatedGroup("Completadas", completed, true));
    elements.undatedSection.hidden = undated.length === 0;

    const hasVisible = visibleItems().length > 0;
    elements.emptyState.hidden = hasVisible;
  }

  function createUndatedGroup(title, items, completed = false) {
    if (!completed) {
      const section = document.createElement("section");
      section.className = "undated-group";
      section.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="undated-items"></div>`;
      const list = section.querySelector(".undated-items");
      items.forEach((item) => list.append(createItemCard(item, false)));
      return section;
    }

    const section = document.createElement("details");
    section.className = "undated-group undated-group--completed";
    section.id = "completedUndated";
    section.open = completedUndatedOpen;
    section.innerHTML = `
      <summary class="undated-group__heading">
        <span>${escapeHtml(title)} · ${items.length}</span>
        <strong class="collapse-sign" aria-hidden="true"></strong>
      </summary>
      <div class="undated-items"></div>
    `;
    section.addEventListener("toggle", () => { completedUndatedOpen = section.open; });
    const list = section.querySelector(".undated-items");
    items.forEach((item) => list.append(createItemCard(item, false)));
    return section;
  }

  function updateControls() {
    elements.filters.querySelectorAll("button[data-filter]").forEach((button) => {
      button.classList.toggle("active", button.dataset.filter === activeFilter);
    });
    const completedVisible = visibleItems().filter((item) => item.done && !pendingCompletionIds.has(item.id)).length;
    elements.completedJumpButton.textContent = `✓ Completadas${completedVisible ? ` · ${completedVisible}` : ""}`;
    elements.completedJumpButton.classList.toggle("is-empty", completedVisible === 0);
  }

  function nextOrderForGroup(week, completed = false) {
    const orders = state.items
      .filter((item) => !item.deleted && item.week === week && Boolean(item.done) === completed)
      .map((item) => finiteOrder(item.order));
    return (orders.length ? Math.max(...orders) : state.items.length * 10) + 10;
  }

  function openTaskDialog(itemId = null, defaults = {}) {
    const item = itemId ? state.items.find((candidate) => candidate.id === itemId) : null;
    elements.taskForm.reset();
    elements.taskId.value = item?.id || "";
    elements.taskDialogTitle.textContent = item ? "Editar elemento" : "Agregar elemento";
    elements.taskTitle.value = item?.title || defaults.title || "";
    elements.taskSubject.value = item?.subject || defaults.subject || "fuaa";
    elements.taskType.value = item?.type || defaults.type || "course-class";
    elements.taskWeek.value = item?.week || defaults.week || "";
    elements.taskEventDate.value = item?.eventDate || defaults.eventDate || "";
    elements.taskDetails.value = item?.details || defaults.details || "";
    elements.deleteButton.hidden = !item;
    elements.taskDialog.showModal();
    requestAnimationFrame(() => elements.taskTitle.focus());
  }

  function saveTaskFromForm() {
    const existingId = elements.taskId.value;
    const existing = state.items.find((item) => item.id === existingId);
    const week = elements.taskWeek.value ? startOfWeekISO(elements.taskWeek.value) : "";
    const type = elements.taskType.value;
    const values = sanitizeItem({
      id: existingId || `manual-${Date.now()}`,
      week,
      eventDate: elements.taskEventDate.value,
      subject: elements.taskSubject.value,
      type,
      title: elements.taskTitle.value.trim(),
      details: elements.taskDetails.value.trim(),
      source: existingId ? existing?.source || "Ajuste manual" : "Agregado manualmente",
      fixed: existing ? existing.fixed : false,
      important: existing?.important || IMPORTANT_TYPES.has(type),
      priority: IMPORTANT_TYPES.has(type) ? "critical" : DELIVERABLE_TYPES.has(type) ? "high" : "normal",
      order: existing && existing.week === week ? existing.order : nextOrderForGroup(week, existing?.done || false)
    }, existingId || `manual-${Date.now()}`, nextOrderForGroup(week));
    if (!values.title) return;

    if (existing) {
      Object.assign(existing, values, { edited: true });
      touchItem(existing);
    } else {
      const createdItem = { ...values, done: false, deleted: false, edited: true, manual: true, updatedAt: nowTimestamp() };
      state.items.push(createdItem);
      markItemDirty(createdItem);
    }
    saveState();
    elements.taskDialog.close();
    render();
    showToast(existing ? "Elemento actualizado" : "Elemento agregado");
  }

  function deleteCurrentTask() {
    const item = state.items.find((candidate) => candidate.id === elements.taskId.value);
    if (!item) return;
    item.deleted = true;
    touchItem(item);
    saveState();
    elements.taskDialog.close();
    render();
    showToast("Elemento eliminado");
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2400);
  }

  elements.filters.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;
    activeFilter = button.dataset.filter;
    render();
  });
  elements.searchInput.addEventListener("input", render);
  elements.completedJumpButton.addEventListener("click", () => {
    const hasDated = Boolean(document.querySelector(".timeline-zone--completed"));
    const hasUndated = Boolean(document.querySelector(".undated-group--completed"));
    if (!hasDated && !hasUndated) {
      showToast("No hay actividades completadas en esta vista");
      return;
    }
    completedZoneOpen = hasDated;
    completedUndatedOpen = !hasDated && hasUndated;
    render();
    requestAnimationFrame(() => {
      document.querySelector(".timeline-zone--completed, .undated-group--completed")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  elements.topButton.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  elements.addButton.addEventListener("click", () => openTaskDialog());
  elements.driveMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleDriveMenu();
  });
  elements.driveButton.addEventListener("click", () => {
    setDriveMenuOpen(false);
    connectOrSyncDrive();
  });
  elements.driveDisconnectButton.addEventListener("click", disconnectDrive);
  document.addEventListener("click", (event) => {
    if (!elements.driveSync.contains(event.target)) setDriveMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setDriveMenuOpen(false);
  });
  elements.taskForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveTaskFromForm();
  });
  elements.cancelDialogButton.addEventListener("click", () => elements.taskDialog.close());
  elements.deleteButton.addEventListener("click", deleteCurrentTask);
  window.addEventListener("blur", cleanupDrag);
  window.addEventListener("focus", () => {
    if (drive.connected) syncDriveState({ background: true });
  });
  window.addEventListener("online", () => {
    if (drive.connected) syncDriveState();
  });
  document.addEventListener("visibilitychange", () => {
    if (!drive.connected) return;
    if (document.visibilityState === "visible") syncDriveState({ background: true });
    else if (dirtyItems.size) syncDriveState({ background: true });
  });
  render();
  (async () => {
    await loadDriveRuntimeConfig();
    initializeDriveClient();
    await restoreDriveSession();
  })();
})();
