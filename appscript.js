const ss = SpreadsheetApp.getActiveSpreadsheet();

/* =========================
   CONFIG.JS INTEGRATION
   (Server-side Configuration)
========================= */
const SCRIPT_CONFIG = {
  // SCRIPT_URL sengaja tidak di-hardcode untuk menghindari exposure endpoint di source.
  // Set via Script Properties: APP_SCRIPT_URL jika memang diperlukan.
  SCRIPT_URL: "",
  ENV: "production"
};

const ADMIN_SESSION_CACHE_TTL_SECONDS = 6 * 60 * 60;
const ADMIN_SESSION_CACHE_PREFIX = "admin_session_cache_";
const ADMIN_SESSION_PROPERTY_PREFIX = "admin_session_";
const PUBLIC_CACHE_STATE_PROPERTY = "public_cache_state_v1";
const PUBLIC_CACHE_SCOPES = ["settings", "catalog", "pages", "dashboard"];
const PRODUCT_DESC_MAX_LENGTH = 280;

function getScriptConfig(key) {
  try {
    const p = PropertiesService.getScriptProperties();
    const v = p.getProperty(String(key || ""));
    if (v !== null && v !== undefined && String(v) !== "") return String(v);
  } catch (e) {}
  return SCRIPT_CONFIG[key] || "";
}

function testConfiguration() {
  const url = getScriptConfig("SCRIPT_URL");
  return { status: "success", script_url_configured: !!url };
}

/* =========================
   UTIL / HARDENING HELPERS
========================= */
function jsonRes(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
function doGet() {
  return ContentService.createTextOutput("System API Ready!")
    .setMimeType(ContentService.MimeType.TEXT);
}

function createDefaultPublicCacheState_() {
  const now = Date.now();
  return {
    settings: now,
    catalog: now,
    pages: now,
    dashboard: now,
    last_updated: now
  };
}

function normalizePublicCacheState_(state) {
  const source = state && typeof state === "object" ? state : {};
  const fallback = createDefaultPublicCacheState_();
  const normalized = {};
  PUBLIC_CACHE_SCOPES.forEach(function(scope) {
    const value = Number(source[scope] || 0);
    normalized[scope] = value > 0 ? value : fallback[scope];
  });
  normalized.last_updated = Math.max.apply(null, PUBLIC_CACHE_SCOPES.map(function(scope) {
    return Number(normalized[scope] || 0);
  }));
  return normalized;
}

function readPublicCacheState_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(PUBLIC_CACHE_STATE_PROPERTY);
    if (!raw) {
      const seeded = normalizePublicCacheState_(null);
      props.setProperty(PUBLIC_CACHE_STATE_PROPERTY, JSON.stringify(seeded));
      return seeded;
    }
    return normalizePublicCacheState_(JSON.parse(raw));
  } catch (e) {
    const fallback = normalizePublicCacheState_(null);
    try {
      PropertiesService.getScriptProperties().setProperty(PUBLIC_CACHE_STATE_PROPERTY, JSON.stringify(fallback));
    } catch (err) {}
    return fallback;
  }
}

function writePublicCacheState_(state) {
  const normalized = normalizePublicCacheState_(state);
  PropertiesService.getScriptProperties().setProperty(PUBLIC_CACHE_STATE_PROPERTY, JSON.stringify(normalized));
  return normalized;
}

function bumpPublicCacheState_(scopes) {
  const validScopes = Array.isArray(scopes)
    ? scopes.map(function(scope) { return String(scope || "").trim().toLowerCase(); }).filter(function(scope, index, arr) {
        return PUBLIC_CACHE_SCOPES.indexOf(scope) !== -1 && arr.indexOf(scope) === index;
      })
    : [];
  if (!validScopes.length) return readPublicCacheState_();

  const next = readPublicCacheState_();
  let seed = Date.now();
  validScopes.forEach(function(scope, index) {
    const previous = Number(next[scope] || 0);
    next[scope] = Math.max(seed + index, previous + 1);
  });
  next.last_updated = Math.max.apply(null, PUBLIC_CACHE_SCOPES.map(function(scope) {
    return Number(next[scope] || 0);
  }));
  return writePublicCacheState_(next);
}

function publicCacheVersionToken_(scope, state) {
  const key = String(scope || "").trim().toLowerCase();
  const source = state && typeof state === "object" ? normalizePublicCacheState_(state) : readPublicCacheState_();
  if (PUBLIC_CACHE_SCOPES.indexOf(key) === -1) return "0";
  return String(Number(source[key] || 0));
}

function withPublicCacheVersion_(payload, scope) {
  const target = payload && typeof payload === "object" ? payload : {};
  target.cache_version = publicCacheVersionToken_(scope);
  return target;
}

function withPublicCacheState_(payload, state) {
  const target = payload && typeof payload === "object" ? payload : {};
  target.cache_state = state && typeof state === "object" ? normalizePublicCacheState_(state) : readPublicCacheState_();
  return target;
}

function getPublicCacheState() {
  return {
    status: "success",
    data: readPublicCacheState_()
  };
}

// CACHING WRAPPER
function getCachedData_(key, fetcherFn, expirationInSeconds = 600) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(key);
  if (cached) {
    return JSON.parse(cached);
  }
  const data = fetcherFn();
  if (data) {
    try {
      cache.put(key, JSON.stringify(data), expirationInSeconds);
    } catch (e) {
      // Data might be too large for cache (100KB limit)
      console.error("Cache Put Error for " + key + ": " + e.toString());
    }
  }
  return data;
}

function getSettingsMap_() {
  return getCachedData_("settings_map", () => {
    const s = ss.getSheetByName("Settings");
    if (!s) return {};
    const d = s.getDataRange().getValues();
    const map = {};
    for (let i = 1; i < d.length; i++) {
      const k = String(d[i][0] || "").trim();
      if (k) map[k] = d[i][1];
    }
    return map;
  }, 1800); // Cache for 30 minutes
}
function getCfgFrom_(cfg, name) {
  return (cfg && cfg[name] !== undefined && cfg[name] !== null) ? cfg[name] : "";
}
function mustSheet_(name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error(`Sheet "${name}" tidak ditemukan`);
  return sh;
}
function toNumberSafe_(v) {
  const n = Number(String(v ?? "").replace(/[^\d]/g, ""));
  return isFinite(n) ? n : 0;
}
function toISODate_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function normalizePlainText_(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsHtmlMarkup_(value) {
  return /<\s*\/?\s*[a-z][^>]*>/i.test(String(value === null || value === undefined ? "" : value));
}

function normalizeProductDescription_(value) {
  return normalizePlainText_(value);
}

function validateProductDescription_(value) {
  const raw = String(value === null || value === undefined ? "" : value);
  const normalized = normalizeProductDescription_(raw);
  const errors = [];
  if (containsHtmlMarkup_(raw)) {
    errors.push("Deskripsi singkat produk tidak boleh mengandung tag HTML.");
  }
  if (normalized.length > PRODUCT_DESC_MAX_LENGTH) {
    errors.push("Deskripsi singkat produk maksimal " + PRODUCT_DESC_MAX_LENGTH + " karakter.");
  }
  return {
    value: normalized,
    errors: errors
  };
}

function normalizeProductRow_(row) {
  const next = Array.isArray(row) ? row.slice() : [];
  if (next.length > 1) next[1] = normalizePlainText_(next[1]);
  if (next.length > 2) next[2] = normalizeProductDescription_(next[2]);
  return next;
}

function getSecret_(name, cfg) {
  const k = String(name || "").trim();
  if (!k) return "";
  try {
    const p = PropertiesService.getScriptProperties();
    const v = p.getProperty(k);
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  } catch (e) {}
  return String(getCfgFrom_(cfg || getSettingsMap_(), k) || "").trim();
}

function isDebugAllowed_() {
  try {
    const p = PropertiesService.getScriptProperties();
    return String(p.getProperty("DEBUG_MODE") || "false").toLowerCase() === "true";
  } catch (e) {
    return false;
  }
}

function hashPassword_(plain) {
  const input = String(plain || "");
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  const hex = digest.map(function(b){
    const v = (b < 0 ? b + 256 : b);
    return ("0" + v.toString(16)).slice(-2);
  }).join("");
  return "sha256$" + hex;
}

function verifyPassword_(input, stored) {
  const inStr = String(input || "");
  const st = String(stored || "").trim();
  if (!st) return false;
  if (st.indexOf("sha256$") === 0) return hashPassword_(inStr) === st;
  return inStr === st;
}

function getAdminSessionToken_(data) {
  const source = data || {};
  return String(
    source.auth_session_token ||
    source.admin_session_token ||
    source.session_token ||
    ""
  ).trim();
}

function getAdminSessionPropertyStore_() {
  return PropertiesService.getScriptProperties();
}

function persistAdminSession_(token, session) {
  const key = String(token || "").trim();
  if (!key || !session || typeof session !== "object") return;
  const serialized = JSON.stringify(session);
  getAdminSessionPropertyStore_().setProperty(ADMIN_SESSION_PROPERTY_PREFIX + key, serialized);
  try {
    CacheService.getScriptCache().put(ADMIN_SESSION_CACHE_PREFIX + key, serialized, ADMIN_SESSION_CACHE_TTL_SECONDS);
  } catch (e) {}
}

function revokeAdminSession_(token) {
  const key = String(token || "").trim();
  if (!key) return;
  getAdminSessionPropertyStore_().deleteProperty(ADMIN_SESSION_PROPERTY_PREFIX + key);
  try {
    CacheService.getScriptCache().remove(ADMIN_SESSION_CACHE_PREFIX + key);
  } catch (e) {}
}

function createAdminSession_(sessionData) {
  const issuedAt = Date.now();
  const token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  const session = Object.assign({
    id: "",
    email: "",
    name: "Admin",
    role: "admin",
    issued_at: issuedAt,
    expires_at: 0
  }, sessionData || {});
  persistAdminSession_(token, session);
  return {
    token: token,
    expires_at: session.expires_at,
    session: session
  };
}

function getAdminSession_(token) {
  const key = String(token || "").trim();
  if (!key) return null;
  let cached = null;
  try {
    cached = CacheService.getScriptCache().get(ADMIN_SESSION_CACHE_PREFIX + key);
  } catch (e) {}
  try {
    const parsed = cached ? JSON.parse(cached) : null;
    if (parsed && typeof parsed === "object") {
      const propKey = ADMIN_SESSION_PROPERTY_PREFIX + key;
      if (!getAdminSessionPropertyStore_().getProperty(propKey)) {
        try {
          getAdminSessionPropertyStore_().setProperty(propKey, cached);
        } catch (e) {}
      }
      return parsed;
    }
  } catch (e) {}

  const stored = getAdminSessionPropertyStore_().getProperty(ADMIN_SESSION_PROPERTY_PREFIX + key);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === "object") {
      try {
        CacheService.getScriptCache().put(ADMIN_SESSION_CACHE_PREFIX + key, stored, ADMIN_SESSION_CACHE_TTL_SECONDS);
      } catch (e) {}
      return parsed;
    }
  } catch (e) {
    revokeAdminSession_(key);
  }
  return null;
}

function validateAdminSessionAccess_(session, options) {
  const opts = options || {};
  const actionName = String(opts.actionName || "aksi admin").trim();
  const allowedRoles = Array.isArray(opts.allowedRoles) && opts.allowedRoles.length
    ? opts.allowedRoles.map(function(role) { return String(role || "").trim().toLowerCase(); })
    : ["admin"];
  if (!session || typeof session !== "object") {
    throw new Error("Sesi admin tidak valid. Silakan login ulang.");
  }
  const role = String(session.role || "").trim().toLowerCase();
  if (!role || allowedRoles.indexOf(role) === -1) {
    throw new Error("Akses admin ditolak untuk aksi " + actionName + ".");
  }
  return session;
}

function requireAdminSession_(data, options) {
  const token = getAdminSessionToken_(data);
  if (!token) throw new Error("Sesi admin tidak ditemukan. Silakan login ulang.");
  const session = getAdminSession_(token);
  if (!session) throw new Error("Sesi admin tidak valid. Silakan login ulang.");
  return validateAdminSessionAccess_(session, options);
}

function adminLogout(d) {
  const token = getAdminSessionToken_(d);
  if (token) revokeAdminSession_(token);
  return { status: "success", message: "Sesi admin berhasil ditutup." };
}

