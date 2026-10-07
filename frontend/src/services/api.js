const API_URL = (import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:8000`).trim().replace(/\/+$/, "");
const AUTH_STORAGE_KEY = "inventory-admin-session";
let memoryToken = "";
let storageUnavailable = false;

export function getAdminSessionToken() {
  if (storageUnavailable) return memoryToken;
  try { memoryToken = window.sessionStorage.getItem(AUTH_STORAGE_KEY) || ""; return memoryToken; }
  catch { storageUnavailable = true; return memoryToken; }
}

export function hasAdminSession() {
  return Boolean(getAdminSessionToken());
}

export function clearAdminSession() {
  memoryToken = "";
  try { window.sessionStorage.removeItem(AUTH_STORAGE_KEY); } catch { storageUnavailable = true; }
}

function connectionStatus(status) {
  window.dispatchEvent(new CustomEvent("inventory-connection", { detail: { status } }));
}

function responseMessage(data) {
  if (typeof data?.detail === "string") return data.detail;
  if (Array.isArray(data?.detail)) {
    return data.detail.slice(0, 3).map(item => {
      const field = Array.isArray(item.loc) ? item.loc.filter(value => value !== "body").join(".") : "";
      return `${field ? `${field}: ` : ""}${item.msg || "valoare invalidă"}`;
    }).join("; ");
  }
  return "A apărut o eroare la comunicarea cu serverul.";
}

async function apiRequest(path, options = {}) {
  const { skipAuth = false, ...fetchOptions } = options;
  const isFormData = typeof FormData !== "undefined" && fetchOptions.body instanceof FormData;
  const token = skipAuth ? "" : getAdminSessionToken();
  let base;
  try { base = new URL(API_URL, window.location.origin); }
  catch { throw new Error("Adresa API configurată este invalidă. Verifică VITE_API_URL."); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Adresa API configurată este invalidă. Verifică VITE_API_URL.");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (fetchOptions.signal?.aborted) controller.abort();
  else fetchOptions.signal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, isFormData ? 60000 : 30000);
  let response;
  let text;
  try {
    response = await fetch(`${base.href.replace(/\/+$/, "")}${path}`, {
    ...fetchOptions,
    signal: controller.signal,
    cache: "no-store",
    credentials: "omit",
    headers: {
      ...(!isFormData && fetchOptions.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(fetchOptions.headers || {}),
    },
    });
    text = await response.text();
  } catch (error) {
    if (fetchOptions.signal?.aborted) throw error;
    connectionStatus("offline");
    throw new Error(controller.signal.aborted
      ? "Serverul răspunde prea lent. Verifică rezultatul operației înainte de a o repeta."
      : "Conexiunea cu serverul nu a reușit. Verifică rețeaua și încearcă din nou.");
  } finally {
    window.clearTimeout(timeout);
    fetchOptions.signal?.removeEventListener("abort", abort);
  }
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (response.ok) {
        connectionStatus("offline");
        throw new Error("Serverul a trimis un răspuns invalid. Verifică adresa API.");
      }
    }
  }

  if (!response.ok) {
    const message = responseMessage(data);
    if (response.status >= 500) connectionStatus("offline");

    if (response.status === 401 && !skipAuth && token === getAdminSessionToken() && path !== "/auth/login") {
      clearAdminSession();
      window.dispatchEvent(new CustomEvent("inventory-auth-required"));
    }

    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  connectionStatus("online");
  return data;
}

export function getLoginMethods(signal) {
  return apiRequest("/auth/methods", { skipAuth: true, signal });
}

// A username selects LDAP login; without one the local admin password is used.
export async function loginAdmin(password, username = "") {
  const result = await apiRequest("/auth/login", {
    method: "POST",
    body: JSON.stringify(username ? { username, password } : { password }),
    skipAuth: true,
  });
  if (typeof result?.token !== "string" || !result.token) throw new Error("Serverul nu a furnizat o sesiune validă.");
  memoryToken = result.token;
  try { window.sessionStorage.setItem(AUTH_STORAGE_KEY, result.token); } catch { storageUnavailable = true; }
  return result;
}

export function getCurrentAdmin() {
  return apiRequest("/auth/me");
}

export async function logoutAdmin() {
  try {
    if (getAdminSessionToken()) {
      await apiRequest("/auth/logout", { method: "POST" });
    }
  } finally {
    clearAdminSession();
  }
}

export function mediaUrl(path) {
  if (!path || typeof path !== "string") return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    try {
      const url = new URL(path);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }
  try {
    const base = new URL(API_URL, window.location.origin);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) return "";
    return `${base.href.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  } catch { return ""; }
}


export function getPublicAsset(token, signal) {
  return apiRequest(`/public/assets/${encodeURIComponent(token)}`, { skipAuth: true, signal });
}

export function getPublicCatalog(params, signal) {
  return apiRequest(`/public/assets/catalog?${params}`, { skipAuth: true, signal });
}

export function getCatalogAsset(code, signal) {
  return apiRequest(`/public/assets/catalog/${encodeURIComponent(code)}`, { skipAuth: true, signal });
}

export function getTagBatches() { return apiRequest("/tags/batches"); }
export function createTagBatch(quantity) { return apiRequest("/tags/batches", { method: "POST", body: JSON.stringify({ quantity }) }); }
export function getTagBatchForPrinting(batchId) { return apiRequest(`/tags/batches/${batchId}`); }
export function getTag(code, signal) { return apiRequest(`/tags/${encodeURIComponent(code.trim())}`, { signal }); }
export function voidTag(code) { return apiRequest(`/tags/${encodeURIComponent(code.trim())}/void`, { method: "POST" }); }
export function assignDeviceTag(deviceId, tagCode) { return apiRequest(`/devices/${deviceId}/tag`, { method: "POST", body: JSON.stringify({ tag_code: tagCode }) }); }

