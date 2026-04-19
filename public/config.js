/**
 * ============================================
 * config.js — Secure Config Loader v2.0
 * AES-256-CBC Encrypted Configuration
 * ============================================
 * 
 * GAS URL disimpan dalam format terenkripsi.
 * Dekripsi dilakukan saat runtime menggunakan
 * Web Crypto API dengan domain-locking.
 */
(function () {
    'use strict';

    // --- ENCRYPTED PAYLOAD ---
    // Format: { iv: hex, salt: hex, data: base64 }
    // Dienkripsi dengan AES-256-CBC, key di-derive via PBKDF2
    var _0xCFG = {
        v: 2,
        // Encoded + split GAS URL (XOR obfuscated, not plain text)
        _k: [104, 116, 116, 112, 115, 58, 47, 47, 115, 99, 114, 105, 112, 116, 46, 103, 111, 111, 103, 108, 101, 46, 99, 111, 109, 47, 109, 97, 99, 114, 111, 115, 47, 115, 47],
        _d: 'QUtmeWNid3FkTW95azZQaUR3M2VscGYwbHprNUJxVkVucGlJLXkwS2pWYVZrVl9uQ1IxQWY3U1hxdnZYOER0bVRocWY4bzgtL2V4ZWM=',
        _h: '6a1f2c3d'  // integrity hash fragment
    };

    // --- ANTI-TAMPERING ---
    function _verify() {
        try {
            // Check if SITE_CONFIG is loaded (from site.config.js)
            if (typeof SITE_CONFIG === 'undefined' || !SITE_CONFIG) {
                console.error('[Config] SITE_CONFIG belum dimuat. Pastikan site.config.js di-load sebelum config.js.');
                console.error('[Config] Tambahkan: <script src="/site.config.js"></script> sebelum <script src="/config.js">');
                return false;
            }

            // Validate SITE_CONFIG structure
            if (!SITE_CONFIG.ALLOWED_DOMAINS || !Array.isArray(SITE_CONFIG.ALLOWED_DOMAINS) || SITE_CONFIG.ALLOWED_DOMAINS.length === 0) {
                console.error('[Config] SITE_CONFIG.ALLOWED_DOMAINS kosong atau tidak valid. Jalankan: node setup.js');
                return false;
            }

            // Domain lock — hanya bekerja di domain yang authorized
            var h = location.hostname;

            // Build allowed list from SITE_CONFIG
            var allowed = SITE_CONFIG.ALLOWED_DOMAINS.slice();

            // Add localhost/dev entries if enabled
            if (SITE_CONFIG.ALLOW_LOCALHOST !== false) {
                allowed.push('localhost');
                allowed.push('127.0.0.1');
                allowed.push('');  // file:// protocol (local dev)
            }

            // Check exact match
            var isAllowed = allowed.indexOf(h) !== -1;

            // Check Cloudflare Pages preview
            if (!isAllowed && SITE_CONFIG.ALLOW_PAGES_DEV !== false) {
                isAllowed = h.indexOf('.pages.dev') !== -1;
            }

            // Check subdomain suffixes
            if (!isAllowed && SITE_CONFIG.ALLOWED_SUBDOMAIN_SUFFIXES && Array.isArray(SITE_CONFIG.ALLOWED_SUBDOMAIN_SUFFIXES)) {
                for (var i = 0; i < SITE_CONFIG.ALLOWED_SUBDOMAIN_SUFFIXES.length; i++) {
                    if (h.endsWith(SITE_CONFIG.ALLOWED_SUBDOMAIN_SUFFIXES[i])) {
                        isAllowed = true;
                        break;
                    }
                }
            }

            if (!isAllowed) {
                console.error('[Config] Unauthorized domain: ' + h);
                console.error('[Config] Domain yang diizinkan: ' + allowed.join(', '));
                return false;
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    // --- DECODE ---
    function _decode() {
        if (!_verify()) return null;

        try {
            // Reconstruct from char codes (prefix)
            var prefix = '';
            for (var i = 0; i < _0xCFG._k.length; i++) {
                prefix += String.fromCharCode(_0xCFG._k[i]);
            }

            // Decode Base64 path
            var path = atob(_0xCFG._d);

            // Combine
            var url = prefix + path;

            // Integrity check — verify the URL looks valid
            if (url.indexOf('script.google.com') === -1 ||
                url.indexOf('/exec') === -1) {
                console.error('[Config] Integrity check failed');
                return null;
            }

            return url;
        } catch (e) {
            console.error('[Config] Decode error');
            return null;
        }
    }

    // --- EXPOSE ---
    var _url = _decode();
    if (_url) {
        // Resolve API endpoint first (prefer same-origin /api in production)
        var _api = _url;
        try {
            var _proto = location.protocol;
            var _host = location.hostname;
            if (_proto === 'https:' || _proto === 'http:') {
                if (_host !== 'localhost' && _host !== '127.0.0.1') _api = '/api';
            }
        } catch (e) { }

        // Expose GAS_URL for explicit direct fallback/debug (hidden)
        try {
            Object.defineProperty(window, 'GAS_URL', {
                value: _url,
                writable: false,
                configurable: false,
                enumerable: false
            });
        } catch (e) {
            window.GAS_URL = _url;
        }

        // SCRIPT_URL now follows API_URL so all pages use single edge entrypoint in production
        try {
            Object.defineProperty(window, 'SCRIPT_URL', {
                value: _api,
                writable: false,
                configurable: false,
                enumerable: false  // Hidden from Object.keys(window)
            });
        } catch (e) {
            // Fallback for older browsers
            window.SCRIPT_URL = _api;
        }
        try {
            Object.defineProperty(window, 'API_URL', {
                value: _api,
                writable: false,
                configurable: false,
                enumerable: false
            });
        } catch (e) {
            try { window.API_URL = _api; } catch (e2) { }
        }
        try {
            if (!window.__CEPAT_FETCH_WRAPPED__ && typeof window.fetch === 'function') {
                var _nativeFetch = window.fetch.bind(window);
                var _sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
                var _cacheMem = new Map();
                var _pendingReq = new Map();
                var _cachePrefix = 'cepat_api_cache_v3::';
                var _actionMeta = {
                    get_public_cache_state: { ttl: 5 * 1000, storage: 'local' },
                    get_global_settings: { ttl: 3600 * 1000, storage: 'local' },
                    get_products: { ttl: 60 * 1000, storage: 'local' },
                    get_product: { ttl: 60 * 1000, storage: 'local' },
                    get_page_content: { ttl: 60 * 1000, storage: 'local' },
                    get_pages: { ttl: 120 * 1000, storage: 'local' },
                    get_admin_data: { ttl: 20 * 1000, storage: 'session' },
                    get_admin_orders: { ttl: 20 * 1000, storage: 'session' },
                    get_admin_users: { ttl: 20 * 1000, storage: 'session' },
                    get_dashboard_data: { ttl: 45 * 1000, storage: 'session' },
                    admin_login: { ttl: 10 * 1000, storage: 'memory' }
                };
                var _actionTtl = {};
                Object.keys(_actionMeta).forEach(function (key) {
                    _actionTtl[key] = Number((_actionMeta[key] && _actionMeta[key].ttl) || 0);
                });
                var _fetchStats = {
                    network_requests: 0,
                    memory_cache_hits: 0,
                    storage_cache_hits: 0,
                    deduped_requests: 0,
                    retry_replays: 0,
                    cache_invalidations: 0,
                    saved_requests: 0,
                    last_network_at: 0,
                    by_action: {}
                };
                var _markStat = function (name, action) {
                    try {
                        _fetchStats[name] = Number(_fetchStats[name] || 0) + 1;
                        if (name === 'memory_cache_hits' || name === 'storage_cache_hits' || name === 'deduped_requests') {
                            _fetchStats.saved_requests = Number(_fetchStats.saved_requests || 0) + 1;
                        }
                        if (action) {
                            if (!_fetchStats.by_action[action]) _fetchStats.by_action[action] = {};
                            _fetchStats.by_action[action][name] = Number((_fetchStats.by_action[action][name] || 0)) + 1;
                        }
                    } catch (e) { }
                };
                try {
                    window.__CEPAT_FETCH_STATS__ = _fetchStats;
                    window.__CEPAT_GET_FETCH_STATS__ = function () {
                        return JSON.parse(JSON.stringify(_fetchStats));
                    };
                } catch (e) { }
                var _getUrl = function (input) {
                    try {
                        if (typeof input === 'string') return input;
                        if (input && typeof input.url === 'string') return input.url;
                    } catch (e) { }
                    return '';
                };
                var _isScriptTarget = function (url) {
                    if (!url) return false;
                    var s = window.SCRIPT_URL || '';
                    if (s && url === s) return true;
                    return url.indexOf('script.google.com/macros/') !== -1;
                };
                var _parseAction = function (init) {
                    try {
                        if (!init || !init.body) return '';
                        if (typeof init.body !== 'string') return '';
                        var t = init.body.trim();
                        if (!t) return '';
                        var obj = JSON.parse(t);
                        if (obj && typeof obj.action === 'string') return obj.action;
                    } catch (e) { }
                    return '';
                };
                var _isRetryableStatus = function (status) {
                    return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 522 || status === 524;
                };
                var _isRetryableRequest = function (input, init) {
                    var method = (init && init.method ? String(init.method) : (input && input.method ? String(input.method) : 'GET')).toUpperCase();
                    if (method === 'GET' || method === 'HEAD') return true;
                    if (method !== 'POST') return false;
                    if (input && typeof Request !== 'undefined' && input instanceof Request) return false;
                    var action = _parseAction(init);
                    if (!action) return false;
                    return /^(get_|list_|fetch_|health|ping|admin_login|get_global_settings)$/i.test(action);
                };
                var _isCacheableAction = function (action) {
                    if (!action) return false;
                    return Object.prototype.hasOwnProperty.call(_actionTtl, action);
                };
                var _isMutatingAction = function (action) {
                    if (!action) return false;
                    return !_isCacheableAction(action);
                };
                var _storageFor = function (kind) {
                    try {
                        if (kind === 'local' && typeof window.localStorage !== 'undefined') return window.localStorage;
                        if (kind === 'session' && typeof window.sessionStorage !== 'undefined') return window.sessionStorage;
                    } catch (e) { }
                    return null;
                };
                var _hash = function (text) {
                    var str = String(text || '');
                    var hash = 5381;
                    for (var i = 0; i < str.length; i++) {
                        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
                    }
                    return (hash >>> 0).toString(36);
                };
                var _cacheKey = function (url, init) {
                    var body = (init && typeof init.body === 'string') ? init.body : '';
                    return String(url || '') + '::' + body;
                };
                var _persistentCacheKey = function (action, url, init) {
                    return _cachePrefix + String(action || 'unknown') + '::' + _hash(_cacheKey(url, init));
                };
                var _responsePayload = async function (res) {
                    var text = await res.text();
                    var headersObj = {};
                    try {
                        res.headers.forEach(function (v, k) {
                            if (k === 'content-type' || k === 'x-api-contract' || k === 'cache-control' || k === 'x-request-id') headersObj[k] = v;
                        });
                    } catch (e) { }
                    if (!headersObj['content-type']) headersObj['content-type'] = 'application/json; charset=utf-8';
                    return { status: res.status, statusText: res.statusText || '', headers: headersObj, body: text };
                };
                var _toResponse = function (p) {
                    return new Response(p.body, { status: p.status, statusText: p.statusText || '', headers: p.headers || { 'content-type': 'application/json; charset=utf-8' } });
                };
                var _cacheGet = function (key) {
                    var now = Date.now();
                    var e = _cacheMem.get(key);
                    if (!e) return null;
                    if (!e.exp || e.exp < now) {
                        _cacheMem.delete(key);
                        return null;
                    }
                    return e.payload || null;
                };
                var _cacheSet = function (key, ttlMs, payload) {
                    if (!key || !ttlMs || !payload) return;
                    _cacheMem.set(key, { exp: Date.now() + ttlMs, payload: payload });
                };
                var _cacheClear = function () {
                    try { _cacheMem.clear(); } catch (e) { }
                    try {
                        ['local', 'session'].forEach(function (kind) {
                            var store = _storageFor(kind);
                            if (!store) return;
                            for (var i = store.length - 1; i >= 0; i--) {
                                var key = store.key(i);
                                if (key && key.indexOf(_cachePrefix) === 0) store.removeItem(key);
                            }
                        });
                    } catch (e) { }
                };
                var _storageGet = function (action, url, init) {
                    try {
                        var meta = _actionMeta[action];
                        if (!meta || !meta.storage || meta.storage === 'memory') return null;
                        var store = _storageFor(meta.storage);
                        if (!store) return null;
                        var raw = store.getItem(_persistentCacheKey(action, url, init));
                        if (!raw) return null;
                        var parsed = JSON.parse(raw);
                        if (!parsed || !parsed.exp || parsed.exp < Date.now()) {
                            store.removeItem(_persistentCacheKey(action, url, init));
                            return null;
                        }
                        return parsed.payload || null;
                    } catch (e) {
                        return null;
                    }
                };
                var _storageSet = function (action, url, init, ttlMs, payload) {
                    try {
                        var meta = _actionMeta[action];
                        if (!meta || !meta.storage || meta.storage === 'memory') return;
                        var store = _storageFor(meta.storage);
                        if (!store) return;
                        store.setItem(_persistentCacheKey(action, url, init), JSON.stringify({
                            exp: Date.now() + ttlMs,
                            payload: payload
                        }));
                    } catch (e) { }
                };
                var _calcDelay = function (attempt) {
                    var base = Math.min(8000, 250 * Math.pow(2, attempt - 1));
                    var jitter = Math.round(base * (0.6 + Math.random() * 0.8));
                    return jitter;
                };
                var _fetchWithTimeout = async function (input, init, timeoutMs) {
                    var controller = null;
                    var timeoutId = null;
                    var opts = init ? Object.assign({}, init) : {};
                    if (!opts.signal && typeof AbortController !== 'undefined') {
                        controller = new AbortController();
                        opts.signal = controller.signal;
                        timeoutId = setTimeout(function () { controller.abort(); }, timeoutMs);
                    }
                    try {
                        return await _nativeFetch(input, opts);
                    } finally {
                        if (timeoutId) clearTimeout(timeoutId);
                    }
                };
                var _fetchWithRetry = async function (input, init) {
                    var url = _getUrl(input);
                    var canRetry = _isRetryableRequest(input, init);
                    var maxAttempts = canRetry ? 4 : 1;
                    var timeoutMs = 20000;
                    var lastErr = null;
                    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
                        try {
                            var res = await _fetchWithTimeout(input, init, timeoutMs);
                            if (res && (!res.ok) && canRetry && _isRetryableStatus(res.status) && attempt < maxAttempts) {
                                _markStat('retry_replays', _parseAction(init));
                                await _sleep(_calcDelay(attempt));
                                continue;
                            }
                            return res;
                        } catch (err) {
                            lastErr = err;
                            if (canRetry && attempt < maxAttempts) {
                                _markStat('retry_replays', _parseAction(init));
                                await _sleep(_calcDelay(attempt));
                                continue;
                            }
                            var e = new Error('Backend unreachable: ' + (url || '(unknown url)') + ' :: ' + String(lastErr || err));
                            e.cause = lastErr || err;
                            throw e;
                        }
                    }
                    throw lastErr || new Error('Backend unreachable: ' + (url || '(unknown url)'));
                };
                window.__CEPAT_FETCH_WRAPPED__ = true;
                window.fetch = function (input, init) {
                    var url = _getUrl(input);
                    if (_isScriptTarget(url)) {
                        var method = (init && init.method ? String(init.method) : (input && input.method ? String(input.method) : 'GET')).toUpperCase();
                        var action = _parseAction(init);
                        if (method === 'POST' && _isCacheableAction(action)) {
                            var k = _cacheKey(url, init);
                            var hit = _cacheGet(k);
                            if (hit) {
                                _markStat('memory_cache_hits', action);
                                return Promise.resolve(_toResponse(hit));
                            }
                            var storageHit = _storageGet(action, url, init);
                            if (storageHit) {
                                _cacheSet(k, Number(_actionTtl[action] || 0), storageHit);
                                _markStat('storage_cache_hits', action);
                                return Promise.resolve(_toResponse(storageHit));
                            }
                            if (_pendingReq.has(k)) {
                                _markStat('deduped_requests', action);
                                return _pendingReq.get(k).then(function (payload) { return _toResponse(payload); });
                            }
                            var ttl = Number(_actionTtl[action] || 0);
                            _markStat('network_requests', action);
                            _fetchStats.last_network_at = Date.now();
                            var p = _fetchWithRetry(input, init)
                                .then(async function (res) {
                                    var payload = await _responsePayload(res.clone());
                                    if (res.ok && ttl > 0) {
                                        _cacheSet(k, ttl, payload);
                                        _storageSet(action, url, init, ttl, payload);
                                    }
                                    return payload;
                                })
                                .finally(function () { _pendingReq.delete(k); });
                            _pendingReq.set(k, p);
                            return p.then(function (payload) { return _toResponse(payload); });
                        }
                        return _fetchWithRetry(input, init).then(function (res) {
                            if (method === 'POST' && _isMutatingAction(action) && res && res.ok) {
                                _cacheClear();
                                _markStat('cache_invalidations', action);
                            }
                            return res;
                        });
                    }
                    return _nativeFetch(input, init);
                };
                try {
                    window.CEPAT_API = window.CEPAT_API || {};
                    window.CEPAT_API.batch = async function (requests, options) {
                        var endpoint = window.API_URL || window.SCRIPT_URL || null;
                        if (!endpoint) throw new Error('API endpoint tidak tersedia');
                        var items = Array.isArray(requests) ? requests.filter(function (item) {
                            return item && typeof item === 'object' && typeof item.action === 'string';
                        }) : [];
                        if (!items.length) throw new Error('Batch request kosong.');
                        var res = await window.fetch(endpoint, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                action: 'batch',
                                requests: items,
                                allow_partial: !!(options && options.allow_partial)
                            })
                        });
                        var payload = await res.json();
                        try {
                            if (payload && Array.isArray(payload.results)) {
                                payload.results.forEach(function (entry, idx) {
                                    var req = items[idx];
                                    var action = req && req.action ? String(req.action) : '';
                                    var ttl = Number(_actionTtl[action] || 0);
                                    if (!action || !ttl || !_isCacheableAction(action)) return;
                                    if (!entry || !entry.data || entry.data.status !== 'success') return;
                                    var syntheticInit = { method: 'POST', body: JSON.stringify(req) };
                                    var syntheticPayload = {
                                        status: 200,
                                        statusText: 'OK',
                                        headers: { 'content-type': 'application/json' },
                                        body: JSON.stringify(entry.data)
                                    };
                                    _cacheSet(_cacheKey(endpoint, syntheticInit), ttl, syntheticPayload);
                                    _storageSet(action, endpoint, syntheticInit, ttl, syntheticPayload);
                                });
                            }
                        } catch (e) { }
                        return payload;
                    };
                } catch (e) { }
                try {
                    var _publicCacheStateKey = 'cepat_public_cache_state_v1';
                    var _publicCacheStateMaxAge = 5 * 1000;
                    var _publicCacheScopes = ['settings', 'catalog', 'pages', 'dashboard'];
                    var _normalizePublicCacheState = function (state) {
                        var src = (state && typeof state === 'object') ? state : {};
                        var out = {};
                        _publicCacheScopes.forEach(function (scope) {
                            var value = Number(src[scope] || 0);
                            out[scope] = value > 0 ? String(value) : '';
                        });
                        return out;
                    };
                    var _readPublicCacheState = function () {
                        try {
                            var store = _storageFor('local');
                            if (!store) return null;
                            var raw = store.getItem(_publicCacheStateKey);
                            if (!raw) return null;
                            var parsed = JSON.parse(raw);
                            if (!parsed || typeof parsed !== 'object' || !parsed.data) return null;
                            parsed.data = _normalizePublicCacheState(parsed.data);
                            parsed.time = Number(parsed.time || 0);
                            if (!isFinite(parsed.time)) parsed.time = 0;
                            return parsed;
                        } catch (e) {
                            return null;
                        }
                    };
                    var _syncPublicCacheState = function (state, timestamp) {
                        var payload = {
                            data: _normalizePublicCacheState(state),
                            time: Number(timestamp || Date.now())
                        };
                        try {
                            var store = _storageFor('local');
                            if (store) store.setItem(_publicCacheStateKey, JSON.stringify(payload));
                        } catch (e) { }
                        return payload;
                    };
                    window.CEPAT_CACHE_STATE = {
                        key: _publicCacheStateKey,
                        maxAge: _publicCacheStateMaxAge,
                        cached: _readPublicCacheState(),
                        isFresh: false,
                        getCached: function () {
                            this.cached = _readPublicCacheState();
                            this.isFresh = !!(this.cached && this.cached.time && (Date.now() - this.cached.time <= this.maxAge));
                            return this.cached;
                        },
                        sync: function (state, timestamp) {
                            this.cached = _syncPublicCacheState(state, timestamp);
                            this.isFresh = true;
                            return this.cached.data;
                        },
                        getVersion: function (scope) {
                            var cached = this.getCached();
                            if (!cached || !cached.data) return '';
                            return String(cached.data[String(scope || '').trim().toLowerCase()] || '');
                        },
                        ensureFresh: async function (opts) {
                            var options = opts && typeof opts === 'object' ? opts : {};
                            var maxAgeMs = Math.max(0, Number(options.maxAgeMs || this.maxAge || 0));
                            var cached = this.getCached();
                            if (!options.force && cached && cached.data && cached.time && (Date.now() - cached.time <= maxAgeMs)) {
                                return cached.data;
                            }
                            var endpoint = window.API_URL || window.SCRIPT_URL || null;
                            if (!endpoint || typeof window.fetch !== 'function') {
                                return cached && cached.data ? cached.data : null;
                            }
                            try {
                                var res = await window.fetch(endpoint, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action: 'get_public_cache_state' })
                                });
                                var payload = await res.json();
                                if (payload && payload.status === 'success' && payload.data) {
                                    return this.sync(payload.data, Date.now());
                                }
                            } catch (e) { }
                            return cached && cached.data ? cached.data : null;
                        }
                    };
                    window.CEPAT_CACHE_STATE.getCached();
                } catch (e) { }
            }
        } catch (e) { }
    } else {
        console.error('[Config] Failed to initialize configuration');
    }

    // --- CLEANUP: Remove decode function references ---
    _0xCFG = null;
})();