function sanitizeAssetUrl_(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^data:image\//i.test(value)) return value;
  if (value.charAt(0) === "/") return value;
  if (!/^https?:\/\//i.test(value)) return "";

  const match = value.match(/^https?:\/\/([^\/?#]+)/i);
  const host = match && match[1] ? String(match[1]).toLowerCase() : "";
  if (!host) return "";

  if (
    host === "example.com" ||
    host === "example.org" ||
    host === "example.net" ||
    /(^|\.)example\.(com|org|net)$/i.test(host)
  ) {
    return "";
  }

  return value;
}

function getCurrentWebAppUrl_() {
  const fromConfig = String(getScriptConfig("APP_SCRIPT_URL") || getScriptConfig("SCRIPT_URL") || "").trim();
  if (fromConfig) return fromConfig;
  try {
    const url = ScriptApp.getService().getUrl();
    return String(url || "").trim();
  } catch (e) {
    return "";
  }
}

function normalizeMootaUrl_(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const match = value.match(/^(https:\/\/[^?#]+?)(?:[?#].*)?$/i);
  return match && match[1] ? String(match[1]).trim() : value;
}

function getMootaUrlHost_(raw) {
  const value = normalizeMootaUrl_(raw);
  const match = value.match(/^https:\/\/([^\/?#]+)/i);
  return match && match[1] ? String(match[1]).toLowerCase() : "";
}

function isDirectAppsScriptUrl_(raw) {
  const host = getMootaUrlHost_(raw);
  return host === "script.google.com" || host === "script.googleusercontent.com";
}

function isValidMootaUrl_(value) {
  const url = normalizeMootaUrl_(value);
  if (!url) return false;
  return /^https:\/\/[^\s?#]+$/i.test(url);
}

function isValidMootaToken_(value) {
  return /^[A-Za-z0-9]{8,200}$/.test(String(value || "").trim());
}

function resolveMootaConfig_(data, cfg) {
  const payload = data || {};
  const fallbackUrl = getCfgFrom_(cfg, "moota_gas_url") || getCurrentWebAppUrl_();
  const storedToken = getSecret_("moota_token", cfg);
  const legacySecret = getSecret_("moota_secret", cfg);
  const nextToken = payload.moota_token !== undefined
    ? payload.moota_token
    : (payload.moota_secret !== undefined ? payload.moota_secret : (storedToken || legacySecret));
  return {
    gasUrl: normalizeMootaUrl_(payload.moota_gas_url !== undefined ? payload.moota_gas_url : fallbackUrl),
    token: String(nextToken || "").trim()
  };
}

function validateMootaConfigFormat_(mootaCfg, opts) {
  const options = opts || {};
  const errors = [];
  const requireUrl = options.requireUrl !== false;
  const requireToken = options.requireToken !== false;

  if (requireUrl && !mootaCfg.gasUrl) errors.push("Link webhook Moota wajib diisi.");
  if (requireUrl && mootaCfg.gasUrl && !isValidMootaUrl_(mootaCfg.gasUrl)) {
    errors.push("Format link webhook Moota tidak valid. Gunakan URL HTTPS tanpa query string.");
  }
  if (requireUrl && mootaCfg.gasUrl && isDirectAppsScriptUrl_(mootaCfg.gasUrl)) {
    errors.push("Link webhook Moota tidak boleh langsung ke Google Apps Script. Gunakan endpoint Cloudflare Worker atau proxy publik agar header Signature bisa diteruskan.");
  }

  if (requireToken && !mootaCfg.token) errors.push("Secret Token Moota wajib diisi.");
  if (requireToken && mootaCfg.token && !isValidMootaToken_(mootaCfg.token)) {
    errors.push("Format Secret Token Moota tidak valid. Gunakan minimal 8 karakter alphanumeric tanpa spasi.");
  }

  return errors;
}

function normalizeMootaSignature_(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  value = value.replace(/^sha256=/i, "").trim();
  return value.replace(/[^a-f0-9]/ig, "").toLowerCase();
}

function computeMootaSignatureHex_(payloadString, secretToken) {
  const computed = Utilities.computeHmacSha256Signature(String(payloadString || ""), String(secretToken || ""));
  return computed.map(function(chr) {
    const value = chr < 0 ? chr + 256 : chr;
    return ("0" + value.toString(16)).slice(-2);
  }).join("").toLowerCase();
}

function verifyMootaSignature_(payloadString, secretToken, rawSignature) {
  const secret = String(secretToken || "").trim();
  const received = normalizeMootaSignature_(rawSignature);
  if (!secret) {
    return { ok: false, code: "missing_secret", received: received, expected: "" };
  }
  if (!received) {
    return { ok: false, code: "missing_signature", received: "", expected: "" };
  }
  const expected = computeMootaSignatureHex_(payloadString, secret);
  return {
    ok: received === expected,
    code: received === expected ? "ok" : "invalid_signature",
    received: received,
    expected: expected
  };
}

function maskMootaSignatureForLog_(value) {
  const sig = String(value || "");
  if (!sig) return "";
  if (sig.length <= 12) return sig;
  return sig.substring(0, 8) + "..." + sig.substring(sig.length - 4);
}

function extractMootaSignatureMeta_(e) {
  const params = (e && e.parameter) || {};
  const rawSignature = params.moota_signature !== undefined
    ? params.moota_signature
    : (params.signature !== undefined ? params.signature : "");
  const signatureSource = params.moota_signature !== undefined
    ? "query:moota_signature"
    : (params.signature !== undefined ? "query:signature" : "missing");
  return {
    raw: String(rawSignature || "").trim(),
    normalized: normalizeMootaSignature_(rawSignature),
    source: signatureSource,
    forwardedByWorker: String(params.moota_forwarded || "").trim() === "1",
    workerSawSignature: String(params.moota_sig_present || "").trim() === "1",
    workerVerifiedSignature: String(params.moota_sig_verified || "").trim() === "1",
    workerVerificationSource: String(params.moota_sig_verified_by || "").trim(),
    userAgent: String(params.moota_user_agent || "").trim(),
    mootaUser: String(params.moota_user || "").trim(),
    mootaWebhook: String(params.moota_webhook || "").trim(),
    paramKeys: Object.keys(params)
  };
}

function logMootaSignatureEvent_(type, meta, extra) {
  try {
    const payload = Object.assign({
      source: meta && meta.source ? meta.source : "missing",
      forwarded_by_worker: !!(meta && meta.forwardedByWorker),
      worker_saw_signature: !!(meta && meta.workerSawSignature),
      worker_verified_signature: !!(meta && meta.workerVerifiedSignature),
      worker_verification_source: meta && meta.workerVerificationSource ? meta.workerVerificationSource : "",
      received_signature: maskMootaSignatureForLog_(meta && meta.normalized),
      signature_length: meta && meta.normalized ? meta.normalized.length : 0,
      moota_user: meta && meta.mootaUser ? String(meta.mootaUser).substring(0, 40) : "",
      moota_webhook: meta && meta.mootaWebhook ? String(meta.mootaWebhook).substring(0, 40) : "",
      user_agent: meta && meta.userAgent ? String(meta.userAgent).substring(0, 120) : "",
      param_keys: meta && meta.paramKeys ? meta.paramKeys.slice(0, 10).join(",") : ""
    }, extra || {});
    logMoota_(type, JSON.stringify(payload));
  } catch (err) {
    Logger.log("logMootaSignatureEvent_ error: " + err);
  }
}

function classifyMootaSignatureMissing_(mootaCfg, meta) {
  if (isDirectAppsScriptUrl_(mootaCfg && mootaCfg.gasUrl)) {
    return {
      code: "direct_apps_script_url",
      message: "ERROR: Missing Signature. Webhook Moota masih diarahkan langsung ke Google Apps Script. Gunakan endpoint Cloudflare Worker/proxy publik sebagai URL webhook di dashboard Moota."
    };
  }
  if (!(meta && meta.forwardedByWorker)) {
    return {
      code: "worker_not_detected",
      message: "ERROR: Missing Signature. Request tidak terlihat datang dari Worker/proxy. Pastikan URL webhook Moota mengarah ke endpoint Worker/proxy yang aktif dan terbaru."
    };
  }
  if (meta.forwardedByWorker && !meta.workerSawSignature) {
    return {
      code: "worker_missing_signature_header",
      message: "ERROR: Missing Signature. Worker/proxy menerima request tetapi header Signature dari Moota tidak ditemukan. Periksa pengaturan webhook Moota dan deploy Worker versi terbaru."
    };
  }
  return {
    code: "signature_not_forwarded",
    message: "ERROR: Missing Signature. Header Signature dari Moota tidak berhasil diteruskan ke Apps Script. Pastikan Worker meneruskan query param `moota_signature` atau `signature`."
  };
}

function appendQueryParams_(url, params) {
  const base = String(url || "").trim();
  if (!base) return "";
  const entries = [];
  const source = params || {};
  for (let key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined || value === null || String(value) === "") continue;
    entries.push(encodeURIComponent(String(key)) + "=" + encodeURIComponent(String(value)));
  }
  if (!entries.length) return base;
  return base + (base.indexOf("?") === -1 ? "?" : "&") + entries.join("&");
}

function normalizeImageKitEndpoint_(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  return value;
}

function isValidImageKitPublicKey_(value) {
  return /^public_[A-Za-z0-9+/=._-]+$/.test(String(value || "").trim());
}

function isValidImageKitPrivateKey_(value) {
  return /^private_[A-Za-z0-9+/=._-]+$/.test(String(value || "").trim());
}

function isValidImageKitEndpoint_(value) {
  const endpoint = normalizeImageKitEndpoint_(value);
  if (!endpoint) return false;
  if (!/^https:\/\/[^\s/$.?#].[^\s]*$/i.test(endpoint)) return false;
  if (/[?#]/.test(endpoint)) return false;
  return true;
}

function resolveImageKitConfig_(data, cfg) {
  const payload = data || {};
  return {
    publicKey: String((payload.ik_public_key !== undefined ? payload.ik_public_key : getCfgFrom_(cfg, "ik_public_key")) || "").trim(),
    endpoint: normalizeImageKitEndpoint_(payload.ik_endpoint !== undefined ? payload.ik_endpoint : getCfgFrom_(cfg, "ik_endpoint")),
    privateKey: String((payload.ik_private_key !== undefined ? payload.ik_private_key : getSecret_("ik_private_key", cfg)) || "").trim()
  };
}

function validateImageKitConfigFormat_(ikCfg, opts) {
  const options = opts || {};
  const errors = [];
  const requirePublic = options.requirePublic !== false;
  const requireEndpoint = options.requireEndpoint !== false;
  const requirePrivate = options.requirePrivate !== false;

  if (requirePublic && !ikCfg.publicKey) errors.push("ImageKit public key wajib diisi.");
  if (requirePublic && ikCfg.publicKey && !isValidImageKitPublicKey_(ikCfg.publicKey)) {
    errors.push("Format ImageKit public key tidak valid. Harus diawali dengan 'public_'.");
  }

  if (requireEndpoint && !ikCfg.endpoint) errors.push("ImageKit URL endpoint wajib diisi.");
  if (requireEndpoint && ikCfg.endpoint && !isValidImageKitEndpoint_(ikCfg.endpoint)) {
    errors.push("Format ImageKit URL endpoint tidak valid. Gunakan URL HTTPS seperti https://ik.imagekit.io/nama-endpoint");
  }

  if (requirePrivate && !ikCfg.privateKey) errors.push("ImageKit private key wajib diisi.");
  if (requirePrivate && ikCfg.privateKey && !isValidImageKitPrivateKey_(ikCfg.privateKey)) {
    errors.push("Format ImageKit private key tidak valid. Harus diawali dengan 'private_'.");
  }

  return errors;
}

function inferImageKitEndpointFromUrl_(fileUrl) {
  const value = String(fileUrl || "").trim();
  if (!value) return "";
  const match = value.match(/^https:\/\/([^\/?#]+)(\/[^?#]*)?/i);
  if (!match) return "";
  const host = String(match[1] || "").toLowerCase();
  const path = String(match[2] || "");
  if (!host) return "";
  if (host === "ik.imagekit.io") {
    const firstSegment = path.split("/").filter(Boolean)[0] || "";
    if (firstSegment) return "https://ik.imagekit.io/" + firstSegment;
  }
  return "https://" + host;
}

function fetchImageKitFiles_(privateKey, limit) {
  try {
    const authHeader = "Basic " + Utilities.base64Encode(String(privateKey || "").trim() + ":");
    const url = "https://api.imagekit.io/v1/files?sort=DESC_CREATED&limit=" + Number(limit || 20);
    const res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { "Authorization": authHeader },
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}

    if (code >= 200 && code < 300 && Array.isArray(data)) {
      return { ok: true, files: data };
    }

    let message = "Gagal terhubung ke ImageKit.";
    if (code === 401) {
      message = "Autentikasi ImageKit gagal. Periksa private key Anda.";
    } else if (data && data.message) {
      message = "ImageKit error: " + data.message;
    } else if (text) {
      message = "ImageKit error HTTP " + code + ": " + String(text).substring(0, 200);
    }

    return { ok: false, code: code, message: message };
  } catch (e) {
    return { ok: false, code: 0, message: "Koneksi ke ImageKit gagal: " + e.toString() };
  }
}

function assertPrivilegedAction_(data, cfg) {
  if (isDebugAllowed_()) return true;
  const supplied = String((data && data.admin_token) || "").trim();
  const expected = getSecret_("ADMIN_API_TOKEN", cfg || getSettingsMap_());
  if (expected && supplied === expected) return true;
  throw new Error("Unauthorized diagnostic action");
}

/* =========================
   LEGACY getCfg (kept)
   (masih bisa dipakai, tapi lebih lambat)
========================= */
function getCfg(name) {
  try {
    const s = ss.getSheetByName("Settings");
    const d = s.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      if (String(d[i][0]).trim() === name) return d[i][1];
    }
  } catch (e) { return ""; }
  return "";
}



/* =========================
   WEBHOOK ENTRYPOINT
========================= */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonRes({ status: "error", message: "No data" });
    }

    const cfg = getSettingsMap_();



    const payloadString = e.postData.contents;
    let data = null;
    try {
       data = JSON.parse(payloadString);
    } catch(err) {
       // Ignore JSON parse error, maybe it was not JSON but handled above or invalid
       return jsonRes({ status: "error", message: "Invalid JSON format" });
    }

    // ====================================================================
    // 🚀 RADAR MOOTA: DETEKSI WEBHOOK MASUK + VERIFIKASI SIGNATURE
    // ====================================================================
    if (Array.isArray(data) && data.length > 0 && data[0].amount !== undefined) {
      const mootaCfg = resolveMootaConfig_({}, cfg);
      const signatureMeta = extractMootaSignatureMeta_(e);
      if (!mootaCfg.gasUrl) {
        logMootaSignatureEvent_("SIGNATURE_CONFIG_ERROR", signatureMeta, {
          reason: "missing_webhook_url",
          payload_bytes: payloadString.length
        });
        return ContentService.createTextOutput("ERROR: Link webhook Moota belum dikonfigurasi.")
          .setMimeType(ContentService.MimeType.TEXT);
      }
      if (!mootaCfg.token) {
        logMootaSignatureEvent_("SIGNATURE_CONFIG_ERROR", signatureMeta, {
          reason: "missing_secret_token",
          payload_bytes: payloadString.length,
          webhook_host: getMootaUrlHost_(mootaCfg.gasUrl)
        });
        return ContentService.createTextOutput("ERROR: Secret Token Moota belum dikonfigurasi.")
          .setMimeType(ContentService.MimeType.TEXT);
      }

      // Apps Script tidak menerima custom header mentah dari webhook,
      // jadi proxy/Worker perlu meneruskan header Signature ke query param ini.
      if (!signatureMeta.normalized) {
        const missingSignature = classifyMootaSignatureMissing_(mootaCfg, signatureMeta);
        logMootaSignatureEvent_("SIGNATURE_MISSING", signatureMeta, {
          reason: missingSignature.code,
          payload_bytes: payloadString.length,
          webhook_host: getMootaUrlHost_(mootaCfg.gasUrl),
          likely_direct_apps_script: isDirectAppsScriptUrl_(mootaCfg.gasUrl),
          troubleshooting_hint: isDirectAppsScriptUrl_(mootaCfg.gasUrl)
            ? "Webhook Moota diarahkan langsung ke Google Apps Script. Gunakan endpoint Worker/proxy publik."
            : "Pastikan header Signature dari Moota diteruskan ke query param moota_signature atau signature."
        });
        return ContentService.createTextOutput(missingSignature.message)
          .setMimeType(ContentService.MimeType.TEXT);
      }

      const signatureCheck = verifyMootaSignature_(payloadString, mootaCfg.token, signatureMeta.raw);
      if (!signatureCheck.ok) {
        const invalidSignatureMessage = signatureMeta.workerVerifiedSignature
          ? "ERROR: Invalid Signature. Signature sudah lolos verifikasi di Worker, jadi kemungkinan Secret Token di Apps Script berbeda dengan Secret Token di Worker/Moota."
          : "ERROR: Invalid Signature. Periksa Secret Token dan pastikan payload tidak diubah sebelum diverifikasi.";
        logMootaSignatureEvent_("SIGNATURE_INVALID", signatureMeta, {
          payload_bytes: payloadString.length,
          webhook_host: getMootaUrlHost_(mootaCfg.gasUrl),
          expected_signature: maskMootaSignatureForLog_(signatureCheck.expected),
          received_signature: maskMootaSignatureForLog_(signatureCheck.received),
          validation_code: signatureCheck.code,
          worker_verified_signature: signatureMeta.workerVerifiedSignature
        });
        return ContentService.createTextOutput(invalidSignatureMessage)
          .setMimeType(ContentService.MimeType.TEXT);
      }

      logMootaSignatureEvent_("SIGNATURE_OK", signatureMeta, {
        payload_bytes: payloadString.length,
        webhook_host: getMootaUrlHost_(mootaCfg.gasUrl)
      });

      const isMootaTest = String((e.parameter && e.parameter.test_mode) || "").trim() === "1"
        || data.some(function(item) {
          return item && (item.is_test === true || String(item.description || "").toUpperCase() === "MOOTA TEST");
        });
      if (isMootaTest) {
        return jsonRes({
          status: "success",
          message: "Test webhook Moota berhasil.",
          secret_token_configured: true,
          signature_verified: true,
          signature_source: signatureMeta.source,
          forwarded_by_worker: signatureMeta.forwardedByWorker,
          mutations_received: data.length
        });
      }

      return handleMootaWebhook(data, cfg);
    }

    // ====================================================================
    // JIKA BUKAN DARI MOOTA, JALANKAN PERINTAH DARI WEBSITE (FRONTEND)
    // ====================================================================
    const action = data.action;
    switch (action) {
      case "get_global_settings": return jsonRes(getGlobalSettings(cfg));
      case "get_product": return jsonRes(getProductDetail(data, cfg));
      case "get_products": return jsonRes(getProducts(data, cfg));
      case "create_order": return jsonRes(createOrder(data, cfg));
      case "update_order_status": return jsonRes(updateOrderStatus(data, cfg));
      case "login": return jsonRes(loginUser(data));
      case "login_and_dashboard": return jsonRes(loginAndDashboard(data));
      case "get_page_content": return jsonRes(getPageContent(data));
      case "get_pages": return jsonRes(getAllPages(data));
      case "get_public_cache_state": return jsonRes(getPublicCacheState());
      case "admin_login": return jsonRes(adminLogin(data));
      case "admin_logout": return jsonRes(adminLogout(data));
      case "get_admin_data": return jsonRes(getAdminData(data, cfg));
      case "save_product": return jsonRes(saveProduct(data));
      case "save_page": return jsonRes(savePage(data));
      case "update_settings": return jsonRes(updateSettings(data));
      case "update_moota_gateway": return jsonRes(updateMootaGatewaySettings(data));
      case "update_imagekit_media": return jsonRes(updateImageKitMediaSettings(data));
      case "import_moota_config": return jsonRes(importMootaConfig(data));
      case "get_ik_auth": return jsonRes(getImageKitAuth(data, cfg));
      case "get_media_files": return jsonRes(getIkFiles(data, cfg));
      case "test_ik_config": return jsonRes(testImageKitConfig(data, cfg));
      case "test_moota_config": return jsonRes(testMootaConfig(data, cfg));
      case "purge_cf_cache": return jsonRes(purgeCFCache(data, cfg));
      case "change_password": return jsonRes(changeUserPassword(data));
      case "update_profile": return jsonRes(updateUserProfile(data));
      case "forgot_password": return jsonRes(forgotPassword(data));
      case "get_dashboard_data": return jsonRes(getDashboardData(data));
      case "delete_product": return jsonRes(deleteProduct(data));
      case "delete_page": return jsonRes(deletePage(data));
      case "check_slug": return jsonRes(checkSlug(data));
      case "save_affiliate_pixel": return jsonRes(saveAffiliatePixel(data));
      case "get_admin_orders": return jsonRes(getAdminOrders(data));
      case "get_admin_users": return jsonRes(getAdminUsers(data));

      // DIAGNOSTIC & MONITORING ACTIONS
      case "get_email_logs":
      case "get_moota_logs":
      case "get_wa_logs":
      case "test_email":
      case "test_wa":
      case "test_lunas_notification":
      case "get_system_health":
      case "get_email_quota":
      case "debug_login":
      case "test_auth":
      case "test_moota_validation":
      case "test_moota_signature":
      case "purge_sync_logs":
      case "audit_sync_logs_cleanup":
        assertPrivilegedAction_(data, cfg);
        if (action === "get_email_logs") return jsonRes(getEmailLogs_());
        if (action === "get_moota_logs") return jsonRes(getMootaLogs_());
        if (action === "get_wa_logs") return jsonRes(getWALogs_());
        if (action === "test_email") return jsonRes(testEmailDelivery(data));
        if (action === "test_wa") return jsonRes(testWADelivery(data));
        if (action === "test_lunas_notification") return jsonRes(testLunasNotification(data));
        if (action === "get_system_health") return jsonRes(getSystemHealth());
        if (action === "get_email_quota") return jsonRes(getEmailQuotaStatus());
        if (action === "debug_login") return jsonRes(debugLogin(data));
        if (action === "test_auth") return jsonRes(runAuthTests());
        if (action === "test_moota_validation") return jsonRes(runMootaValidationTests());
        if (action === "test_moota_signature") return jsonRes(runMootaSignatureTests());
        if (action === "purge_sync_logs") return jsonRes(purgeSyncLogsArtifacts_(false, data));
        if (action === "audit_sync_logs_cleanup") return jsonRes(purgeSyncLogsArtifacts_(true, data));
        return jsonRes({ status: "error", message: "Unsupported privileged action" });

      default: return jsonRes({ status: "error", message: "Aksi tidak terdaftar: " + (action || "unknown") });
    }
  } catch (err) {
    return jsonRes({ status: "error", message: err.toString() });
  }
}



/* =========================
   WHITE-LABEL GLOBAL SETTINGS
========================= */
function getGlobalSettings(cfg) {
  cfg = cfg || getSettingsMap_();
  return withPublicCacheVersion_({
    status: "success",
    data: {
      site_name: getCfgFrom_(cfg, "site_name") || "Sistem Premium",
      site_tagline: getCfgFrom_(cfg, "site_tagline") || "Platform Produk Digital Terbaik",
      site_favicon: sanitizeAssetUrl_(getCfgFrom_(cfg, "site_favicon") || ""),
      site_logo: sanitizeAssetUrl_(getCfgFrom_(cfg, "site_logo") || ""),
      contact_email: getCfgFrom_(cfg, "contact_email") || "",
      wa_admin: getCfgFrom_(cfg, "wa_admin") || ""
    }
  }, "settings");
}

/* =========================
   CLOUDFLARE PURGE
========================= */
function purgeCFCache(d, cfg) {
  try {
    requireAdminSession_(d, { actionName: "purge_cf_cache" });
    cfg = cfg || getSettingsMap_();
    const zoneId = getSecret_("cf_zone_id", cfg);
    const token = getSecret_("cf_api_token", cfg);
    if (!zoneId || !token) return { status: "error", message: "Konfigurasi Cloudflare belum disetting!" };

    const options = {
      method: "post",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      payload: JSON.stringify({ purge_everything: true }),
      muteHttpExceptions: true
    };

    const res = UrlFetchApp.fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, options);
    const body = JSON.parse(res.getContentText());

    if (body && body.success) {
      return { status: "success", message: "🚀 Cache Berhasil Dibersihkan!" };
    }
    const msg = (body && body.errors && body.errors.length) ? JSON.stringify(body.errors) : "Cloudflare Error";
    return { status: "error", message: msg };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function testMootaConfig(d, cfg) {
  requireAdminSession_(d, { actionName: "test_moota_config" });
  cfg = cfg || getSettingsMap_();
  const mootaCfg = resolveMootaConfig_(d, cfg);
  const errors = validateMootaConfigFormat_(mootaCfg);
  if (errors.length) {
    return { status: "error", message: errors[0], errors: errors };
  }

  if (isDirectAppsScriptUrl_(mootaCfg.gasUrl)) {
    logMoota_("CONFIG_TEST_BLOCKED", JSON.stringify({
      reason: "direct_apps_script_url",
      webhook_host: getMootaUrlHost_(mootaCfg.gasUrl),
      troubleshooting_hint: "Gunakan endpoint Cloudflare Worker atau proxy publik, bukan URL Google Apps Script langsung."
    }));
    return {
      status: "error",
      message: "Link webhook Moota tidak boleh langsung ke Google Apps Script. Gunakan endpoint Cloudflare Worker atau proxy publik agar header Signature bisa diteruskan.",
      code: "direct_apps_script_url"
    };
  }

  const payloadText = JSON.stringify([{
    amount: 1,
    type: "CR",
    description: "MOOTA TEST",
    is_test: true,
    created_at: new Date().toISOString()
  }]);

  const signature = computeMootaSignatureHex_(payloadText, mootaCfg.token);

  const targetUrl = appendQueryParams_(mootaCfg.gasUrl, {
    test_mode: "1",
    moota_signature: signature
  });

  try {
    const res = UrlFetchApp.fetch(targetUrl, {
      method: "post",
      contentType: "application/json",
      headers: {
        "Signature": signature,
        "X-MOOTA-USER": "test-user",
        "X-MOOTA-WEBHOOK": "test-webhook",
        "User-Agent": "MootaBot/1.5"
      },
      payload: payloadText,
      muteHttpExceptions: true,
      followRedirects: true
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}

    if (code >= 200 && code < 300 && data && data.status === "success") {
      return {
        status: "success",
        message: "Koneksi webhook Moota berhasil diuji.",
        gas_url: mootaCfg.gasUrl,
        secret_token_configured: !!mootaCfg.token,
        signature_preview: maskMootaSignatureForLog_(signature),
        response: data
      };
    }

    let message = "Test koneksi Moota gagal.";
    if (data && data.message) {
      message = String(data.message);
    } else if (text) {
      message = "Webhook Moota error HTTP " + code + ": " + String(text).substring(0, 200);
    }

    return {
      status: "error",
      message: message,
      http_code: code
    };
  } catch (e) {
    return {
      status: "error",
      message: "Gagal menghubungi webhook Moota: " + e.toString()
    };
  }
}

function getIkFiles(d, cfg) {
  requireAdminSession_(d, { actionName: "get_media_files" });
  cfg = cfg || getSettingsMap_();
  const ikCfg = resolveImageKitConfig_({}, cfg);
  const errors = validateImageKitConfigFormat_(ikCfg, { requirePublic: false, requireEndpoint: false, requirePrivate: true });
  if (errors.length) return { status: "error", message: errors[0] };

  const result = fetchImageKitFiles_(ikCfg.privateKey, 20);
  if (!result.ok) return { status: "error", message: result.message };

  const files = result.files.map(function(f) {
    return {
      name: f.name,
      url: f.url,
      thumbnail: f.thumbnailUrl || f.url,
      fileId: f.fileId,
      type: f.fileType
    };
  });
  return { status: "success", files: files };
}

/* =========================
   LOGGING HELPERS
========================= */
function logEmail_(status, to, subject, detail) {
  try {
    let s = ss.getSheetByName("Email_Logs");
    if (!s) {
      s = ss.insertSheet("Email_Logs");
      s.appendRow(["Timestamp", "Status", "To", "Subject", "Detail"]);
      s.setFrozenRows(1);
    }
    s.appendRow([new Date(), status, to, subject, String(detail).substring(0, 500)]);
    // Auto-trim: keep max 500 rows
    if (s.getLastRow() > 500) s.deleteRows(2, s.getLastRow() - 500);
  } catch (e) {
    Logger.log("logEmail_ error: " + e);
  }
}

function logMoota_(type, detail) {
  try {
    let s = ss.getSheetByName("Moota_Logs");
    if (!s) {
      s = ss.insertSheet("Moota_Logs");
      s.appendRow(["Timestamp", "Type", "Detail"]);
      s.setFrozenRows(1);
    }
    s.appendRow([new Date(), type, String(detail).substring(0, 1000)]);
    // Auto-trim: keep max 500 rows
    if (s.getLastRow() > 500) s.deleteRows(2, s.getLastRow() - 500);
  } catch (e) {
    Logger.log("logMoota_ error: " + e);
  }
}

function logWA_(status, target, detail) {
  try {
    let s = ss.getSheetByName("WA_Logs");
    if (!s) {
      s = ss.insertSheet("WA_Logs");
      s.appendRow(["Timestamp", "Status", "Target", "Detail"]);
      s.setFrozenRows(1);
    }
    s.appendRow([new Date(), status, target, String(detail).substring(0, 500)]);
    if (s.getLastRow() > 500) s.deleteRows(2, s.getLastRow() - 500);
  } catch (e) {
    Logger.log("logWA_ error: " + e);
  }
}

function invalidateCaches_(keys) {
  try {
    const cache = CacheService.getScriptCache();
    (keys || []).forEach(k => {
      try { cache.remove(String(k)); } catch (e) { }
    });
  } catch (e) { }
}

function referencesSyncLogs_(text) {
  return /(^|[^a-z0-9])sync[_\s]?logs([^a-z0-9]|$)/i.test(String(text || ""));
}

function normalizeEmailSafe_(value) {
  return String(value || "").trim().toLowerCase();
}

function buildSyncLogsBackup_(sheet, report) {
  const backupName = "Sync_Logs_Backup_" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");
  const backupSs = SpreadsheetApp.create(backupName);
  const manifest = backupSs.getSheetByName("Sheet1") || backupSs.getSheets()[0];
  manifest.setName("Manifest");
  manifest.clear();
  manifest.appendRow(["Section", "Key", "Value"]);
  manifest.appendRow(["summary", "source_spreadsheet_id", ss.getId()]);
  manifest.appendRow(["summary", "source_spreadsheet_name", ss.getName()]);
  manifest.appendRow(["summary", "generated_at", new Date().toISOString()]);
  manifest.appendRow(["summary", "sheet_found", String(!!sheet)]);
  manifest.appendRow(["summary", "formulas_detected", String(report.formulas_detected || 0)]);
  manifest.appendRow(["summary", "protections_detected", String(report.protections_removed || 0)]);
  manifest.appendRow(["summary", "metadata_detected", String(report.metadata_removed || 0)]);

  if (sheet) {
    const copied = sheet.copyTo(backupSs);
    copied.setName("Sync_Logs");
  }

  const rows = [];
  (report.formula_locations || []).forEach(function (item) {
    rows.push(["formula", item.sheet + "!" + item.cell, item.formula]);
  });
  (report.named_ranges_removed || []).forEach(function (name) {
    rows.push(["named_range", name, "removed"]);
  });
  (report.triggers_removed || []).forEach(function (item) {
    rows.push(["trigger", item.handler, item.event_type]);
  });
  (report.script_properties_removed || []).forEach(function (name) {
    rows.push(["script_property", name, "removed"]);
  });
  (report.permission_snapshot || []).forEach(function (item) {
    rows.push(["permission", item.role, item.email]);
  });
  (report.notes || []).forEach(function (note, idx) {
    rows.push(["note", String(idx + 1), note]);
  });

  if (rows.length > 0) {
    manifest.getRange(2 + 7, 1, rows.length, 3).setValues(rows);
  }

  const sheets = backupSs.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName() === "Sheet1" && sheets.length > 1) {
      backupSs.deleteSheet(sheets[i]);
      break;
    }
  }

  return {
    id: backupSs.getId(),
    url: backupSs.getUrl(),
    name: backupSs.getName()
  };
}

function captureFilePermissions_() {
  const snapshot = [];
  try {
    const file = DriveApp.getFileById(ss.getId());
    const owner = file.getOwner();
    if (owner) snapshot.push({ role: "owner", email: normalizeEmailSafe_(owner.getEmail()) });
    file.getEditors().forEach(function (user) {
      snapshot.push({ role: "editor", email: normalizeEmailSafe_(user.getEmail()) });
    });
    file.getViewers().forEach(function (user) {
      snapshot.push({ role: "viewer", email: normalizeEmailSafe_(user.getEmail()) });
    });
  } catch (e) { }
  return snapshot.filter(function (item) { return !!item.email; });
}

function revokeFilePermissions_(options, report, dryRun) {
  const cfg = options || {};
  const shouldRevoke = !!cfg.revoke_file_access;
  report.permission_snapshot = captureFilePermissions_();
  if (!shouldRevoke) {
    report.notes.push("Spreadsheet-wide Drive sharing tidak diubah otomatis. Set revoke_file_access=true dan kirim revoke_access_emails jika memang ingin mencabut akses file.");
    return;
  }

  const revokeList = Array.isArray(cfg.revoke_access_emails) ? cfg.revoke_access_emails.map(normalizeEmailSafe_).filter(Boolean) : [];
  const keepList = Array.isArray(cfg.keep_access_emails) ? cfg.keep_access_emails.map(normalizeEmailSafe_).filter(Boolean) : [];
  if (revokeList.length === 0) {
    report.notes.push("revoke_file_access=true tapi revoke_access_emails kosong, jadi tidak ada akses file yang dicabut.");
    return;
  }

  try {
    const file = DriveApp.getFileById(ss.getId());
    const ownerEmail = normalizeEmailSafe_(file.getOwner() && file.getOwner().getEmail());
    revokeList.forEach(function (email) {
      if (!email || email === ownerEmail || keepList.indexOf(email) !== -1) return;
      report.permissions_revoked.push(email);
      if (dryRun) return;
      try { file.removeEditor(email); } catch (e) { }
      try { file.removeViewer(email); } catch (e) { }
    });
  } catch (e) {
    report.notes.push("Gagal memproses revokasi akses file: " + String(e));
  }
}

function purgeSyncLogsArtifacts_(dryRun, options) {
  try {
    const cfg = options || {};
    const runMode = dryRun ? "dry_run" : "delete";
    const report = {
      status: "success",
      mode: runMode,
      sheet_found: false,
      sheet_deleted: false,
      formulas_replaced: 0,
      formulas_detected: 0,
      formula_locations: [],
      named_ranges_removed: [],
      protections_removed: 0,
      triggers_removed: [],
      script_properties_removed: [],
      metadata_removed: 0,
      permissions_revoked: [],
      permission_snapshot: [],
      backup_created: false,
      backup_id: "",
      backup_url: "",
      notes: []
    };

    const sheet = ss.getSheetByName("Sync_Logs");
    report.sheet_found = !!sheet;

    const sheets = ss.getSheets();
    for (let i = 0; i < sheets.length; i++) {
      const sh = sheets[i];
      const range = sh.getDataRange();
      if (!range) continue;
      const formulas = range.getFormulas();
      const values = range.getValues();
      for (let r = 0; r < formulas.length; r++) {
        for (let c = 0; c < formulas[r].length; c++) {
          const f = String(formulas[r][c] || "").trim();
          if (!f || !referencesSyncLogs_(f)) continue;
          report.formulas_detected++;
          if (report.formula_locations.length < 100) {
            report.formula_locations.push({
              sheet: sh.getName(),
              cell: range.getCell(r + 1, c + 1).getA1Notation(),
              formula: f.substring(0, 200)
            });
          }
          if (!dryRun) {
            range.getCell(r + 1, c + 1).setValue(values[r][c]);
            report.formulas_replaced++;
          }
        }
      }
    }

    const namedRanges = ss.getNamedRanges();
    for (let i = 0; i < namedRanges.length; i++) {
      const nr = namedRanges[i];
      let targetSheet = "";
      try { targetSheet = nr.getRange().getSheet().getName(); } catch (e) { }
      const matched = referencesSyncLogs_(nr.getName()) || referencesSyncLogs_(targetSheet);
      if (!matched) continue;
      report.named_ranges_removed.push(nr.getName());
      if (!dryRun) nr.remove();
    }

    const metadataItems = ss.getDeveloperMetadata();
    for (let i = 0; i < metadataItems.length; i++) {
      const md = metadataItems[i];
      const mk = String(md.getKey() || "");
      const mv = String(md.getValue() || "");
      if (!referencesSyncLogs_(mk) && !referencesSyncLogs_(mv)) continue;
      if (!dryRun) md.remove();
      report.metadata_removed++;
    }

    if (sheet) {
      const sheetProtections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
      for (let i = 0; i < sheetProtections.length; i++) {
        if (!dryRun) sheetProtections[i].remove();
        report.protections_removed++;
      }
      const rangeProtections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
      for (let i = 0; i < rangeProtections.length; i++) {
        if (!dryRun) rangeProtections[i].remove();
        report.protections_removed++;
      }
    }

    const triggers = ScriptApp.getProjectTriggers();
    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i];
      const handler = String(t.getHandlerFunction() || "");
      if (!/(sync[_\s-]?logs?|sync[_\s-]?state|cepat[_\s-]?sync)/i.test(handler)) continue;
      report.triggers_removed.push({
        handler: handler,
        event_type: String(t.getEventType())
      });
      if (!dryRun) ScriptApp.deleteTrigger(t);
    }

    const props = PropertiesService.getScriptProperties();
    const allProps = props.getProperties();
    Object.keys(allProps).forEach(function (k) {
      const key = String(k || "");
      const val = String(allProps[k] || "");
      if (!referencesSyncLogs_(key) && !referencesSyncLogs_(val) && !/sync_state|cepat_sync/i.test(key)) return;
      report.script_properties_removed.push(key);
      if (!dryRun) props.deleteProperty(key);
    });

    revokeFilePermissions_(cfg, report, dryRun);

    if (!dryRun && cfg.create_backup !== false) {
      const backup = buildSyncLogsBackup_(sheet, report);
      report.backup_created = true;
      report.backup_id = backup.id;
      report.backup_url = backup.url;
      report.notes.push("Backup rollback dibuat di spreadsheet terpisah: " + backup.name);
    }

    if (sheet && !dryRun) {
      if (ss.getSheets().length === 1) {
        ss.insertSheet("System_Main");
        report.notes.push("Sync_Logs adalah sheet terakhir, dibuat sheet pengganti 'System_Main' sebelum delete.");
      }
      ss.deleteSheet(sheet);
      report.sheet_deleted = true;
    }

    if (!sheet) report.notes.push("Sheet Sync_Logs tidak ditemukan.");
    if (dryRun) report.notes.push("Dry run aktif: tidak ada perubahan yang ditulis.");
    return report;
  } catch (e) {
    return { status: "error", message: String(e) };
  }
}

/* =========================
   NOTIFICATIONS
========================= */

/**
 * Normalize Indonesian phone number for Fonnte API.
 * Strips non-digits, handles +62/62/0 prefix variations.
 * Returns clean number like "81234567890" (without country code prefix).
 */
function normalizePhone_(raw) {
  if (!raw) return "";
  // Remove all non-digit characters (+, -, spaces, parens, etc)
  let num = String(raw).replace(/[^0-9]/g, "");
  // Handle country code prefix
  if (num.startsWith("620")) num = num.substring(3); // 6208xxx → 8xxx
  else if (num.startsWith("62")) num = num.substring(2); // 628xxx → 8xxx
  // Remove leading 0 if present
  if (num.startsWith("0")) num = num.substring(1); // 08xxx → 8xxx
  return num;
}

function sendWA(target, message, cfg) {
  if (!target) {
    logWA_("SKIP", "(empty)", "No target number provided");
    return { success: false, reason: "no_target" };
  }
  cfg = cfg || getSettingsMap_();
  const token = getSecret_("fonnte_token", cfg) || getCfg("fonnte_token");
  if (!token) {
    logWA_("NO_TOKEN", target, "fonnte_token not configured in Settings");
    return { success: false, reason: "no_fonnte_token" };
  }

  // Normalize phone number: strip all non-digits, handle prefix
  const cleanTarget = normalizePhone_(target);
  if (!cleanTarget || cleanTarget.length < 9) {
    logWA_("INVALID_NUMBER", String(target), "After normalization: '" + cleanTarget + "' (too short or empty)");
    return { success: false, reason: "invalid_phone_number" };
  }

  const MAX_RETRIES = 2;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = UrlFetchApp.fetch("https://api.fonnte.com/send", {
        method: "post",
        headers: { "Authorization": token },
        payload: {
          target: cleanTarget,
          message: message,
          countryCode: "62"
        },
        muteHttpExceptions: true
      });

      const httpCode = res.getResponseCode();
      const resText = res.getContentText();

      // Validate Fonnte API response
      if (httpCode >= 200 && httpCode < 300) {
        try {
          const resJson = JSON.parse(resText);
          if (resJson.status === true || resJson.status === "true") {
            logWA_("SENT", cleanTarget, "OK (attempt " + attempt + ") | Detail: " + String(resJson.detail || resJson.message || "").substring(0, 100));
            return { success: true };
          } else {
            // Fonnte returned 200 but status=false (invalid number, quota, etc)
            const reason = String(resJson.reason || resJson.detail || resJson.message || "Unknown").substring(0, 200);
            if (attempt >= MAX_RETRIES) {
              logWA_("REJECTED", cleanTarget, "Fonnte rejected: " + reason + " | Raw response: " + resText.substring(0, 200));
              return { success: false, reason: reason };
            }
          }
        } catch (parseErr) {
          // Non-JSON response but HTTP 200 - treat as success
          logWA_("SENT_UNVERIFIED", cleanTarget, "HTTP " + httpCode + " but non-JSON response (attempt " + attempt + ")");
          return { success: true };
        }
      } else {
        // HTTP error (401, 403, 500, etc)
        if (attempt >= MAX_RETRIES) {
          logWA_("HTTP_ERROR", cleanTarget, "HTTP " + httpCode + ": " + resText.substring(0, 200));
          return { success: false, reason: "HTTP " + httpCode };
        }
      }

      // Wait before retry
      if (attempt < MAX_RETRIES) Utilities.sleep(1000);

    } catch (e) {
      if (attempt >= MAX_RETRIES) {
        logWA_("EXCEPTION", cleanTarget, e.toString());
        return { success: false, reason: e.toString() };
      }
      Utilities.sleep(1000);
    }
  }
  return { success: false, reason: "exhausted_retries" };
}

function sendEmail(target, subject, body, cfg) {
  if (!target) return { success: false, reason: "no_target" };
  cfg = cfg || getSettingsMap_();

  // Check daily quota first
  const remaining = MailApp.getRemainingDailyQuota();
  if (remaining <= 0) {
    logEmail_("QUOTA_EXCEEDED", target, subject, "Daily email quota exceeded (remaining: " + remaining + ")");
    // Fallback: alert admin via WA
    const adminWA = getCfgFrom_(cfg, "wa_admin");
    if (adminWA) {
      sendWA(adminWA, "⚠️ *EMAIL QUOTA HABIS!*\n\nEmail ke " + target + " GAGAL terkirim karena quota harian habis.\nSubject: " + subject, cfg);
    }
    return { success: false, reason: "quota_exceeded" };
  }

  const senderName = getCfgFrom_(cfg, "site_name") || "Admin Sistem";
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      MailApp.sendEmail({ to: target, subject: subject, htmlBody: body, name: senderName });
      logEmail_("SENT", target, subject, "OK (attempt " + attempt + ", quota left: " + (remaining - 1) + ")");
      return { success: true };
    } catch (e) {
      Logger.log("sendEmail attempt " + attempt + " failed: " + e);
      if (attempt < MAX_RETRIES) {
        Utilities.sleep(1000 * attempt); // Exponential backoff: 1s, 2s
      } else {
        logEmail_("FAILED", target, subject, e.toString());
        // Fallback: alert admin via WA
        const adminWA = getCfgFrom_(cfg, "wa_admin");
        if (adminWA) {
          sendWA(adminWA, "❌ *EMAIL GAGAL TERKIRIM!*\n\nKe: " + target + "\nSubject: " + subject + "\nError: " + String(e).substring(0, 200), cfg);
        }
        return { success: false, reason: e.toString() };
      }
    }
  }
}

function getEmailQuotaStatus() {
  const remaining = MailApp.getRemainingDailyQuota();
  return { status: "success", remaining: remaining, limit: 100, warning: remaining < 10 };
}

/* =========================
   CREATE ORDER (ANGKA UNIK + WHITE-LABEL + AFFILIATE)
========================= */
function createOrder(d, cfg) {
  try {
    if (getAdminSessionToken_(d)) {
      requireAdminSession_(d, { actionName: "create_order" });
    }
    cfg = cfg || getSettingsMap_();

    const oS = mustSheet_("Orders");
    const uS = mustSheet_("Users");

    const inv = "INV-" + Math.floor(10000 + Math.random() * 90000);
    const email = String(d.email || "").trim().toLowerCase();
    if (!email) return { status: "error", message: "Email wajib diisi" };

    // Normalize WhatsApp number at storage time
    const waRaw = String(d.whatsapp || "").trim();
    const waNormalized = normalizePhone_(waRaw);
    if (waRaw && !waNormalized) {
      Logger.log("WARNING: WA number normalization failed for: " + waRaw);
    }

    const siteName = getCfgFrom_(cfg, "site_name") || "Sistem Premium";
    const siteUrl = String(getCfgFrom_(cfg, "site_url") || "").trim();
    const loginUrl = siteUrl ? (siteUrl + "/login.html") : "Link Login Belum Disetting";

    const bankName = getCfgFrom_(cfg, "bank_name") || "-";
    const bankNorek = getCfgFrom_(cfg, "bank_norek") || "-";
    const bankOwner = getCfgFrom_(cfg, "bank_owner") || "-";

    const aff = (d.affiliate && String(d.affiliate).trim() !== "") ? String(d.affiliate).trim() : "-";

    const hargaDasar = toNumberSafe_(d.harga);
    
    // MODIFIED: Allow 0 price (Free Product)
    const isZeroPrice = hargaDasar === 0;
    if (!isZeroPrice && hargaDasar <= 0) return { status: "error", message: "Harga tidak valid" };

    let komisiNominal = 0;
    
    // Lookup Product Commission
    const pId = String(d.id_produk || "").trim();
    if (pId && aff !== "-") {
        const rules = mustSheet_("Access_Rules").getDataRange().getValues();
        for (let i = 1; i < rules.length; i++) {
            if (String(rules[i][0]) === pId) {
                // Commission is in column 12 (index 11)
                komisiNominal = Number(rules[i][11] || 0);
                break;
            }
        }
    }

    const kodeUnik = isZeroPrice ? 0 : (Math.floor(Math.random() * 900) + 100);
    const hargaTotalUnik = hargaDasar + kodeUnik;

    // Cek atau Buat User Baru
    let isNew = true;
    let pass = Math.random().toString(36).slice(-6);

    const uData = uS.getDataRange().getValues();
    for (let j = 1; j < uData.length; j++) {
      if (String(uData[j][1]).toLowerCase() === email) {
        isNew = false;
        pass = String(uData[j][2]);
        break;
      }
    }
    if (isNew) {
      // Generate Friendly Unique ID (u-XXXXXX)
      let newUserId = "u-" + Math.floor(100000 + Math.random() * 900000);
      let unique = false;
      while(!unique) {
          unique = true;
          for(let k=1; k<uData.length; k++) {
              if(String(uData[k][0]) === newUserId) {
                  unique = false;
                  newUserId = "u-" + Math.floor(100000 + Math.random() * 900000);
                  break;
              }
          }
      }
      uS.appendRow([newUserId, email, hashPassword_(pass), d.nama, "member", "Active", toISODate_(), "-"]);
    }

    const orderStatus = isZeroPrice ? "Lunas" : "Pending";

    // Simpan order (struktur kolom sama dengan script lu)
    // Store WA number as text (prefix with apostrophe prevents Google Sheets from converting to Number)
    const waForSheet = waNormalized || waRaw;
    oS.appendRow([
      inv,
      email,
      d.nama,
      "'" + waForSheet,
      d.id_produk,
      d.nama_produk,
      hargaTotalUnik,
      orderStatus,
      toISODate_(),
      aff,
      komisiNominal
    ]);

    // ==========================================
    // NOTIFIKASI (LOGIC CABANG: GRATIS vs BAYAR)
    // ==========================================
    
    const adminWA = getCfgFrom_(cfg, "wa_admin");

    if (isZeroPrice) {
       // --- SKENARIO PRODUK GRATIS (AUTO LUNAS) ---
       
       // 1. Ambil Link Akses
       let accessUrl = "";
       const pS = mustSheet_("Access_Rules");
       const pData = pS.getDataRange().getValues();
       for (let k = 1; k < pData.length; k++) {
         if (String(pData[k][0]) === String(d.id_produk)) { accessUrl = pData[k][3]; break; }
       }
       
       // 2. WA ke User (use normalized number)
       const waText = `Halo ${d.nama}, selamat datang di ${siteName}! 🎉\n\nSukses! Akses Anda untuk produk *${d.nama_produk}* telah aktif (GRATIS).\n\n🚀 *Klik link berikut untuk akses materi:*\n${accessUrl}\n\n🔐 *AKUN MEMBER AREA*\n🌐 Link: ${loginUrl}\n✉️ Email: ${email}\n🔑 Password: ${pass}\n\nTerima kasih!\n*Tim ${siteName}*`;
       sendWA(waForSheet, waText, cfg);

       // 3. Email ke User
       const emailHtml = `
       <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #334155; border: 1px solid #e2e8f0; border-radius: 10px;">
          <h2 style="color: #10b981;">Akses Produk Gratis Dibuka! 🎁</h2>
          <p>Halo <b>${d.nama}</b>,</p>
          <p>Selamat! Anda telah berhasil mendapatkan akses ke produk <b>${d.nama_produk}</b> secara GRATIS.</p>
          
          <div style="text-align: center; margin: 30px 0;">
              <a href="${accessUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Akses Materi Sekarang</a>
          </div>

          <h3 style="color: #0f172a;">🔐 Akun Member Area</h3>
          <p><b>Link:</b> <a href="${loginUrl}">${loginUrl}</a><br>
          <b>Email:</b> ${email}<br>
          <b>Password:</b> <code>${pass}</code></p>
          
          <p>Salam hangat,<br><b>Tim ${siteName}</b></p>
       </div>`;
       sendEmail(email, `Akses Gratis! Produk ${d.nama_produk}`, emailHtml, cfg);

       // 4. Notif Admin
       sendWA(adminWA, `🎁 *ORDER GRATIS BARU!* 🎁\n\n📌 *Invoice:* #${inv}\n📦 *Produk:* ${d.nama_produk}\n👤 *User:* ${d.nama}\n\nStatus: Lunas (Auto)`, cfg);

    } else {
       // --- SKENARIO BERBAYAR (PENDING) ---

       // --> NOTIFIKASI PEMBELI (WHATSAPP)
    const waBuyerText =
`Halo *${d.nama}*, salam hangat dari ${siteName}! 👋

Terima kasih telah melakukan pemesanan. Berikut rincian pesanan Anda:

📦 *Produk:* ${d.nama_produk}
🔖 *Invoice:* #${inv}
💰 *Total Tagihan:* Rp ${Number(hargaTotalUnik).toLocaleString('id-ID')}

⚠️ _(Penting: Transfer *TEPAT* hingga 3 digit terakhir agar sistem dapat memvalidasi otomatis)_

Silakan selesaikan pembayaran ke rekening berikut:

🏦 *Bank:* ${bankName}
💳 *No. Rek:* ${bankNorek}
👤 *A.n:* ${bankOwner}

*(Mohon kirimkan bukti transfer ke sini agar pesanan segera diproses)*

---

🔐 *INFORMASI AKUN MEMBER*
🌐 *Link Login:* ${loginUrl}
✉️ *Email:* ${email}
🔑 *Password:* ${pass}

*(Akses materi otomatis terbuka di akun ini setelah pembayaran divalidasi)*.

Jika ada pertanyaan, silakan balas pesan ini. Terima kasih! 🙏`;
    sendWA(waForSheet, waBuyerText, cfg);

    // --> NOTIFIKASI PEMBELI (EMAIL) (template asli lu)
    const emailBuyerHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #334155; border: 1px solid #e2e8f0; border-radius: 10px;">
        <h2 style="color: #4f46e5; margin-bottom: 5px;">Menunggu Pembayaran Anda ⏳</h2>
        <p style="font-size: 16px; margin-top: 0;">Halo <b>${d.nama}</b>,</p>
        <p>Terima kasih atas pesanan Anda di <b>${siteName}</b>. Berikut adalah detail tagihan yang harus dibayarkan:</p>

        <div style="background-color: #f8fafc; padding: 15px 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #4f46e5;">
            <p style="margin: 0 0 5px 0;"><b>Produk:</b> ${d.nama_produk}</p>
            <p style="margin: 0 0 5px 0;"><b>Invoice:</b> #${inv}</p>
            <p style="margin: 0; font-size: 20px; color: #0f172a;"><b>Total Tagihan: Rp ${Number(hargaTotalUnik).toLocaleString('id-ID')}</b></p>
            <p style="margin: 5px 0 0 0; font-size: 12px; color: #ef4444; font-weight: bold;">*Wajib transfer TEPAT hingga 3 digit angka terakhir.</p>
        </div>

        <p>Silakan selesaikan pembayaran ke rekening berikut:</p>

        <div style="background-color: #f1f5f9; padding: 15px 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
            <p style="margin: 0 0 5px 0; color: #64748b; text-transform: uppercase; font-size: 12px; font-weight: bold;">Transfer Ke Bank ${bankName}</p>
            <p style="margin: 0 0 5px 0; font-size: 22px; color: #4f46e5; font-family: monospace; font-weight: bold; letter-spacing: 2px;">${bankNorek}</p>
            <p style="margin: 0; font-size: 14px;"><b>A.n:</b> ${bankOwner}</p>
        </div>

        <p>Setelah transfer, konfirmasi melalui WhatsApp Admin agar produk segera kami aktifkan.</p>

        <hr style="border: none; border-top: 1px dashed #cbd5e1; margin: 30px 0;">

        <h3 style="color: #0f172a; margin-bottom: 10px;">🔐 Detail Akun Member Anda</h3>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; width: 100px;"><b>Link Login</b></td>
                <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><a href="${loginUrl}" style="color: #4f46e5; text-decoration: none;">${loginUrl}</a></td>
            </tr>
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><b>Email</b></td>
                <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${email}</td>
            </tr>
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><b>Password</b></td>
                <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><code style="background: #f1f5f9; padding: 3px 6px; border-radius: 4px;">${pass}</code></td>
            </tr>
        </table>

        <br>
        <p>Salam hangat,<br><b>Tim ${siteName}</b></p>
    </div>
    `;
    sendEmail(email, `Menunggu Pembayaran: Pesanan #${inv} - ${siteName}`, emailBuyerHtml, cfg);

    // --> NOTIFIKASI ADMIN
    const affMsg = aff !== "-" ? `\n🤝 *Affiliate:* ${aff}\n💸 *Potensi Komisi:* Rp ${Number(komisiNominal).toLocaleString('id-ID')}` : "";
    sendWA(adminWA, `🚨 *PESANAN BARU MASUK!* 🚨\n\n📌 *Invoice:* #${inv}\n📦 *Produk:* ${d.nama_produk}\n👤 *Customer:* ${d.nama}\n💳 *Nilai Unik:* Rp ${Number(hargaTotalUnik).toLocaleString('id-ID')}${affMsg}\n\nSilakan pantau pembayaran dari customer ini.`, cfg);
    } // End of Else (Paid)

    return { status: "success", invoice: inv, tagihan: hargaTotalUnik, is_new_user: isNew };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   UPDATE ORDER STATUS (MANUAL)
========================= */
function updateOrderStatus(d, cfg) {
  try {
    requireAdminSession_(d, { actionName: "update_order_status" });
    cfg = cfg || getSettingsMap_();
    const s = mustSheet_("Orders");
    const uS = mustSheet_("Users"); // kept for compatibility (even if not used)
    const pS = mustSheet_("Access_Rules");
    const r = s.getDataRange().getValues();
    const siteName = getCfgFrom_(cfg, "site_name") || "Sistem Premium";

    let orderFound = false, uEmail = "", uName = "", pId = "", pName = "", uWA = "";
    const newStatus = d.status || "Lunas";
    const isLunas = String(newStatus).trim().toLowerCase() === "lunas";

    // Trace ID for debugging this specific request
    const traceId = "UOS-" + Date.now();
    Logger.log(traceId + " updateOrderStatus called with id=" + d.id + " status=" + newStatus + " isLunas=" + isLunas);

    for (let i = 1; i < r.length; i++) {
      if (String(r[i][0]) === String(d.id)) {
        s.getRange(i + 1, 8).setValue(isLunas ? "Lunas" : newStatus);
        uEmail = r[i][1];
        uName = r[i][2];
        uWA = r[i][3];
        pId = r[i][4];
        pName = r[i][5];
        orderFound = true;
        Logger.log(traceId + " Order FOUND: row=" + (i+1) + " uWA=" + JSON.stringify(uWA) + " type=" + typeof uWA + " uEmail=" + uEmail);
        break;
      }
    }

    if (orderFound) {
      const cacheState = bumpPublicCacheState_(["dashboard"]);
      if (!isLunas) {
        Logger.log(traceId + " Not Lunas, returning early. newStatus=" + newStatus);
        return withPublicCacheState_({ status: "success", message: "Status berhasil diubah menjadi " + newStatus }, cacheState);
      }

      Logger.log(traceId + " Status=Lunas, proceeding with notifications...");

      let accessUrl = "";
      const pData = pS.getDataRange().getValues();
      for (let k = 1; k < pData.length; k++) {
        if (String(pData[k][0]) === String(pId)) { accessUrl = pData[k][3]; break; }
      }
      Logger.log(traceId + " accessUrl=" + accessUrl);

      // LOG: Debug notification target data before sending
      const waDebug = "uWA raw=" + JSON.stringify(uWA) + " type=" + typeof uWA + " normalized=" + normalizePhone_(uWA);
      logWA_("DEBUG_LUNAS", String(uWA), traceId + " | " + waDebug + " | Inv=" + d.id + " uEmail=" + uEmail);

      // STEP 1: Send WA to customer
      Logger.log(traceId + " Sending WA to: " + uWA);
      const waResult = sendWA(uWA, `🎉 *PEMBAYARAN TERVERIFIKASI!* 🎉\n\nHalo *${uName}*, kabar baik!\n\nPembayaran Anda untuk produk *${pName}* telah kami terima dan akses Anda kini *Telah Aktif*.\n\n🚀 *Klik link berikut untuk mengakses materi Anda:*\n${accessUrl}\n\nAnda juga bisa mengakses seluruh produk Anda melalui Member Area kami.\n\nTerima kasih atas kepercayaannya!\n*Tim ${siteName}*`, cfg);
      Logger.log(traceId + " WA Result: " + JSON.stringify(waResult));

      // STEP 2: Send Email to customer
      const emailActivationHtml = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #334155; border: 1px solid #e2e8f0; border-radius: 10px;">
          <div style="text-align: center; margin-bottom: 20px;">
              <h1 style="color: #10b981; margin-bottom: 5px;">Akses Telah Dibuka! 🎉</h1>
          </div>
          <p style="font-size: 16px;">Halo <b>${uName}</b>,</p>
          <p>Terima kasih! Pembayaran Anda telah berhasil kami verifikasi. Akses penuh untuk produk <b>${pName}</b> sekarang sudah aktif dan dapat Anda gunakan.</p>

          <div style="text-align: center; margin: 30px 0;">
              <a href="${accessUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; display: inline-block;">Akses Materi Sekarang</a>
          </div>

          <p>Sebagai alternatif, Anda selalu bisa menemukan semua produk yang Anda miliki dengan masuk ke Member Area menggunakan akun yang telah kami kirimkan sebelumnya.</p>

          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0;">
          <p style="font-size: 14px; color: #64748b; margin-bottom: 0;">Salam Sukses,<br><b>Tim ${siteName}</b></p>
      </div>
      `;
      Logger.log(traceId + " Sending Email to: " + uEmail);
      const emailResult = sendEmail(uEmail, `Akses Terbuka! Produk ${pName} - ${siteName}`, emailActivationHtml, cfg);
      Logger.log(traceId + " Email Result: " + JSON.stringify(emailResult));

      return withPublicCacheState_({ status: "success", trace: traceId, notifications: { wa: waResult, email: emailResult } }, cacheState);
    }

    return { status: "error", message: "Order tidak ditemukan" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   HELPER: GET AFFILIATE PIXEL
========================= */
function getAffiliatePixel_(userId, productId) {
  const s = ss.getSheetByName("Affiliate_Pixels");
  if (!s) return null;
  
  const d = s.getDataRange().getValues();
  for (let i = 1; i < d.length; i++) {
    if (String(d[i][0]) === String(userId) && String(d[i][1]) === String(productId)) {
      return {
        pixel_id: String(d[i][2]),
        pixel_token: String(d[i][3]),
        pixel_test_code: String(d[i][4])
      };
    }
  }
  return null;
}

/* =========================
   PRODUCT DETAIL
========================= */
function getProductDetail(d, cfg) {
  try {
    cfg = cfg || getSettingsMap_();
    const rules = mustSheet_("Access_Rules").getDataRange().getValues();
    const pId = String(d.id).trim();
    let productData = null;

    for (let i = 1; i < rules.length; i++) {
      if (String(rules[i][0]) === pId && String(rules[i][5]).trim() === "Active") {
        productData = { 
            id: pId, 
            title: normalizePlainText_(rules[i][1]), 
            desc: normalizeProductDescription_(rules[i][2]), 
            harga: rules[i][4],
            pixel_id: rules[i][8] || "",
            pixel_token: rules[i][9] || "",
            pixel_test_code: rules[i][10] || "",
            commission: rules[i][11] || 0
        };
        break;
      }
    }
    if (!productData) return { status: "error", message: "Produk tidak ditemukan" };

    // --> CHECK AFFILIATE PIXEL OVERRIDE
    const affRef = d.ref || d.aff_id;
    if (affRef) {
        const affPixel = getAffiliatePixel_(affRef, pId);
        if (affPixel && affPixel.pixel_id) {
            productData.pixel_id = affPixel.pixel_id;
            productData.pixel_token = affPixel.pixel_token;
            productData.pixel_test_code = affPixel.pixel_test_code;
            productData.is_affiliate_pixel = true;
        }
    }

    const paymentInfo = {
      bank_name: getCfgFrom_(cfg, "bank_name"),
      bank_norek: getCfgFrom_(cfg, "bank_norek"),
      bank_owner: getCfgFrom_(cfg, "bank_owner"),
      wa_admin: getCfgFrom_(cfg, "wa_admin"),

      pixel_id: productData.pixel_id, // Pass pixel_id (possibly overridden)
      pixel_token: productData.pixel_token,
      pixel_test_code: productData.pixel_test_code
    };

    let affName = "";
    if (d.aff_id && d.aff_id !== "GUEST" && d.aff_id !== "-") {
      const users = mustSheet_("Users").getDataRange().getValues();
      for (let j = 1; j < users.length; j++) {
        if (String(users[j][0]) === String(d.aff_id)) { affName = String(users[j][3]); break; }
      }
    }

    return withPublicCacheVersion_({ status: "success", data: productData, payment: paymentInfo, aff_name: affName }, "catalog");
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   GET PRODUCTS + KOMISI AFFILIATE
========================= */
function getProducts(d, cfg, cachedOrders) {
  cfg = cfg || getSettingsMap_();
  
  // OPTIMIZATION: Only fetch sheets if needed, reuse cached if passed
  const rules = getCachedData_("access_rules", () => {
     return mustSheet_("Access_Rules").getDataRange().getValues();
  }, 3600); // 1 hour cache for rules

  const orders = cachedOrders || mustSheet_("Orders").getDataRange().getValues();
  const users = mustSheet_("Users").getDataRange().getValues(); // Often changes, might need real-time
  
  let email = String(d.email || "").trim().toLowerCase();
  let targetMode = false;

  // Support fetching products for a specific user (Bio Page)
  if (d.target_user_id) {
      targetMode = true;
      const tUid = String(d.target_user_id).trim();
      for (let j = 1; j < users.length; j++) {
          if (String(users[j][0]) === tUid) {
              email = String(users[j][1]).trim().toLowerCase();
              break;
          }
      }
  }

  let lunasIds = [], totalKomisi = 0, uId = "";
  let partners = [];

  if (email) {
    for (let j = 1; j < users.length; j++) {
      if (String(users[j][1]).toLowerCase() === email) { uId = String(users[j][0]); break; }
    }
    for (let x = 1; x < orders.length; x++) {
      const r = orders[x];
      if (String(r[1]).toLowerCase() === email && String(r[7]) === "Lunas") lunasIds.push(String(r[4]));
      
      // Check for Partners (Referrals) - Only calculate if not in target mode (optional, but keeps it clean)
      if (!targetMode && String(r[9]) === uId) {
          if (String(r[7]) === "Lunas") totalKomisi += Number(r[10] || 0);
          
          partners.push({
              invoice: r[0],
              name: r[2],
              product: r[5],
              status: r[7],
              date: r[8] ? String(r[8]).substring(0, 10) : "-",
              commission: r[10] || 0
          });
      }
    }
  }

  let owned = [], available = [];
  for (let i = 1; i < rules.length; i++) {
    if (String(rules[i][5]).trim() === "Active") {
      const pId = String(rules[i][0]);
      const hasAccess = lunasIds.includes(pId);
      const pObj = {
        id: pId,
        title: normalizePlainText_(rules[i][1]),
        desc: normalizeProductDescription_(rules[i][2]),
        url: hasAccess ? rules[i][3] : "#",
        harga: rules[i][4],
        access: hasAccess,
        lp_url: rules[i][6] || "",
        image_url: rules[i][7] || "",
        commission: rules[i][11] || 0
      };
      
      if (targetMode) {
          // In Bio Page mode, we show what the user OWNS as the "Available Catalog" for visitors
          if (hasAccess) available.push(pObj);
      } else {
          // Normal Dashboard mode
          if (hasAccess && email) owned.push(pObj);
          else available.push(pObj);
      }
    }
  }

  return withPublicCacheVersion_({ status: "success", owned, available, total_komisi: totalKomisi, partners: partners.reverse() }, "catalog");
}

function getDashboardData(d) {
  try {
    const dashboardCacheVersion = publicCacheVersionToken_("dashboard");
    const cfg = getSettingsMap_();
    
    // 1. Get User ID & Admin ID from Users Sheet
    const email = String(d.email || "").trim().toLowerCase();
    const users = mustSheet_("Users").getDataRange().getValues();
    let userId = "";
    let userNama = "";
    let adminId = "";
    
    for(let i=1; i<users.length; i++) {
        // Check for Admin (fallback upline)
        if(String(users[i][4]).toLowerCase() === "admin" && !adminId) {
            adminId = String(users[i][0]);
        }
        // Check for Current User
        if(String(users[i][1]).toLowerCase() === email) {
            userId = String(users[i][0]);
            userNama = String(users[i][3]);
        }
    }
    
    // 1b. Find Upline (Sponsor) from Orders History
    let uplineId = "";
    const orders = mustSheet_("Orders").getDataRange().getValues();
    
    if(userId) {
        // Search from oldest order (top) to find the first referrer
        for(let k=1; k<orders.length; k++) {
             if(String(orders[k][1]).toLowerCase() === email) {
                 const aff = String(orders[k][9] || "").trim();
                 if(aff && aff !== "-" && aff !== "" && aff !== "GUEST") {
                     uplineId = aff;
                     break; // Found the first sponsor
                 }
             }
        }
    }
    // Default to Admin if no upline found
    if(!uplineId) uplineId = adminId;

    // 1c. Get Upline Name
    let uplineName = "Admin";
    if(uplineId) {
         for(let m=1; m<users.length; m++) {
             if(String(users[m][0]) === uplineId) {
                 uplineName = String(users[m][3]);
                 break;
             }
         }
    }
    
    // 2. Get Products (reuse existing logic + pass cached orders)
    const productsData = getProducts(d, cfg, orders);
    const dashboardProducts = productsData && typeof productsData === "object" ? Object.assign({}, productsData) : {};
    delete dashboardProducts.cache_version;
    
    // 3. Get Global Pages (Affiliate Tools - ADMIN owned)
    const globalPages = getAllPages({ ...d, owner_id: "" });
    
    // 4. Get My Pages (User owned)
    let myPages = { data: [] };
    if(userId) {
        myPages = getAllPages({ ...d, owner_id: userId, only_mine: true });
    }
    
    // 5. Get Affiliate Pixels (User specific)
    let myPixels = [];
    if(userId) {
        const s = ss.getSheetByName("Affiliate_Pixels");
        if (s) {
            const data = s.getDataRange().getValues();
            for (let i = 1; i < data.length; i++) {
                if (String(data[i][0]) === userId) {
                    myPixels.push({
                        product_id: data[i][1],
                        pixel_id: data[i][2],
                        pixel_token: data[i][3],
                        pixel_test_code: data[i][4]
                    });
                }
            }
        }
    }
    
    return {
      status: "success",
      cache_version: dashboardCacheVersion,
      data: {
        user: { id: userId, nama: userNama, upline_id: uplineId, upline_name: uplineName },
        settings: { 
            site_name: getCfgFrom_(cfg, "site_name"),
            site_logo: sanitizeAssetUrl_(getCfgFrom_(cfg, "site_logo")),
            site_favicon: sanitizeAssetUrl_(getCfgFrom_(cfg, "site_favicon")),
            wa_admin: getCfgFrom_(cfg, "wa_admin")
        },
        products: dashboardProducts,
        pages: globalPages.data || [],
        my_pages: myPages.data || [],
        affiliate_pixels: myPixels
      }
    };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   LOGIN + PAGE + ADMIN
========================= */
function loginUser(d) {
  const u = mustSheet_("Users").getDataRange().getValues();
  const e = String(d.email || "").trim().toLowerCase();
  const inputPass = String(d.password || "").trim();

  if (!e || !inputPass) {
    return { status: "error", message: "Email dan password wajib diisi." };
  }

  for (let i = 1; i < u.length; i++) {
    if (String(u[i][1]).trim().toLowerCase() === e) {
      const storedPass = String(u[i][2]).trim();
      if (verifyPassword_(inputPass, storedPass)) {
        return { status: "success", data: { id: u[i][0], nama: u[i][3], email: u[i][1], role: String(u[i][4] || "member") } };
      }
      return { status: "error", message: "Password salah. Silakan cek kembali." };
    }
  }
  return { status: "error", message: "Gagal Login: Email tidak ditemukan." };
}

function loginAndDashboard(d) {
  const loginResult = loginUser(d);
  if (loginResult.status !== "success") return loginResult;

  const email = String((loginResult.data && loginResult.data.email) || d.email || "").trim().toLowerCase();
  const dashboardResult = getDashboardData({ email: email });

  if (dashboardResult.status !== "success") {
    return {
      status: "success",
      data: loginResult.data,
      dashboard: null,
      warning: dashboardResult.message || "Dashboard bootstrap gagal dimuat."
    };
  }

  return {
    status: "success",
    data: loginResult.data,
    dashboard: dashboardResult.data
  };
}

function getPageContent(d) {
  try {
    const r = mustSheet_("Pages").getDataRange().getValues();
    for (let i = 1; i < r.length; i++) {
      if (String(r[i][1]) === String(d.slug)) {
          return withPublicCacheVersion_({ 
              status: "success", 
              title: r[i][2], 
              content: r[i][3],
              pixel_id: r[i][7] || "",
              pixel_token: r[i][8] || "",
              pixel_test_code: r[i][9] || "",
              theme_mode: r[i][10] || "light"
          }, "pages");
      }
    }
    return { status: "error" };
  } catch (e) {
    return { status: "error" };
  }
}

function getAllPages(d) {
  try {
    const r = mustSheet_("Pages").getDataRange().getValues();
    const data = [];
    const filterOwner = String(d.owner_id || "").trim();
    const onlyMine = d.only_mine === true;

    for (let i = 1; i < r.length; i++) {
      if (String(r[i][4]) === "Active") {
        // Kolom 7 (index 6) adalah Owner ID. Jika kosong, anggap milik ADMIN (Global)
        const pageOwner = String(r[i][6] || "ADMIN").trim(); 

        if (onlyMine) {
            // Mode "Halaman Saya": Hanya tampilkan milik user ini
            if (pageOwner === filterOwner) data.push(r[i]);
        } else {
            // Mode Default (Global): Tampilkan halaman ADMIN (untuk affiliate link)
            if (pageOwner === "ADMIN") data.push(r[i]);
        }
      }
    }
    return withPublicCacheVersion_({ status: "success", data: data }, "pages");
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function adminLogin(d) {
  const e = String(d.email || "").trim().toLowerCase();
  const inputPass = String(d.password || "").trim();

  if (!e || !inputPass) {
    return { status: "error", message: "Email dan password wajib diisi." };
  }

  const u = mustSheet_("Users").getDataRange().getValues();

  for (let i = 1; i < u.length; i++) {
    if (String(u[i][1]).trim().toLowerCase() === e) {
      const storedPass = String(u[i][2]).trim();
      const role = String(u[i][4]).trim().toLowerCase();

      if (verifyPassword_(inputPass, storedPass) && role === "admin") {
        const session = createAdminSession_({
          id: String(u[i][0] || ""),
          email: e,
          name: String(u[i][3] || "Admin"),
          role: "admin"
        });
        return {
          status: "success",
          data: {
            id: String(u[i][0] || ""),
            nama: String(u[i][3] || "Admin"),
            email: e,
            role: "admin",
            session_token: session.token,
            expires_at: session.expires_at
          }
        };
      }

      if (verifyPassword_(inputPass, storedPass) && role !== "admin") {
        return { status: "error", message: "Akun ditemukan tapi bukan admin. Role: " + u[i][4] };
      }

      return { status: "error", message: "Password salah. Silakan cek kembali." };
    }
  }

  return { status: "error", message: "Email " + e + " tidak ditemukan di database." };
}

/* =========================
   DIAGNOSTIC: Debug Login Data
========================= */
function debugLogin(d) {
  try {
    const u = mustSheet_("Users").getDataRange().getValues();
    const targetEmail = String(d.email || "").trim().toLowerCase();
    const inputPass = String(d.password || "");
    const results = [];

    for (let i = 1; i < u.length; i++) {
      const rawEmail = u[i][1];
      const rawPass = u[i][2];
      const rawRole = u[i][4];
      const emailStr = String(rawEmail);
      const passStr = String(rawPass);
      const roleStr = String(rawRole);

      if (emailStr.trim().toLowerCase() === targetEmail || !targetEmail) {
        // Get charCodes of password to detect hidden characters
        const passChars = [];
        for (let c = 0; c < passStr.length; c++) {
          passChars.push({ char: passStr[c], code: passStr.charCodeAt(c) });
        }

        const inputChars = [];
        for (let c = 0; c < inputPass.length; c++) {
          inputChars.push({ char: inputPass[c], code: inputPass.charCodeAt(c) });
        }

        results.push({
          row: i + 1,
          email: { raw: emailStr, trimmed: emailStr.trim(), type: typeof rawEmail, length: emailStr.length, trimmed_length: emailStr.trim().length },
          password: { raw_length: passStr.length, trimmed: passStr.trim(), trimmed_length: passStr.trim().length, type: typeof rawPass, charCodes: passChars },
          input_password: { raw: inputPass, trimmed: inputPass.trim(), length: inputPass.length, charCodes: inputChars },
          password_match: { raw: passStr === inputPass, trimmed: passStr.trim() === inputPass.trim() },
          role: { raw: roleStr, trimmed: roleStr.trim(), lowercase: roleStr.trim().toLowerCase(), type: typeof rawRole, is_admin: roleStr.trim().toLowerCase() === "admin" }
        });
      }
    }

    return { status: "success", data: results, total_users: u.length - 1 };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   UNIT TESTS: Authentication
========================= */
function runAuthTests() {
  const results = [];
  const u = mustSheet_("Users").getDataRange().getValues();

  // Test 1: Users sheet has data
  results.push({ test: "Users sheet exists and has data", pass: u.length > 1, detail: "Rows: " + u.length });

  // Test 2: Header structure
  const expectedHeaders = ["user_id", "email", "password", "nama_lengkap", "role"];
  const headers = u[0].map(h => String(h).trim().toLowerCase());
  const headerMatch = expectedHeaders.every(h => headers.includes(h));
  results.push({ test: "Headers match expected structure", pass: headerMatch, detail: "Found: " + headers.slice(0, 5).join(", ") });

  // Test 3: Find admin user
  let adminRow = null;
  for (let i = 1; i < u.length; i++) {
    if (String(u[i][4]).trim().toLowerCase() === "admin") {
      adminRow = { index: i, email: String(u[i][1]), pass: String(u[i][2]), name: String(u[i][3]), role: String(u[i][4]) };
      break;
    }
  }
  results.push({ test: "Admin user exists in Users sheet", pass: !!adminRow, detail: adminRow ? "Email: " + adminRow.email : "No admin found" });

  if (adminRow) {
    // Test 4: Admin password has no hidden characters
    const passStr = adminRow.pass;
    const hasHidden = passStr.length !== passStr.trim().length;
    results.push({ test: "Admin password has no trailing/leading spaces", pass: !hasHidden, 
      detail: "Raw length: " + passStr.length + ", Trimmed: " + passStr.trim().length });

    // Test 5: Admin email has no hidden characters
    const emailStr = adminRow.email;
    const emailHasHidden = emailStr.length !== emailStr.trim().length;
    results.push({ test: "Admin email has no trailing/leading spaces", pass: !emailHasHidden,
      detail: "Raw length: " + emailStr.length + ", Trimmed: " + emailStr.trim().length });

    // Test 6: loginUser works for admin (should succeed — tests email+pass)
    const loginResult = loginUser({ email: adminRow.email.trim(), password: adminRow.pass.trim() });
    results.push({ test: "loginUser() succeeds for admin credentials", pass: loginResult.status === "success",
      detail: JSON.stringify(loginResult) });

    // Test 7: adminLogin works for admin (should succeed — tests email+pass+role)
    const adminResult = adminLogin({ email: adminRow.email.trim(), password: adminRow.pass.trim() });
    results.push({ test: "adminLogin() succeeds for admin credentials", pass: adminResult.status === "success",
      detail: JSON.stringify(adminResult) });

    const adminSessionToken = adminResult && adminResult.data ? String(adminResult.data.session_token || "") : "";
    const adminSession = adminSessionToken ? getAdminSession_(adminSessionToken) : null;
    results.push({
      test: "Admin session disimpan persisten tanpa expiry otomatis",
      pass: !!adminSessionToken && !!adminSession && Number(adminResult && adminResult.data ? adminResult.data.expires_at : 0) === 0,
      detail: JSON.stringify({
        token_exists: !!adminSessionToken,
        session_exists: !!adminSession,
        expires_at: adminResult && adminResult.data ? Number(adminResult.data.expires_at || 0) : null
      })
    });

    if (adminSessionToken) {
      const logoutResult = adminLogout({ auth_session_token: adminSessionToken });
      const revokedSession = getAdminSession_(adminSessionToken);
      results.push({
        test: "adminLogout() mencabut session admin secara manual",
        pass: logoutResult.status === "success" && !revokedSession,
        detail: JSON.stringify({
          logout: logoutResult,
          session_exists_after_logout: !!revokedSession
        })
      });
    }
  }

  // Test 8: Find member user
  let memberRow = null;
  for (let i = 1; i < u.length; i++) {
    if (String(u[i][4]).trim().toLowerCase() === "member") {
      memberRow = { index: i, email: String(u[i][1]), pass: String(u[i][2]), name: String(u[i][3]), role: String(u[i][4]) };
      break;
    }
  }

  if (memberRow) {
    // Test 9: loginUser works for member
    const memberResult = loginUser({ email: memberRow.email.trim(), password: memberRow.pass.trim() });
    results.push({ test: "loginUser() succeeds for member credentials", pass: memberResult.status === "success",
      detail: JSON.stringify(memberResult) });

    // Test 10: adminLogin rejects member (should fail — not admin role)
    const memberAdminResult = adminLogin({ email: memberRow.email.trim(), password: memberRow.pass.trim() });
    results.push({ test: "adminLogin() correctly rejects member user", pass: memberAdminResult.status === "error",
      detail: JSON.stringify(memberAdminResult) });
  }

  // Test 11: Empty credentials rejected
  const emptyResult = adminLogin({ email: "", password: "" });
  results.push({ test: "adminLogin() rejects empty credentials", pass: emptyResult.status === "error",
    detail: emptyResult.message });

  // Test 12: Wrong password rejected
  if (adminRow) {
    const wrongPassResult = adminLogin({ email: adminRow.email, password: "wrongpass123" });
    results.push({ test: "adminLogin() rejects wrong password", pass: wrongPassResult.status === "error",
      detail: wrongPassResult.message });
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  return { status: "success", summary: passed + " passed, " + failed + " failed, " + results.length + " total", tests: results };
}

function runMootaValidationTests() {
  const cases = [
    {
      test: "Menerima URL HTTPS dan Secret Token alphanumeric valid",
      input: { gasUrl: "https://example.com/webhook/moota", token: "Secret123" },
      expectedErrors: []
    },
    {
      test: "Menolak link webhook kosong",
      input: { gasUrl: "", token: "Secret123" },
      expectedErrors: ["Link webhook Moota wajib diisi."]
    },
    {
      test: "Menolak link webhook non-HTTPS",
      input: { gasUrl: "http://example.com/webhook/moota", token: "Secret123" },
      expectedErrors: ["Format link webhook Moota tidak valid. Gunakan URL HTTPS tanpa query string."]
    },
    {
      test: "Menolak link webhook Google Apps Script langsung",
      input: { gasUrl: "https://script.google.com/macros/s/abc/exec", token: "Secret123" },
      expectedErrors: ["Link webhook Moota tidak boleh langsung ke Google Apps Script. Gunakan endpoint Cloudflare Worker atau proxy publik agar header Signature bisa diteruskan."]
    },
    {
      test: "Menolak Secret Token kosong",
      input: { gasUrl: "https://example.com/webhook/moota", token: "" },
      expectedErrors: ["Secret Token Moota wajib diisi."]
    },
    {
      test: "Menolak Secret Token kurang dari 8 karakter",
      input: { gasUrl: "https://example.com/webhook/moota", token: "Abc1234" },
      expectedErrors: ["Format Secret Token Moota tidak valid. Gunakan minimal 8 karakter alphanumeric tanpa spasi."]
    },
    {
      test: "Menolak Secret Token dengan karakter non-alphanumeric",
      input: { gasUrl: "https://example.com/webhook/moota", token: "Secret-123" },
      expectedErrors: ["Format Secret Token Moota tidak valid. Gunakan minimal 8 karakter alphanumeric tanpa spasi."]
    }
  ];

  const results = cases.map(function(item) {
    const errors = validateMootaConfigFormat_(item.input);
    const pass = JSON.stringify(errors) === JSON.stringify(item.expectedErrors);
    return {
      test: item.test,
      pass: pass,
      input: item.input,
      expected: item.expectedErrors,
      actual: errors
    };
  });

  const passed = results.filter(function(result) { return result.pass; }).length;
  const failed = results.length - passed;

  return {
    status: "success",
    summary: passed + " passed, " + failed + " failed, " + results.length + " total",
    tests: results
  };
}

function runMootaSignatureTests() {
  const payload = JSON.stringify([{
    amount: 50000,
    type: "CR",
    description: "Testing webhook moota",
    created_at: "2019-11-10 14:33:01"
  }]);
  const secret = "Secret123";
  const expectedSignature = computeMootaSignatureHex_(payload, secret);
  const prefixedSignature = "sha256=" + expectedSignature.toUpperCase();
  const cases = [
    {
      test: "Normalisasi signature menerima prefix sha256 dan huruf besar",
      actual: normalizeMootaSignature_(prefixedSignature),
      expected: expectedSignature
    },
    {
      test: "Verifikasi signature valid",
      actual: verifyMootaSignature_(payload, secret, expectedSignature).code,
      expected: "ok"
    },
    {
      test: "Verifikasi signature valid dengan prefix sha256",
      actual: verifyMootaSignature_(payload, secret, prefixedSignature).code,
      expected: "ok"
    },
    {
      test: "Verifikasi signature gagal saat signature kosong",
      actual: verifyMootaSignature_(payload, secret, "").code,
      expected: "missing_signature"
    },
    {
      test: "Verifikasi signature gagal saat secret kosong",
      actual: verifyMootaSignature_(payload, "", expectedSignature).code,
      expected: "missing_secret"
    },
    {
      test: "Verifikasi signature gagal saat signature tidak cocok",
      actual: verifyMootaSignature_(payload, secret, "deadbeef").code,
      expected: "invalid_signature"
    },
    {
      test: "Meta membaca flag verifikasi Worker",
      actual: extractMootaSignatureMeta_({
        parameter: {
          moota_signature: expectedSignature,
          moota_sig_verified: "1",
          moota_sig_verified_by: "worker"
        }
      }).workerVerifiedSignature,
      expected: true
    },
    {
      test: "Meta membaca sumber verifikasi Worker",
      actual: extractMootaSignatureMeta_({
        parameter: {
          moota_signature: expectedSignature,
          moota_sig_verified: "1",
          moota_sig_verified_by: "worker"
        }
      }).workerVerificationSource,
      expected: "worker"
    },
    {
      test: "Helper mendeteksi URL Google Apps Script langsung",
      actual: isDirectAppsScriptUrl_("https://script.google.com/macros/s/abc/exec"),
      expected: true
    },
    {
      test: "Klasifikasi missing signature untuk URL Google Apps Script langsung",
      actual: classifyMootaSignatureMissing_(
        { gasUrl: "https://script.google.com/macros/s/abc/exec" },
        { forwardedByWorker: false, workerSawSignature: false }
      ).code,
      expected: "direct_apps_script_url"
    },
    {
      test: "Klasifikasi missing signature saat Worker tidak terdeteksi",
      actual: classifyMootaSignatureMissing_(
        { gasUrl: "https://example.com/webhook/moota" },
        { forwardedByWorker: false, workerSawSignature: false }
      ).code,
      expected: "worker_not_detected"
    },
    {
      test: "Klasifikasi missing signature saat Worker hidup tapi header tidak ada",
      actual: classifyMootaSignatureMissing_(
        { gasUrl: "https://example.com/webhook/moota" },
        { forwardedByWorker: true, workerSawSignature: false }
      ).code,
      expected: "worker_missing_signature_header"
    }
  ];

  const results = cases.map(function(item) {
    const pass = JSON.stringify(item.actual) === JSON.stringify(item.expected);
    return {
      test: item.test,
      pass: pass,
      expected: item.expected,
      actual: item.actual
    };
  });

  const passed = results.filter(function(result) { return result.pass; }).length;
  const failed = results.length - passed;

  return {
    status: "success",
    summary: passed + " passed, " + failed + " failed, " + results.length + " total",
    tests: results,
    sample_signature: maskMootaSignatureForLog_(expectedSignature)
  };
}

function getAdminData(d, cfg) {
  try {
    const session = requireAdminSession_(d, { actionName: "get_admin_data" });
    cfg = cfg || getSettingsMap_();
    const o = mustSheet_("Orders").getDataRange().getValues();
    const u = mustSheet_("Users").getDataRange().getValues();
    const s = mustSheet_("Settings").getDataRange().getValues();
    const p = mustSheet_("Access_Rules").getDataRange().getValues();
    const pg = mustSheet_("Pages").getDataRange().getValues();

    let rev = 0;
    for (let i = 1; i < o.length; i++) {
      if (String(o[i][7]) === "Lunas") rev += Number(o[i][6] || 0);
    }

    let t = {};
    for (let i = 1; i < s.length; i++) {
      if (s[i][0]) t[s[i][0]] = s[i][1];
    }
    const resolvedMootaCfg = resolveMootaConfig_({}, cfg);
    t.moota_gas_url = normalizeMootaUrl_(resolvedMootaCfg.gasUrl || t.moota_gas_url || getCurrentWebAppUrl_());
    t.moota_token = "";
    t.moota_token_configured = !!resolvedMootaCfg.token;
    t.ik_private_key = "";
    t.ik_private_key_configured = !!getSecret_("ik_private_key", cfg);

    const result = {
      status: "success",
      role: session.role,
      session_expires_at: session.expires_at,
      stats: { users: u.length - 1, orders: o.length - 1, rev: rev },
      orders: o.slice(1).reverse().slice(0, 20),
      products: p.slice(1).map(normalizeProductRow_),
      pages: pg.slice(1),
      settings: t,
      users: u.slice(1).reverse().slice(0, 20),
      has_more_orders: (o.length - 1) > 20,
      has_more_users: (u.length - 1) > 20
    };
    return result;
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   SAVE PRODUCT / PAGE / SETTINGS
========================= */
function saveProduct(d) {
  try {
    requireAdminSession_(d, { actionName: "save_product" });
    const s = mustSheet_("Access_Rules");
    const descValidation = validateProductDescription_(d.desc);
    if (descValidation.errors.length) {
      return { status: "error", message: descValidation.errors[0], errors: descValidation.errors };
    }
    const productId = normalizePlainText_(d.id);
    const productTitle = normalizePlainText_(d.title);
    const productDesc = descValidation.value;
    const productUrl = String(d.url || "").trim();
    const productStatus = normalizePlainText_(d.status || "Active") || "Active";
    const landingPageUrl = String(d.lp_url || "").trim();
    const imageUrl = String(d.image_url || "").trim();
    const pixelId = normalizePlainText_(d.pixel_id);
    const pixelToken = String(d.pixel_token || "").trim();
    const pixelTestCode = normalizePlainText_(d.pixel_test_code);
    const commission = String(d.commission || "").trim();
    
    // Ensure we have enough columns (12 columns needed)
    if (s.getMaxColumns() < 12) s.insertColumnsAfter(s.getMaxColumns(), 12 - s.getMaxColumns());
    
    const dataRow = [productId, productTitle, productDesc, productUrl, d.harga, productStatus, landingPageUrl, imageUrl, pixelId, pixelToken, pixelTestCode, commission];
    const isEdit = String(d.is_edit) === "true";

    if (isEdit) {
      const r = s.getDataRange().getValues();
      for (let i = 1; i < r.length; i++) {
        if (String(r[i][0]).trim() === productId) {
          s.getRange(i + 1, 1, 1, 12).setValues([dataRow]);
          invalidateCaches_(["access_rules"]);
          return withPublicCacheState_({ status: "success" }, bumpPublicCacheState_(["catalog", "dashboard"]));
        }
      }
      return { status: "error", message: "ID Produk tidak ditemukan untuk diedit" };
    } else {
      // Check for duplicate ID before appending
      const r = s.getDataRange().getValues();
      for (let i = 1; i < r.length; i++) {
        if (String(r[i][0]).trim() === productId) {
           return { status: "error", message: "ID Produk sudah digunakan. Mohon refresh halaman." };
        }
      }
      s.appendRow(dataRow);
      invalidateCaches_(["access_rules"]);
      return withPublicCacheState_({ status: "success" }, bumpPublicCacheState_(["catalog", "dashboard"]));
    }
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function deleteProduct(d) {
  try {
    requireAdminSession_(d, { actionName: "delete_product" });
    const s = mustSheet_("Access_Rules");
    const r = s.getDataRange().getValues();
    const id = String(d.id).trim();

    for (let i = 1; i < r.length; i++) {
      if (String(r[i][0]).trim() === id) {
        s.deleteRow(i + 1);
        invalidateCaches_(["access_rules"]);
        return withPublicCacheState_({ status: "success", message: "Produk berhasil dihapus" }, bumpPublicCacheState_(["catalog", "dashboard"]));
      }
    }
    return { status: "error", message: "ID Produk tidak ditemukan" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function savePage(d) {
  try {
    requireAdminSession_(d, { actionName: "save_page" });
    const s = mustSheet_("Pages");
    const isEdit = String(d.is_edit) === "true";
    const ownerId = String(d.owner_id || "ADMIN").trim(); // Default ke ADMIN
    const slug = String(d.slug).trim();
    const id = String(d.id).trim();

    const r = s.getDataRange().getValues();

    // 1. Cek Unik Slug (Global Check)
    for (let i = 1; i < r.length; i++) {
        const rowSlug = String(r[i][1]).trim();
        const rowId = String(r[i][0]).trim();
        
        if (rowSlug === slug) {
            // Jika slug sama, pastikan ini adalah halaman yang sama (sedang diedit)
            // Jika ID beda, berarti slug sudah dipakai orang lain
            if (isEdit && rowId === id) {
                // Ini halaman kita sendiri, lanjut
            } else {
                return { status: "error", message: "Slug URL sudah digunakan. Pilih slug lain." };
            }
        }
    }

    // Check if columns exist
    const maxCols = s.getMaxColumns();
    if (maxCols < 11) s.insertColumnsAfter(maxCols, 11 - maxCols);

    if (isEdit) {
      for (let i = 1; i < r.length; i++) {
        if (String(r[i][0]).trim() === id) {
          // Hanya izinkan edit jika owner cocok (atau admin bisa edit semua)
          const existingOwner = String(r[i][6] || "ADMIN").trim();
          
           if (existingOwner !== ownerId && ownerId !== "ADMIN") { 
              return { status: "error", message: "Anda tidak memiliki izin mengedit halaman ini." };
          }

          s.getRange(i + 1, 1, 1, 4).setValues([[d.id, slug, d.title, d.content]]);
          // Update Meta Pixel Columns (Col 8, 9, 10) + Theme Mode (Col 11)
          s.getRange(i + 1, 8, 1, 4).setValues([[d.meta_pixel_id || "", d.meta_pixel_token || "", d.meta_pixel_test_event || "", d.theme_mode || "light"]]);
          return withPublicCacheState_({ status: "success" }, bumpPublicCacheState_(["pages", "dashboard"]));
        }
      }
      return { status: "error", message: "ID Halaman tidak ditemukan" };
    } else {
      const newId = "PG-" + Date.now();
      // Tambahkan Owner ID di kolom ke-7 (index 6) + Meta Pixel (7,8,9) + Theme Mode (10)
      s.appendRow([newId, slug, d.title, d.content, "Active", toISODate_(), ownerId, d.meta_pixel_id || "", d.meta_pixel_token || "", d.meta_pixel_test_event || "", d.theme_mode || "light"]);
      return withPublicCacheState_({ status: "success" }, bumpPublicCacheState_(["pages", "dashboard"]));
    }
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function deletePage(d) {
  try {
    requireAdminSession_(d, { actionName: "delete_page" });
    const s = mustSheet_("Pages");
    const id = String(d.id).trim();
    const ownerId = String(d.owner_id || "ADMIN").trim();

    const r = s.getDataRange().getValues();
    for (let i = 1; i < r.length; i++) {
      if (String(r[i][0]).trim() === id) {
        // Security Check: Only Owner or Admin can delete
        const pageOwner = String(r[i][6] || "ADMIN").trim();
        if (pageOwner !== ownerId && ownerId !== "ADMIN") {
            return { status: "error", message: "Anda tidak memiliki izin menghapus halaman ini." };
        }
        
        s.deleteRow(i + 1);
        return withPublicCacheState_({ status: "success", message: "Halaman berhasil dihapus" }, bumpPublicCacheState_(["pages", "dashboard"]));
      }
    }
    return { status: "error", message: "ID Halaman tidak ditemukan" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function checkSlug(d) {
  try {
    const s = mustSheet_("Pages");
    const slug = String(d.slug).trim();
    const excludeId = String(d.exclude_id || "").trim(); // For edit mode
    
    const r = s.getDataRange().getValues();
    for (let i = 1; i < r.length; i++) {
      const rowSlug = String(r[i][1]).trim();
      const rowId = String(r[i][0]).trim();
      
      if (rowSlug === slug) {
          if (excludeId && rowId === excludeId) {
              // Same page, it's fine
          } else {
              return { status: "success", available: false, message: "Slug URL sudah digunakan" };
          }
      }
    }
    return { status: "success", available: true, message: "Slug URL tersedia" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function updateSettings(d) {
  requireAdminSession_(d, { actionName: "update_settings" });
  const cfg = getSettingsMap_();
  const payload = Object.assign({}, (d && d.payload && typeof d.payload === "object") ? d.payload : {});
  if (Object.prototype.hasOwnProperty.call(payload, "moota_secret") && !Object.prototype.hasOwnProperty.call(payload, "moota_token")) {
    payload.moota_token = payload.moota_secret;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "moota_secret")) {
    delete payload.moota_secret;
  }
  const hasMootaPayload = Object.prototype.hasOwnProperty.call(payload, "moota_gas_url")
    || Object.prototype.hasOwnProperty.call(payload, "moota_token");
  if (hasMootaPayload) {
    const mootaCfg = resolveMootaConfig_(payload, cfg);
    const shouldValidateMoota = !!(mootaCfg.gasUrl || mootaCfg.token);
    if (shouldValidateMoota) {
      const mootaErrors = validateMootaConfigFormat_(mootaCfg);
      if (mootaErrors.length) {
        return { status: "error", message: mootaErrors[0], errors: mootaErrors };
      }
    }
  }

  const s = mustSheet_("Settings");
  const r = s.getDataRange().getValues();
  const propertyOnlyKeys = {
    ik_private_key: true,
    moota_token: true
  };
  for (let k in payload) {
    let nextValue = payload[k];
    if (k === "site_logo" || k === "site_favicon") {
      nextValue = sanitizeAssetUrl_(nextValue);
    }
    if (k === "moota_gas_url") {
      nextValue = normalizeMootaUrl_(nextValue);
    }
    const storeInPropertiesOnly = !!propertyOnlyKeys[k];
    if (storeInPropertiesOnly) {
      const props = PropertiesService.getScriptProperties();
      nextValue = String(nextValue || "").trim();
      if (nextValue) {
        props.setProperty(k, nextValue);
        if (k === "moota_token") props.deleteProperty("moota_secret");
      } else {
        props.deleteProperty(k);
      }
    }
    let f = false;
    for (let i = 1; i < r.length; i++) {
      if (r[i][0] === k) {
        s.getRange(i + 1, 2).setValue(storeInPropertiesOnly ? "" : nextValue);
        f = true;
        break;
      }
    }
    if (!f && !storeInPropertiesOnly) s.appendRow([k, nextValue]);
  }
  invalidateCaches_(["settings_map"]);
  return withPublicCacheState_({ status: "success" }, bumpPublicCacheState_(["settings", "dashboard"]));
}

function updateMootaGatewaySettings(d) {
  requireAdminSession_(d, { actionName: "update_moota_gateway" });
  const payload = (d && d.payload && typeof d.payload === "object") ? d.payload : d || {};
  return updateSettings({
    auth_session_token: getAdminSessionToken_(d),
    payload: {
      moota_gas_url: payload.moota_gas_url,
      moota_token: payload.moota_token !== undefined ? payload.moota_token : payload.moota_secret
    }
  });
}

function updateImageKitMediaSettings(d) {
  requireAdminSession_(d, { actionName: "update_imagekit_media" });
  const payload = (d && d.payload && typeof d.payload === "object") ? d.payload : d || {};
  return updateSettings({
    auth_session_token: getAdminSessionToken_(d),
    payload: {
      ik_public_key: payload.ik_public_key,
      ik_endpoint: payload.ik_endpoint,
      ik_private_key: payload.ik_private_key
    }
  });
}

function importMootaConfig(d) {
  requireAdminSession_(d, { actionName: "import_moota_config" });
  const payload = (d && d.payload && typeof d.payload === "object") ? d.payload : d || {};
  return updateSettings({
    auth_session_token: getAdminSessionToken_(d),
    payload: {
      moota_gas_url: payload.moota_gas_url,
      moota_token: payload.moota_token !== undefined ? payload.moota_token : payload.moota_secret
    }
  });
}

/* =========================
   IMAGEKIT AUTH
========================= */
function testImageKitConfig(d, cfg) {
  requireAdminSession_(d, { actionName: "test_ik_config" });
  cfg = cfg || getSettingsMap_();
  const ikCfg = resolveImageKitConfig_(d, cfg);
  const errors = validateImageKitConfigFormat_(ikCfg, { requireEndpoint: false });
  if (errors.length) {
    return { status: "error", message: errors[0], errors: errors };
  }

  const result = fetchImageKitFiles_(ikCfg.privateKey, 1);
  if (!result.ok) return { status: "error", message: result.message };

  const sampleFile = result.files.length ? result.files[0] : null;
  const sampleUrl = sampleFile ? String(sampleFile.url || "") : "";
  const inferredEndpoint = inferImageKitEndpointFromUrl_(sampleUrl);
  const warnings = [];

  if (!ikCfg.endpoint && inferredEndpoint) {
    warnings.push("URL endpoint berhasil dideteksi otomatis dari file yang ada di akun.");
  } else if (ikCfg.endpoint && inferredEndpoint && sampleUrl && sampleUrl.indexOf(ikCfg.endpoint) !== 0) {
    warnings.push("URL endpoint yang diisi tidak cocok dengan contoh URL file di akun. Periksa kembali URL endpoint ImageKit Anda.");
  }

  return {
    status: "success",
    message: "Koneksi ImageKit berhasil.",
    endpoint: ikCfg.endpoint || inferredEndpoint,
    inferred_endpoint: inferredEndpoint,
    sample_file_url: sampleUrl,
    warnings: warnings
  };
}

function getImageKitAuth(d, cfg) {
  requireAdminSession_(d, { actionName: "get_ik_auth" });
  cfg = cfg || getSettingsMap_();
  const ikCfg = resolveImageKitConfig_(d, cfg);
  const errors = validateImageKitConfigFormat_(ikCfg, { requirePublic: false, requireEndpoint: false, requirePrivate: true });
  if (errors.length) return { status: "error", message: errors[0] };

  const t = Utilities.getUuid();
  const exp = Math.floor(Date.now() / 1000) + 2400;
  const toSign = t + exp;

  const sig = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, toSign, ikCfg.privateKey)
    .map(b => ("0" + (b & 255).toString(16)).slice(-2))
    .join("");

  return { status: "success", token: t, expire: exp, signature: sig };
}

/* =========================
   CHANGE PASSWORD
========================= */
function changeUserPassword(d) {
  try {
    const s = mustSheet_("Users");
    const r = s.getDataRange().getValues();
    const email = String(d.email).trim().toLowerCase();
    const oldPass = String(d.old_password);
    const newPass = String(d.new_password);

    for (let i = 1; i < r.length; i++) {
      if (String(r[i][1]).trim().toLowerCase() === email) {
        if (verifyPassword_(oldPass, String(r[i][2] || ""))) {
          s.getRange(i + 1, 3).setValue(hashPassword_(newPass));
          return { status: "success", message: "Password berhasil diubah" };
        } else {
          return { status: "error", message: "Password lama salah!" };
        }
      }
    }
    return { status: "error", message: "Email pengguna tidak ditemukan." };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   UPDATE PROFILE (NAMA & EMAIL)
========================= */
function updateUserProfile(d) {
  try {
    const s = mustSheet_("Users");
    const r = s.getDataRange().getValues();
    const currentEmail = String(d.email).trim().toLowerCase();
    const newName = String(d.new_name).trim();
    const newEmail = String(d.new_email).trim().toLowerCase();
    const password = String(d.password); // Verify password before updating sensitive info

    if (!newName || !newEmail) return { status: "error", message: "Nama dan Email baru wajib diisi." };

    let userRowIndex = -1;
    let currentData = null;

    // 1. Verify User & Check duplicate email if changed
    for (let i = 1; i < r.length; i++) {
      const rowEmail = String(r[i][1]).trim().toLowerCase();
      
      // Find current user
      if (rowEmail === currentEmail) {
        if (!verifyPassword_(password, String(r[i][2] || ""))) return { status: "error", message: "Password salah!" };
        userRowIndex = i + 1;
        currentData = r[i];
      } 
      
      // Check if new email is already taken by SOMEONE ELSE
      if (rowEmail === newEmail && rowEmail !== currentEmail) {
        return { status: "error", message: "Email baru sudah digunakan oleh pengguna lain." };
      }
    }

    if (userRowIndex === -1) return { status: "error", message: "Pengguna tidak ditemukan." };

    // 2. Update Users Sheet
    // Col 2: Email (index 1), Col 4: Nama (index 3)
    // Note: getRange(row, col) is 1-based.
    s.getRange(userRowIndex, 2).setValue(newEmail);
    s.getRange(userRowIndex, 4).setValue(newName);

    // 3. Update Orders Sheet if email changed (Consistency)
    if (newEmail !== currentEmail) {
      const oS = mustSheet_("Orders");
      const oR = oS.getDataRange().getValues();
      for (let j = 1; j < oR.length; j++) {
        if (String(oR[j][1]).toLowerCase() === currentEmail) {
          oS.getRange(j + 1, 2).setValue(newEmail);
          oS.getRange(j + 1, 3).setValue(newName); // Update name as well
        }
      }
    } else {
       // Just update name in Orders if email same
      const oS = mustSheet_("Orders");
      const oR = oS.getDataRange().getValues();
      for (let j = 1; j < oR.length; j++) {
        if (String(oR[j][1]).toLowerCase() === currentEmail) {
          oS.getRange(j + 1, 3).setValue(newName);
        }
      }
    }

    return { status: "success", message: "Profil berhasil diperbarui", new_email: newEmail, new_name: newName };

  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   AFFILIATE PIXEL SETTINGS
========================= */
function saveAffiliatePixel(d) {
  try {
    const sName = "Affiliate_Pixels";
    let s = ss.getSheetByName(sName);
    if (!s) {
      s = ss.insertSheet(sName);
      s.appendRow(["user_id", "product_id", "pixel_id", "pixel_token", "pixel_test_code"]);
    }
    
    // 1. Get User ID from Email (Secure way: use login token if available, but here we trust email for now as it's backend call from trusted client logic)
    // Ideally we should use session token, but current system uses email.
    const email = String(d.email || "").trim().toLowerCase();
    if (!email) return { status: "error", message: "Email wajib diisi" };

    const uS = mustSheet_("Users");
    const uR = uS.getDataRange().getValues();
    let userId = "";
    
    for (let i = 1; i < uR.length; i++) {
      if (String(uR[i][1]).toLowerCase() === email) { 
        userId = String(uR[i][0]); 
        break; 
      }
    }
    
    if (!userId) return { status: "error", message: "User tidak ditemukan" };
    
    const productId = String(d.product_id).trim();
    const pixelId = String(d.pixel_id || "").trim();
    const pixelToken = String(d.pixel_token || "").trim();
    const pixelTest = String(d.pixel_test_code || "").trim();

    const r = s.getDataRange().getValues();
    let found = false;

    for (let i = 1; i < r.length; i++) {
      if (String(r[i][0]) === userId && String(r[i][1]) === productId) {
        // Update existing row (Col 3, 4, 5 -> index 2, 3, 4)
        s.getRange(i + 1, 3, 1, 3).setValues([[pixelId, pixelToken, pixelTest]]);
        found = true;
        break;
      }
    }

    if (!found) {
      s.appendRow([userId, productId, pixelId, pixelToken, pixelTest]);
    }
    
    return { status: "success", message: "Pixel berhasil disimpan" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   PERMISSION WARMUP
========================= */
function pancinganIzin() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) ss.getName();
  MailApp.getRemainingDailyQuota();
  try {
    UrlFetchApp.fetch("https://google.com");
  } catch (e) {
    // Ignore fetch errors
  }
  Logger.log("Pancingan sukses! Izin berhasil di-refresh.");
}

/* =========================
   AUTO-PAYMENT SYSTEM (MOOTA WEBHOOK)
========================= */
function handleMootaWebhook(mutations, cfg) {
  try {
    cfg = cfg || getSettingsMap_();

    // LOG: Raw incoming webhook for debugging
    logMoota_("WEBHOOK_IN", "Mutations count: " + mutations.length + " | Data masked");

    const s = mustSheet_("Orders");
    const orders = s.getDataRange().getValues();
    const siteName = getCfgFrom_(cfg, "site_name") || "Sistem Premium";
    const adminWA = getCfgFrom_(cfg, "wa_admin");

    const MAX_AGE_HOURS = 72; // Extended from 48 to 72 hours for better matching
    const matched = [];
    const debugLog = [];

    debugLog.push("MUTATIONS: " + mutations.length);

    for (let m = 0; m < mutations.length; m++) {
      const mutasi = mutations[m];
      const type = String(mutasi.type || "").toUpperCase();

      // Filter Credit only (Uang Masuk)
      if (type !== "CR" && type !== "CREDIT") {
        debugLog.push(`SKIP [${m}] Type=${type} (Not CR)`);
        logMoota_("SKIP_TYPE", "Mutation " + m + " type=" + type + " (not CR/CREDIT)");
        continue;
      }

      // Robust Amount Parsing (Handle number or string)
      let nominalTransfer = 0;
      if (typeof mutasi.amount === 'number') {
        nominalTransfer = mutasi.amount;
      } else {
        nominalTransfer = parseFloat(String(mutasi.amount || 0).replace(/[^0-9.-]/g, "")) || 0;
      }
      // Round to integer to avoid floating point issues
      nominalTransfer = Math.round(nominalTransfer);

      if (nominalTransfer <= 0) {
        debugLog.push(`SKIP [${m}] Amount=0`);
        logMoota_("SKIP_ZERO", "Mutation " + m + " amount=0 or negative");
        continue;
      }

        debugLog.push(`CHECKING Amount=${nominalTransfer}`);

      let foundMatch = false;
      // Collect pending orders info for debugging if no match
      let pendingOrders = [];

      // Iterate Orders to find match
      for (let i = 1; i < orders.length; i++) {
        const statusOrder = String(orders[i][7] || "").trim();
        
        // Hanya proses yang statusnya Pending
        if (statusOrder !== "Pending") continue;

        // Cek umur order
        if (MAX_AGE_HOURS > 0) {
          const dtStr = String(orders[i][8] || "").trim();
          const dt = new Date(dtStr);
          if (!isNaN(dt.getTime())) {
            const ageHours = (Date.now() - dt.getTime()) / 36e5;
            if (ageHours > MAX_AGE_HOURS) continue;
          }
        }

        const tagihanOrder = Math.round(toNumberSafe_(orders[i][6])); // Round to integer
        pendingOrders.push({ inv: orders[i][0], tagihan: tagihanOrder });
        
        // MATCHING LOGIC: Exact Amount (Rounded integers)
        if (tagihanOrder === nominalTransfer) {
          debugLog.push(`  MATCH FOUND Row ${i+1}: Inv=${orders[i][0]}`);
          logMoota_("MATCH", "Inv=" + orders[i][0] + " Amount=" + nominalTransfer + " Row=" + (i+1));
          
          // 1. UPDATE SHEET STATUS
          s.getRange(i + 1, 8).setValue("Lunas");
          orders[i][7] = "Lunas"; // Prevent double matching

          const inv = orders[i][0];
          const uEmail = orders[i][1];
          const uName = orders[i][2];
          const uWA = orders[i][3];
          const pId = orders[i][4];
          const pName = orders[i][5];

          // 2. GET ACCESS URL
          let accessUrl = "";
          const pS = ss.getSheetByName("Access_Rules");
          if (pS) {
            const pData = pS.getDataRange().getValues();
            for (let k = 1; k < pData.length; k++) {
              if (String(pData[k][0]) === String(pId)) { accessUrl = pData[k][3]; break; }
            }
          }

          // 3. SEND NOTIFICATIONS
          
          // LOG: Debug WA target before sending (diagnose Lunas WA failures)
          logWA_("DEBUG_MOOTA_LUNAS", String(uWA), "raw=" + JSON.stringify(uWA) + " type=" + typeof uWA + " normalized=" + normalizePhone_(uWA) + " | Inv=" + inv);

          // A) WA Customer
          sendWA(
            uWA,
            `🎉 *PEMBAYARAN DITERIMA!* 🎉\n\nHalo *${uName}*, pembayaran Anda sebesar Rp ${Number(nominalTransfer).toLocaleString('id-ID')} telah berhasil diverifikasi otomatis.\n\nPesanan *${pName}* (Invoice: #${inv}) kini *AKTIF*.\n\n🚀 *AKSES MATERI:* \n${accessUrl}\n\nTerima kasih!\n*Tim ${siteName}*`,
            cfg
          );

          // B) Email Customer
          const emailHtml = `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                <h2 style="color: #10b981;">Pembayaran Berhasil! ✅</h2>
                <p>Halo <b>${uName}</b>,</p>
                <p>Pembayaran invoice <b>#${inv}</b> sebesar <b>Rp ${Number(nominalTransfer).toLocaleString('id-ID')}</b> telah diterima.</p>
                <p>Silakan akses produk <b>${pName}</b> melalui tombol di bawah ini:</p>
                <div style="text-align: center; margin: 30px 0;">
                    <a href="${accessUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Akses Materi</a>
                </div>
                <p>Terima kasih,<br><b>Tim ${siteName}</b></p>
            </div>`;
          sendEmail(uEmail, `Pembayaran Sukses: #${inv} - ${siteName}`, emailHtml, cfg);

          // C) WA Admin
          sendWA(
            adminWA,
            `💰 *MOOTA PAYMENT RECEIVED* 💰\n\nInv: #${inv}\nAmt: Rp ${Number(nominalTransfer).toLocaleString('id-ID')}\nUser: ${uName}\nProduk: ${pName}\n\nStatus: Auto-Lunas by System.`,
            cfg
          );

          foundMatch = true;
          matched.push(inv);
          break; // Stop searching orders for this mutation
        }
      }

      if (!foundMatch) {
        const pendingInfo = pendingOrders.map(o => o.inv + "=" + o.tagihan).join(", ");
        debugLog.push(`NO MATCH for Amount=${nominalTransfer} | Pending orders: ${pendingInfo}`);
        logMoota_("NO_MATCH", "Amount=" + nominalTransfer + " | Pending orders: " + pendingInfo);
        
        // Alert admin about unmatched payment (only for significant amounts)
        if (adminWA && nominalTransfer >= 10000) {
          sendWA(
            adminWA,
            `⚠️ *UNMATCHED PAYMENT* ⚠️\n\nTransfer masuk Rp ${Number(nominalTransfer).toLocaleString('id-ID')} dari Moota TIDAK COCOK dengan order manapun.\n\nDeskripsi: ${String(mutasi.description || "-").substring(0, 100)}\n\nPending Orders:\n${pendingOrders.length > 0 ? pendingOrders.slice(0, 5).map(o => "• " + o.inv + " = Rp " + Number(o.tagihan).toLocaleString('id-ID')).join("\n") : "(tidak ada order pending)"}\n\nMohon cek manual di dashboard.`,
            cfg
          );
        }
      }
    }

    const resultSummary = matched.length > 0
      ? "PROCESSED: " + matched.join(", ")
      : "NO_MATCHING_ORDER";
    logMoota_("RESULT", resultSummary + " | Logs: " + debugLog.join(" | "));
      
    return ContentService.createTextOutput(JSON.stringify({
       status: "success", 
       processed: matched, 
       logs: debugLog 
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (e) {
    logMoota_("ERROR", e.toString());
    return ContentService.createTextOutput(JSON.stringify({
       status: "error", 
       message: e.toString() 
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/* =========================
   FORGOT PASSWORD
========================= */
function forgotPassword(d) {
  try {
    const s = mustSheet_("Users");
    const r = s.getDataRange().getValues();
    const email = String(d.email).trim().toLowerCase();
    const cfg = getSettingsMap_();
    const siteName = getCfgFrom_(cfg, "site_name") || "Sistem Premium";
    
    let found = false;
    let nama = "";
    let rowIndex = -1;
    let tempPass = "";
    
    for (let i = 1; i < r.length; i++) {
      if (String(r[i][1]).trim().toLowerCase() === email) {
        rowIndex = i + 1;
        nama = r[i][3];
        found = true;
        break;
      }
    }
    
    if (found) {
        // Send Email
        const subject = `Lupa Password - ${siteName}`;
        tempPass = Math.random().toString(36).slice(-10);
        s.getRange(rowIndex, 3).setValue(hashPassword_(tempPass));

        const body = `
          <div style="font-family: sans-serif; padding: 20px;">
            <h3>Halo ${nama},</h3>
            <p>Anda meminta reset password akun.</p>
            <p>Password sementara Anda adalah:</p>
            <p><strong>Email:</strong> ${email}<br>
            <strong>Password Sementara:</strong> ${tempPass}</p>
            <p>Silakan login kembali lalu segera ganti password Anda.</p>
            <br>
            <p>Salam,<br>Tim ${siteName}</p>
          </div>
        `;
        
        sendEmail(email, subject, body, cfg);
        return { status: "success", message: "Password telah dikirim ke email anda." };
    }
    
    return { status: "error", message: "Email tidak ditemukan." };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   PAGINATION ACTIONS
========================= */
function getAdminOrders(d) {
  try {
    requireAdminSession_(d, { actionName: "get_admin_orders" });
    const page = Number(d.page) || 1;
    const limit = Number(d.limit) || 20;
    const o = mustSheet_("Orders").getDataRange().getValues();
    const data = o.slice(1).reverse();
    const start = (page - 1) * limit;
    const end = start + limit;
    
    return {
      status: "success",
      data: data.slice(start, end),
      has_more: data.length > end
    };
  } catch(e) {
    return { status: "error", message: e.toString() };
  }
}

function getAdminUsers(d) {
  try {
    requireAdminSession_(d, { actionName: "get_admin_users" });
    const page = Number(d.page) || 1;
    const limit = Number(d.limit) || 20;
    const u = mustSheet_("Users").getDataRange().getValues();
    const data = u.slice(1).reverse();
    const start = (page - 1) * limit;
    const end = start + limit;
    
    return {
      status: "success",
      data: data.slice(start, end),
      has_more: data.length > end
    };
  } catch(e) {
    return { status: "error", message: e.toString() };
  }
}

/* =========================
   DIAGNOSTIC & TEST FUNCTIONS
========================= */
function getEmailLogs_() {
  try {
    const s = ss.getSheetByName("Email_Logs");
    if (!s || s.getLastRow() <= 1) return { status: "success", data: [], message: "No email logs yet" };
    const data = s.getDataRange().getValues();
    return { status: "success", data: data.slice(1).reverse().slice(0, 50) };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function getMootaLogs_() {
  try {
    const s = ss.getSheetByName("Moota_Logs");
    if (!s || s.getLastRow() <= 1) return { status: "success", data: [], message: "No moota logs yet" };
    const data = s.getDataRange().getValues();
    return { status: "success", data: data.slice(1).reverse().slice(0, 50) };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function testEmailDelivery(d) {
  try {
    const email = String(d.email || "").trim();
    if (!email) return { status: "error", message: "Email target wajib diisi" };
    
    const cfg = getSettingsMap_();
    const siteName = getCfgFrom_(cfg, "site_name") || "Sistem Premium";
    
    const testHtml = '<div style="font-family: sans-serif; padding: 20px; max-width: 500px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px;">' +
      '<h2 style="color: #4f46e5;">✅ Test Email Berhasil!</h2>' +
      '<p>Ini adalah email test dari sistem <b>' + siteName + '</b>.</p>' +
      '<p><b>Waktu:</b> ' + new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) + '</p>' +
      '<p><b>Quota Tersisa:</b> ' + MailApp.getRemainingDailyQuota() + ' email</p>' +
      '<p>Jika Anda menerima email ini, berarti sistem email berfungsi normal.</p>' +
      '</div>';
    
    const result = sendEmail(email, "[TEST] Email Test - " + siteName, testHtml, cfg);
    return { status: "success", message: "Test email sent", result: result };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function testMootaWebhook() {
  try {
    const cfg = getSettingsMap_();
    const orders = mustSheet_("Orders").getDataRange().getValues();
    
    // Find a Pending order to simulate
    var testAmount = 0;
    var testInv = "";
    for (var i = orders.length - 1; i >= 1; i--) {
      if (String(orders[i][7]).trim() === "Pending") {
        testAmount = toNumberSafe_(orders[i][6]);
        testInv = orders[i][0];
        break;
      }
    }
    
    if (!testAmount) {
      return { status: "warning", message: "Tidak ada order Pending untuk di-test. Buat order test terlebih dahulu." };
    }
    
    // DRY RUN: simulate matching only, DO NOT actually update status
    return {
      status: "success",
      message: "Dry run - order ditemukan untuk matching",
      test_data: {
        invoice: testInv,
        amount: testAmount,
        would_match: true,
        note: "Ini hanya simulasi. Order TIDAK diubah statusnya. Untuk test penuh, kirim webhook asli dari Moota."
      }
    };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function getSystemHealth() {
  try {
    const cfg = getSettingsMap_();
    const emailQuota = MailApp.getRemainingDailyQuota();
    
    // Count pending orders
    const orders = mustSheet_("Orders").getDataRange().getValues();
    var pendingCount = 0;
    var oldPendingCount = 0;
    for (var i = 1; i < orders.length; i++) {
      if (String(orders[i][7]).trim() === "Pending") {
        pendingCount++;
        var dt = new Date(String(orders[i][8]));
        if (!isNaN(dt.getTime()) && (Date.now() - dt.getTime()) / 36e5 > 72) {
          oldPendingCount++;
        }
      }
    }
    
    // Check config
    const mootaCfg = resolveMootaConfig_({}, cfg);
    const mootaToken = mootaCfg.token;
    const mootaGasUrl = normalizeMootaUrl_(mootaCfg.gasUrl || getCurrentWebAppUrl_());
    const fonnteToken = getSecret_("fonnte_token", cfg);
    
    // Email log stats
    var emailLogCount = 0, emailFailCount = 0;
    var emailSheet = ss.getSheetByName("Email_Logs");
    if (emailSheet && emailSheet.getLastRow() > 1) {
      var eLogs = emailSheet.getDataRange().getValues();
      emailLogCount = eLogs.length - 1;
      for (var j = 1; j < eLogs.length; j++) {
        if (String(eLogs[j][1]) === "FAILED" || String(eLogs[j][1]) === "QUOTA_EXCEEDED") emailFailCount++;
      }
    }
    
    // Moota log stats
    var mootaLogCount = 0, mootaNoMatch = 0;
    var mootaSheet = ss.getSheetByName("Moota_Logs");
    if (mootaSheet && mootaSheet.getLastRow() > 1) {
      var mLogs = mootaSheet.getDataRange().getValues();
      mootaLogCount = mLogs.length - 1;
      for (var k = 1; k < mLogs.length; k++) {
        if (String(mLogs[k][1]) === "NO_MATCH") mootaNoMatch++;
      }
    }
    
    // WA log stats
    var waSentCount = 0, waFailCount = 0, waRejectedCount = 0, waLogCount = 0;
    var waSheet = ss.getSheetByName("WA_Logs");
    if (waSheet && waSheet.getLastRow() > 1) {
      var wLogs = waSheet.getDataRange().getValues();
      waLogCount = wLogs.length - 1;
      for (var w = 1; w < wLogs.length; w++) {
        var wStatus = String(wLogs[w][1]);
        if (wStatus === "SENT" || wStatus === "SENT_UNVERIFIED") waSentCount++;
        else if (wStatus === "REJECTED") waRejectedCount++;
        else if (wStatus === "HTTP_ERROR" || wStatus === "EXCEPTION" || wStatus === "NO_TOKEN") waFailCount++;
      }
    }
    
    return {
      status: "success",
      health: {
        email: {
          quota_remaining: emailQuota,
          quota_warning: emailQuota < 10,
          total_logs: emailLogCount,
          failed_count: emailFailCount
        },
        whatsapp: {
          total_logs: waLogCount,
          sent_count: waSentCount,
          rejected_count: waRejectedCount,
          failed_count: waFailCount,
          sent_rate: waLogCount > 0 ? Math.round((waSentCount / waLogCount) * 100) + "%" : "N/A"
        },
        moota: {
          gas_url_configured: !!mootaGasUrl,
          secret_token_configured: !!mootaToken,
          total_webhooks: mootaLogCount,
          unmatched_count: mootaNoMatch
        },
        orders: {
          pending_count: pendingCount,
          stale_pending: oldPendingCount
        },
        integrations: {
          fonnte_configured: !!fonnteToken,
          moota_configured: !!mootaToken && !!mootaGasUrl
        }
      }
    };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function getWALogs_() {
  try {
    var s = ss.getSheetByName("WA_Logs");
    if (!s || s.getLastRow() <= 1) return { status: "success", data: [], message: "No WA logs yet" };
    var data = s.getDataRange().getValues();
    return { status: "success", data: data.slice(1).reverse().slice(0, 50) };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

function testWADelivery(d) {
  try {
    var target = String(d.target || d.whatsapp || "").trim();
    if (!target) return { status: "error", message: "Nomor WhatsApp target wajib diisi (parameter: target)" };
    
    var cfg = getSettingsMap_();
    var siteName = getCfgFrom_(cfg, "site_name") || "Sistem Premium";
    var testMessage = "✅ *TEST WA BERHASIL!*\n\nIni adalah pesan test dari sistem *" + siteName + "*.\n\nWaktu: " + new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) + "\n\nJika Anda menerima pesan ini, berarti koneksi WhatsApp via Fonnte berfungsi normal.";
    
    var result = sendWA(target, testMessage, cfg);
    return { status: "success", message: "Test WA sent to " + target, result: result };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

/**
 * testLunasNotification — Simulates the EXACT Lunas notification flow.
 * Finds a pending/existing order and sends WA + Email using the same code path 
 * as updateOrderStatus. Does NOT change the order status.
 * 
 * Call: {"action":"test_lunas_notification","invoice":"INV-XXXXX"}
 * Or:   {"action":"test_lunas_notification"} (auto-finds the latest pending order)
 */
function testLunasNotification(d) {
  try {
    var cfg = getSettingsMap_();
    var s = mustSheet_("Orders");
    var pS = mustSheet_("Access_Rules");
    var r = s.getDataRange().getValues();
    var siteName = getCfgFrom_(cfg, "site_name") || "Sistem Premium";
    var targetInv = String(d.invoice || d.id || "").trim();
    
    // Find order (specific or latest pending)
    var orderRow = null;
    var orderRowIdx = -1;
    for (var i = r.length - 1; i >= 1; i--) {
      if (targetInv) {
        if (String(r[i][0]) === targetInv) { orderRow = r[i]; orderRowIdx = i; break; }
      } else {
        if (String(r[i][7]).trim() === "Pending") { orderRow = r[i]; orderRowIdx = i; break; }
      }
    }
    
    if (!orderRow) {
      return { status: "error", message: targetInv ? "Invoice " + targetInv + " tidak ditemukan" : "Tidak ada order Pending. Buat order test dulu." };
    }
    
    var inv = orderRow[0];
    var uEmail = orderRow[1];
    var uName = orderRow[2];
    var uWA = orderRow[3];
    var pId = orderRow[4];
    var pName = orderRow[5];
    
    // Debug: capture raw data from sheet
    var debugInfo = {
      invoice: inv,
      row_index: orderRowIdx + 1,
      wa_raw_value: uWA,
      wa_raw_type: typeof uWA,
      wa_json: JSON.stringify(uWA),
      wa_normalized: normalizePhone_(uWA),
      email: uEmail,
      name: uName,
      product: pName,
      current_status: orderRow[7]
    };
    
    // Get access URL
    var accessUrl = "";
    var pData = pS.getDataRange().getValues();
    for (var k = 1; k < pData.length; k++) {
      if (String(pData[k][0]) === String(pId)) { accessUrl = pData[k][3]; break; }
    }
    debugInfo.access_url = accessUrl;
    
    // SEND WA (same message as real Lunas flow)
    logWA_("TEST_LUNAS", String(uWA), "Testing Lunas notification for " + inv + " | WA raw=" + JSON.stringify(uWA) + " type=" + typeof uWA);
    var waResult = sendWA(
      uWA,
      "🎉 *[TEST] PEMBAYARAN TERVERIFIKASI!* 🎉\n\nHalo *" + uName + "*, ini adalah TEST notifikasi Lunas.\n\nProduk *" + pName + "* (Invoice: #" + inv + ")\n\n🚀 *AKSES MATERI:*\n" + accessUrl + "\n\nIni pesan test. Jika terkirim berarti notifikasi Lunas berfungsi normal.\n*Tim " + siteName + "*",
      cfg
    );
    
    // SEND EMAIL (same template as real Lunas flow)
    var emailHtml = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e2e8f0;border-radius:8px;">' +
      '<h2 style="color:#10b981;">[TEST] Akses Terbuka! 🎉</h2>' +
      '<p>Halo <b>' + uName + '</b>,</p>' +
      '<p>Ini adalah TEST notifikasi Lunas untuk produk <b>' + pName + '</b>.</p>' +
      '<div style="text-align:center;margin:30px 0;">' +
      '<a href="' + accessUrl + '" style="background-color:#4f46e5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">Akses Materi</a>' +
      '</div>' +
      '<p>Jika Anda menerima email ini, notifikasi Lunas berfungsi normal.</p>' +
      '<p>Tim <b>' + siteName + '</b></p></div>';
    var emailResult = sendEmail(uEmail, "[TEST] Akses Terbuka - " + siteName, emailHtml, cfg);
    
    return {
      status: "success",
      message: "Test Lunas notification sent for " + inv,
      debug: debugInfo,
      results: {
        wa: waResult,
        email: emailResult
      }
    };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}