export function getDevicePublicAccess(deviceId, baseUrl = window.location.origin) {
  return apiRequest(`/devices/${deviceId}/public-access?base_url=${encodeURIComponent(baseUrl)}`);
}

export function createDevicePublicAccess(deviceId, baseUrl = window.location.origin) {
  return apiRequest(`/devices/${deviceId}/public-access`, {
    method: "POST",
    body: JSON.stringify({ base_url: baseUrl }),
  });
}

export function regenerateDevicePublicAccess(deviceId, baseUrl = window.location.origin) {
  return apiRequest(`/devices/${deviceId}/public-access/regenerate`, {
    method: "POST",
    body: JSON.stringify({ base_url: baseUrl }),
  });
}

export function revokeDevicePublicAccess(deviceId) {
  return apiRequest(`/devices/${deviceId}/public-access`, { method: "DELETE" });
}

export function getDevices() { return apiRequest("/devices/"); }
export function getDeviceTracking(deviceId) { return apiRequest(`/devices/${deviceId}/tracking`); }
export function createDevice(device) { return apiRequest("/devices/", { method: "POST", body: JSON.stringify(device) }); }
export function updateDevice(deviceId, device) { return apiRequest(`/devices/${deviceId}`, { method: "PUT", body: JSON.stringify(device) }); }
export function deleteDevice(deviceId) { return apiRequest(`/devices/${deviceId}`, { method: "DELETE" }); }

export function uploadDeviceImages(deviceId, files) {
  const form = new FormData();
  Array.from(files || []).forEach((file) => form.append("files", file));
  return apiRequest(`/devices/${deviceId}/images`, { method: "POST", body: form });
}

export function deleteDeviceImage(deviceId, imageId) {
  return apiRequest(`/devices/${deviceId}/images/${imageId}`, { method: "DELETE" });
}

export function syncPeopleFromDirectory({ username = "", password }) {
  return apiRequest("/people/directory-sync", { method: "POST", body: JSON.stringify(username ? { username, password } : { password }) });
}
export function getPeople(includeInactive = true, role = "") { return apiRequest(`/people/?include_inactive=${includeInactive}${role ? `&role=${encodeURIComponent(role)}` : ""}`); }
export function createPerson(person) { return apiRequest("/people/", { method: "POST", body: JSON.stringify(person) }); }
export function updatePerson(personId, person) { return apiRequest(`/people/${personId}`, { method: "PUT", body: JSON.stringify(person) }); }
export function deactivatePerson(personId) { return apiRequest(`/people/${personId}`, { method: "DELETE" }); }

export function getLocations(includeInactive = true) { return apiRequest(`/locations/?include_inactive=${includeInactive}`); }
export function createLocation(location) { return apiRequest("/locations/", { method: "POST", body: JSON.stringify(location) }); }
export function updateLocation(locationId, location) { return apiRequest(`/locations/${locationId}`, { method: "PUT", body: JSON.stringify(location) }); }
export function deleteLocation(locationId) { return apiRequest(`/locations/${locationId}`, { method: "DELETE" }); }

export function getLoans(status = "") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiRequest(`/loans/${query}`);
}
export function createLoan(loan) { return apiRequest("/loans/", { method: "POST", body: JSON.stringify(loan) }); }
export function returnLoan(loanId) { return apiRequest(`/loans/${loanId}/return`, { method: "POST" }); }

export function getLogs({ action = "", deviceId = "", limit = 200 } = {}) {
  const params = new URLSearchParams();
  if (action) params.set("action", action);
  if (deviceId) params.set("device_id", deviceId);
  params.set("limit", String(limit));
  return apiRequest(`/logs/?${params.toString()}`);
}
export function getLogActions() { return apiRequest("/logs/actions"); }
export function getAdminDashboard() { return apiRequest("/admin/dashboard"); }


export function getJournal({ eventType = "", category = "", severity = "", deviceId = "", loanId = "", limit = 300 } = {}) {
  const params = new URLSearchParams();
  if (eventType) params.set("event_type", eventType);
  if (category) params.set("category", category);
  if (severity) params.set("severity", severity);
  if (deviceId) params.set("device_id", deviceId);
  if (loanId) params.set("loan_id", loanId);
  params.set("limit", String(limit));
  return apiRequest(`/journal/?${params.toString()}`);
}

export function getJournalEventTypes() { return apiRequest("/journal/event-types"); }

export function getNotifications({ unreadOnly = false, limit = 40 } = {}) {
  const params = new URLSearchParams({ unread_only: String(unreadOnly), limit: String(limit) });
  return apiRequest(`/notifications/?${params.toString()}`);
}

export function getUnreadNotificationCount() { return apiRequest("/notifications/unread-count"); }
export function markNotificationRead(notificationId) { return apiRequest(`/notifications/${notificationId}/read`, { method: "POST" }); }
export function markAllNotificationsRead() { return apiRequest("/notifications/read-all", { method: "POST" }); }

export function createBackup() { return apiRequest("/admin/backup", { method: "POST" }); }
export function clearApplicationData(code) {
  return apiRequest("/admin/clear-data", { method: "POST", body: JSON.stringify({ code }) });
}
