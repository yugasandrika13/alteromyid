// Cloudflare Pages Advanced Mode Worker
// Handles POST /webhook/moota, passes everything else to static assets

// Parse ALLOWED_ORIGINS from env (comma-separated) — cached per-request
let _parsedOrigins = null;
let _parsedOriginsRaw = null;

const _metrics = {
  started_at: Date.now(),
  requests_total: 0,
  api_requests: 0,
  api_cache_hit: 0,
  api_cache_miss: 0,
  assets_cache_hit: 0,
  assets_cache_miss: 0,
  compressed: 0,
  rate_limited: 0
};

const _topPaths = new Map();
const _topApiActions = new Map();
const _hourlyRequests = new Map();
const _dailyRequests = new Map();
const _alertState = new Map();
const _apiCircuit = {
  consecutive_failures: 0,
  opened_until: 0,
  last_error: '',
  last_failure_at: 0
};
const _inFlightApi = new Map();

const _blockedPaths = new Set([
  '/appscript.js',
  '/load_test.js',
  '/workers.ts',
  '/AUDIT_REPORT.md',
  '/SOP_DATA_CONSISTENCY.md',
  '/setup.js',
  '/validate-config.js',
  '/test-auth.js',
  '/wrangler.jsonc',
  '/package.json',
  '/tailwind.config.js',
  '/tailwind.input.css'
]);

function inc(key, n = 1) {
  try { _metrics[key] = (_metrics[key] || 0) + n; } catch (e) { }
}

function mapIncLimited(map, key, limit = 50) {
  if (!key) return;
  const k = String(key);
  map.set(k, (map.get(k) || 0) + 1);
  if (map.size <= limit) return;
  let minKey = null;
  let minVal = Infinity;
  for (const [kk, vv] of map.entries()) {
    if (vv < minVal) {
      minVal = vv;
      minKey = kk;
    }
  }
  if (minKey != null) map.delete(minKey);
}

function utcDayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function utcHourKey(ts) {
  return new Date(ts).toISOString().slice(0, 13) + ':00Z';
}

function keyedIncLimited(map, key, n = 1, limit = 96) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + n);
  if (map.size <= limit) return;
  const keys = Array.from(map.keys()).sort();
  while (keys.length > limit) {
    const oldest = keys.shift();
    if (oldest != null) map.delete(oldest);
  }
}

function recordRequestBudget(nowTs) {
  keyedIncLimited(_hourlyRequests, utcHourKey(nowTs), 1, 72);
  keyedIncLimited(_dailyRequests, utcDayKey(nowTs), 1, 35);
}

function getBudgetConfig(env) {
  const dailyLimit = Math.max(1, Number(env && env.WORKER_REQUEST_DAILY_LIMIT || 100000));
  const warn80 = Math.max(1, Number(env && env.WORKER_ALERT_THRESHOLD_80 || 80));
  const warn90 = Math.max(1, Number(env && env.WORKER_ALERT_THRESHOLD_90 || 90));
  return { dailyLimit, warn80, warn90 };
}

function getBudgetSnapshot(env) {
  const now = Date.now();
  const cfg = getBudgetConfig(env);
  const dayKey = utcDayKey(now);
  const hourKey = utcHourKey(now);
  const currentDay = Number(_dailyRequests.get(dayKey) || 0);
  const currentHour = Number(_hourlyRequests.get(hourKey) || 0);
  const percent = Math.round((currentDay / cfg.dailyLimit) * 10000) / 100;
  const alerts = [];
  if (percent >= cfg.warn80) alerts.push({ level: 'warning', threshold: cfg.warn80, message: 'Daily request budget reached 80% threshold.' });
  if (percent >= cfg.warn90) alerts.push({ level: 'critical', threshold: cfg.warn90, message: 'Daily request budget reached 90% threshold.' });
  const hourlySeries = Array.from(_hourlyRequests.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-24).map(([bucket, count]) => ({ bucket, count }));
  const dailySeries = Array.from(_dailyRequests.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-14).map(([bucket, count]) => ({ bucket, count }));
  return {
    utc_day: dayKey,
    utc_hour: hourKey,
    current_hour_requests: currentHour,
    current_day_requests: currentDay,
    daily_limit: cfg.dailyLimit,
    daily_percent: percent,
    alerts,
    hourly_series: hourlySeries,
    daily_series: dailySeries
  };
}

async function maybeDispatchBudgetAlert(env, ctx) {
  try {
    const webhookUrl = env && env.WORKER_ALERT_WEBHOOK_URL ? String(env.WORKER_ALERT_WEBHOOK_URL) : '';
    if (!webhookUrl) return;
    const snapshot = getBudgetSnapshot(env);
    const dayKey = snapshot.utc_day;
    const alerts = snapshot.alerts || [];
    if (!alerts.length) return;
    const sent = _alertState.get(dayKey) || {};
    const nextAlert = alerts.find(function (item) { return !sent[item.threshold]; });
    if (!nextAlert) return;
    sent[nextAlert.threshold] = true;
    _alertState.set(dayKey, sent);
    const payload = JSON.stringify({
      status: 'warning',
      source: 'cloudflare-worker',
      alert: nextAlert,
      budget: snapshot
    });
    if (ctx) {
      ctx.waitUntil(fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      }));
    }
  } catch (e) { }
}

function apiCircuitState() {
  const now = Date.now();
  return {
    is_open: _apiCircuit.opened_until > now,
    opened_until: _apiCircuit.opened_until,
    consecutive_failures: _apiCircuit.consecutive_failures,
    last_error: _apiCircuit.last_error,
    last_failure_at: _apiCircuit.last_failure_at
  };
}

function recordApiCircuitSuccess() {
  _apiCircuit.consecutive_failures = 0;
  _apiCircuit.opened_until = 0;
  _apiCircuit.last_error = '';
}

function recordApiCircuitFailure(message, env) {
  const now = Date.now();
  const threshold = Math.max(2, Number(env && env.API_CIRCUIT_BREAKER_FAILURES || 4));
  const cooldownMs = Math.max(5000, Number(env && env.API_CIRCUIT_BREAKER_COOLDOWN_MS || 30000));
  _apiCircuit.consecutive_failures += 1;
  _apiCircuit.last_error = String(message || '');
  _apiCircuit.last_failure_at = now;
  if (_apiCircuit.consecutive_failures >= threshold) {
    _apiCircuit.opened_until = now + cooldownMs;
  }
}

function metricsAuthOk(request, env) {
  const token = env && env.METRICS_TOKEN ? String(env.METRICS_TOKEN) : '';
  if (!token) return true;
  const url = new URL(request.url);
  const q = url.searchParams.get('t') || '';
  if (q && q === token) return true;
  const h = request.headers.get('Authorization') || '';
  if (h && h.startsWith('Bearer ') && h.slice(7) === token) return true;
  return false;
}

function normalizePath(pathname) {
  try {
    const p = String(pathname || '');
    if (!p) return '/';
    if (p.length > 120) return p.slice(0, 120) + '…';
    return p;
  } catch (e) {
    return '/';
  }
}

function parseAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || '';
  if (raw === _parsedOriginsRaw) return _parsedOrigins;
  _parsedOriginsRaw = raw;
  _parsedOrigins = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  return _parsedOrigins;
}

export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    inc('requests_total');
    recordRequestBudget(startedAt);
    const url = new URL(request.url);
    mapIncLimited(_topPaths, normalizePath(url.pathname), 60);
    maybeDispatchBudgetAlert(env, ctx);

    if (url.pathname === '/favicon.ico') {
      const headers = { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' };
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === '/__worker_metrics') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      if (!metricsAuthOk(request, env)) return new Response('Unauthorized', { status: 401 });
      const topPaths = Array.from(_topPaths.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => ({ path: k, count: v }));
      const topApiActions = Array.from(_topApiActions.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => ({ action: k, count: v }));
      const budget = getBudgetSnapshot(env);
      const cacheHitTotal = Number(_metrics.api_cache_hit || 0) + Number(_metrics.assets_cache_hit || 0);
      const cacheMissTotal = Number(_metrics.api_cache_miss || 0) + Number(_metrics.assets_cache_miss || 0);
      const cacheRatio = (cacheHitTotal + cacheMissTotal) > 0 ? Math.round((cacheHitTotal / (cacheHitTotal + cacheMissTotal)) * 10000) / 100 : 0;
      return new Response(JSON.stringify({
        status: 'ok',
        data: {
          ..._metrics,
          uptime_ms: Date.now() - _metrics.started_at,
          top_paths: topPaths,
          top_api_actions: topApiActions,
          budget,
          circuit_breaker: apiCircuitState(),
          cache_summary: {
            hits: cacheHitTotal,
            misses: cacheMissTotal,
            hit_ratio_percent: cacheRatio
          },
          estimated_saved_requests: cacheHitTotal
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    const pLower = String(url.pathname || '').toLowerCase();
    if (_blockedPaths.has(url.pathname) || _blockedPaths.has(pLower)) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/api') {
      return handleApi(request, env, ctx);
    }

    if (url.pathname === '/health') {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ status: 'error', message: 'Method Not Allowed. Use GET.' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', 'Allow': 'GET' }
        });
      }
      return handleHealth(env, ctx);
    }

    // Route: POST /webhook/moota → Google Apps Script
    if (url.pathname === '/webhook/moota') {
      if (request.method !== 'POST') {
        return new Response(
          JSON.stringify({ status: 'error', message: 'Method Not Allowed. Use POST.' }),
          { status: 405, headers: { 'Content-Type': 'application/json', 'Allow': 'POST' } }
        );
      }
      return handleWebhook(request, env.MOOTA_GAS_URL, env.MOOTA_TOKEN);
    }

    if (request.method === 'GET') {
      const cacheable = isCacheableAssetPath(url.pathname);
      if (cacheable) {
        const cacheKey = new Request(url.toString(), { method: 'GET' });
        const cached = await caches.default.match(cacheKey);
        if (cached) {
          inc('assets_cache_hit');
          return maybeCompress(request, withStaticCacheHeaders(withMetricHeaders(cached, { 'x-edge-cache': 'HIT' }), url.pathname));
        }
        inc('assets_cache_miss');
        try {
          if (env.ASSETS) {
            const res = await env.ASSETS.fetch(request);
            const withHeaders = withStaticCacheHeaders(withMetricHeaders(res, { 'x-edge-cache': 'MISS' }), url.pathname);
            if (res.ok) ctx.waitUntil(caches.default.put(cacheKey, withHeaders.clone()));
            return maybeCompress(request, withHeaders);
          }
        } catch (e) { }
      }
    }

    // Everything else → pass to static assets
    try {
      if (env.ASSETS) {
        const staticRes = await env.ASSETS.fetch(request);
        return maybeCompress(request, withStaticCacheHeaders(staticRes, url.pathname));
      }
    } catch (e) {
      // fallback if ASSETS binding fails
    }

    // Final fallback: fetch the original URL directly
    return maybeCompress(request, withStaticCacheHeaders(await fetch(request), url.pathname));
  }
};

function corsHeadersFor(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = parseAllowedOrigins(env);
  const isPagesPreview = origin.endsWith('.pages.dev');
  let allowOrigin = (allowed.includes(origin) || isPagesPreview) ? origin : '';
  if (!allowOrigin && origin) {
    try {
      const reqUrl = new URL(request.url);
      const oUrl = new URL(origin);
      if (reqUrl.origin === oUrl.origin) allowOrigin = origin;
    } catch (_) { }
  }
  const headers = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Signature',
    'Access-Control-Max-Age': '86400'
  };
  if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;
  return headers;
}

async function handleApi(request, env, ctx) {
  inc('api_requests');
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeadersFor(request, env) });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ status: 'error', message: 'Method Not Allowed. Use POST.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeadersFor(request, env), 'Allow': 'POST, OPTIONS' }
    });
  }

  const gasUrl = env.APP_GAS_URL;
  if (!gasUrl) {
    return new Response(JSON.stringify({ status: 'error', message: 'Missing environment variable (APP_GAS_URL)' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeadersFor(request, env) }
    });
  }

  try {
    const requestId = request.headers.get('x-request-id') || ('api_' + Date.now() + '_' + Math.random().toString(16).slice(2));
    const body = await request.text();
    const contentType = request.headers.get('Content-Type') || 'application/json';
    const parsedBody = parseJsonObject(body);

    const softLimit = Number(env.API_RPM_SOFT_LIMIT || 0);
    if (softLimit > 0) {
      const ok = softRateLimitOk(request, softLimit);
      if (!ok) {
        inc('rate_limited');
        return new Response(JSON.stringify({ status: 'error', message: 'Rate limited' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', ...corsHeadersFor(request, env), 'Retry-After': '30' }
        });
      }
    }

    if (parsedBody && parsedBody.action === 'batch' && Array.isArray(parsedBody.requests)) {
      return handleApiBatch(request, env, ctx, requestId, contentType, parsedBody);
    }

    const cacheTtls = getApiCacheTtls(env);
    const cacheMeta = getCacheMetaFromParsed(parsedBody) || await tryGetCacheMeta(body);
    if (cacheMeta && cacheMeta.action) mapIncLimited(_topApiActions, cacheMeta.action, 80);
    const ttl = cacheMeta ? cacheTtls[cacheMeta.action] : 0;
    if (ttl > 0 && request.method === 'POST') {
      const cacheKey = await buildApiCacheKey(request.url, cacheMeta.action, cacheMeta.key);
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const cacheState = getCachedApiState(cached, ttl, env);
        if (cacheState.fresh) {
          inc('api_cache_hit');
          return withMetricHeaders(cacheState.response, { 'x-api-cache': 'HIT' });
        }
      }
      inc('api_cache_miss');
      const staleCandidate = cached ? getCachedApiState(cached, ttl, env) : null;
      const circuit = apiCircuitState();
      if (circuit.is_open) {
        inc('circuit_open');
        if (staleCandidate && staleCandidate.stale) {
          inc('api_stale_served');
          return withMetricHeaders(staleCandidate.response, { 'x-api-cache': 'STALE', 'x-api-circuit': 'OPEN' });
        }
        return new Response(JSON.stringify({ status: 'error', message: 'Circuit breaker open. Upstream temporarily paused.', request_id: requestId }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Api-Contract': 'json-v1',
            'X-Request-Id': String(requestId || ''),
            ...corsHeadersFor(request, env),
            'Retry-After': '30'
          }
        });
      }

      const inflightKey = cacheKey.url;
      if (_inFlightApi.has(inflightKey)) {
        inc('api_deduped');
        return _inFlightApi.get(inflightKey).then(function (res) {
          return withMetricHeaders(res, { 'x-api-dedupe': 'HIT' });
        });
      }

      const networkPromise = (async function () {
        try {
          const upstream = await fetchWithRetry(
            gasUrl,
            { method: 'POST', headers: { 'Content-Type': contentType }, body },
            { maxAttempts: 4, timeoutMs: 25000 }
          );
          const res = await normalizeApiUpstreamResponse(upstream, request, env, requestId);
          if (res.status >= 500) {
            recordApiCircuitFailure('Upstream status ' + res.status, env);
            if (staleCandidate && staleCandidate.stale) {
              inc('api_stale_served');
              return withMetricHeaders(staleCandidate.response, { 'x-api-cache': 'STALE', 'x-api-fallback': 'ERROR' });
            }
          } else {
            recordApiCircuitSuccess();
          }

          if (res.status < 500) {
            const cacheable = buildCacheableApiResponse(res.clone(), ttl);
            if (ctx) ctx.waitUntil(caches.default.put(cacheKey, cacheable));
          }
          return withMetricHeaders(res, { 'x-api-cache': 'MISS' });
        } catch (error) {
          recordApiCircuitFailure(error, env);
          if (staleCandidate && staleCandidate.stale) {
            inc('api_stale_served');
            return withMetricHeaders(staleCandidate.response, { 'x-api-cache': 'STALE', 'x-api-fallback': 'EXCEPTION' });
          }
          throw error;
        } finally {
          _inFlightApi.delete(inflightKey);
        }
      })();

      _inFlightApi.set(inflightKey, networkPromise);
      return networkPromise;
    }

    const circuit = apiCircuitState();
    if (circuit.is_open) {
      inc('circuit_open');
      return new Response(JSON.stringify({ status: 'error', message: 'Circuit breaker open. Upstream temporarily paused.', request_id: requestId }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Api-Contract': 'json-v1',
          'X-Request-Id': String(requestId || ''),
          ...corsHeadersFor(request, env),
          'Retry-After': '30'
        }
      });
    }

    const upstream = await fetchWithRetry(
      gasUrl,
      { method: 'POST', headers: { 'Content-Type': contentType }, body },
      { maxAttempts: 4, timeoutMs: 25000 }
    );

    const normalized = await normalizeApiUpstreamResponse(upstream, request, env, requestId);
    if (normalized.status >= 500) recordApiCircuitFailure('Upstream status ' + normalized.status, env);
    else recordApiCircuitSuccess();
    return normalized;
  } catch (e) {
    recordApiCircuitFailure(e, env);
    return new Response(JSON.stringify({ status: 'error', message: 'Upstream request failed: ' + String(e) }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Api-Contract': 'json-v1',
        ...corsHeadersFor(request, env)
      }
    });
  }
}

async function handleApiBatch(request, env, ctx, requestId, contentType, parsedBody) {
  const items = Array.isArray(parsedBody.requests) ? parsedBody.requests.filter(function (item) {
    return item && typeof item === 'object' && typeof item.action === 'string';
  }).slice(0, 6) : [];

  if (!items.length) {
    return new Response(JSON.stringify({ status: 'error', message: 'Batch request kosong.', request_id: requestId }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Api-Contract': 'json-v1',
        'X-Request-Id': String(requestId || ''),
        ...corsHeadersFor(request, env)
      }
    });
  }

  const gasUrl = env.APP_GAS_URL;
  const allowPartial = !!parsedBody.allow_partial;
  const cacheTtls = getApiCacheTtls(env);

  const results = await Promise.all(items.map(async function (item, index) {
    const action = String(item.action || '');
    mapIncLimited(_topApiActions, 'batch:' + action, 80);
    const cacheMeta = getCacheMetaFromParsed(item);
    const ttl = cacheMeta ? Number(cacheTtls[cacheMeta.action] || 0) : 0;
    const cacheKey = (ttl > 0) ? await buildApiCacheKey(request.url, cacheMeta.action, cacheMeta.key) : null;
    const cached = cacheKey ? await caches.default.match(cacheKey) : null;
    if (cached && ttl > 0) {
      const cacheState = getCachedApiState(cached, ttl, env);
      if (cacheState.fresh) {
        inc('api_cache_hit');
        return {
          index,
          action,
          ok: true,
          status: cacheState.response.status,
          cache: 'HIT',
          data: await cacheState.response.clone().json()
        };
      }
    }

    if (ttl > 0) inc('api_cache_miss');
    const staleCandidate = (cached && ttl > 0) ? getCachedApiState(cached, ttl, env) : null;
    try {
      const upstream = await fetchWithRetry(
        gasUrl,
        { method: 'POST', headers: { 'Content-Type': contentType }, body: JSON.stringify(item) },
        { maxAttempts: 4, timeoutMs: 25000 }
      );
      const normalized = await normalizeApiUpstreamResponse(upstream, request, env, requestId + '_' + index);
      const data = await normalized.clone().json();
      if (normalized.status >= 500) {
        recordApiCircuitFailure('Batch upstream status ' + normalized.status, env);
        if (staleCandidate && staleCandidate.stale) {
          inc('api_stale_served');
          return {
            index,
            action,
            ok: true,
            status: staleCandidate.response.status,
            cache: 'STALE',
            data: await staleCandidate.response.clone().json()
          };
        }
      } else {
        recordApiCircuitSuccess();
      }
      if (ttl > 0 && normalized.status < 500 && cacheKey) {
        const cacheable = buildCacheableApiResponse(normalized.clone(), ttl);
        if (ctx) ctx.waitUntil(caches.default.put(cacheKey, cacheable));
      }
      return { index, action, ok: normalized.ok, status: normalized.status, cache: 'MISS', data };
    } catch (error) {
      recordApiCircuitFailure(error, env);
      if (staleCandidate && staleCandidate.stale) {
        inc('api_stale_served');
        return {
          index,
          action,
          ok: true,
          status: staleCandidate.response.status,
          cache: 'STALE',
          data: await staleCandidate.response.clone().json()
        };
      }
      return { index, action, ok: false, status: 502, data: { status: 'error', message: String(error) } };
    }
  }));

  const failed = results.filter(function (item) { return !item.ok; });
  const statusCode = failed.length && !allowPartial ? 502 : 200;
  return new Response(JSON.stringify({
    status: failed.length && !allowPartial ? 'error' : 'success',
    request_id: requestId,
    results
  }), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Api-Contract': 'json-v1',
      'X-Request-Id': String(requestId || ''),
      ...corsHeadersFor(request, env)
    }
  });
}

async function normalizeApiUpstreamResponse(upstream, request, env, requestId) {
  const cors = corsHeadersFor(request, env);
  const baseHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Api-Contract': 'json-v1',
    'X-Request-Id': String(requestId || ''),
    ...cors
  };

  let txt = '';
  try {
    txt = await upstream.text();
  } catch (e) {
    return new Response(JSON.stringify({
      status: 'error',
      message: 'Failed reading upstream response',
      upstream_status: upstream.status || 502,
      request_id: requestId
    }), { status: 502, headers: baseHeaders });
  }

  let parsed = null;
  try { parsed = JSON.parse(txt); } catch (e) { }

  if (!parsed || typeof parsed !== 'object') {
    const preview = String(txt || '').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').slice(0, 180);
    return new Response(JSON.stringify({
      status: 'error',
      message: 'Invalid upstream JSON response',
      upstream_status: upstream.status || 502,
      request_id: requestId,
      preview
    }), { status: 502, headers: baseHeaders });
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, 'status')) {
    parsed = {
      status: upstream.ok ? 'success' : 'error',
      data: parsed,
      request_id: requestId
    };
  }

  return new Response(JSON.stringify(parsed), {
    status: upstream.status || 200,
    headers: baseHeaders
  });
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function getCacheMetaFromParsed(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const action = String(obj.action || '');
  if (!action || action === 'batch') return null;
  const keyObj = Object.assign({}, obj);
  delete keyObj.rid;
  delete keyObj.ts;
  delete keyObj.nonce;
  return { action, key: keyObj };
}

function getApiStaleWindowSeconds(ttlSeconds, env) {
  const multiplier = Math.max(2, Number(env && env.API_CACHE_STALE_MULTIPLIER || 10));
  const minWindow = Math.max(60, Number(env && env.API_CACHE_STALE_MIN_SECONDS || 300));
  return Math.max(minWindow, ttlSeconds * multiplier);
}

function getCachedApiState(response, ttlSeconds, env) {
  const headers = response && response.headers ? response.headers : null;
  const cachedAt = headers ? Number(headers.get('x-edge-cached-at') || 0) : 0;
  const ageMs = cachedAt ? Math.max(0, Date.now() - cachedAt) : 0;
  const fresh = !cachedAt || ageMs <= (ttlSeconds * 1000);
  const staleWindowMs = getApiStaleWindowSeconds(ttlSeconds, env) * 1000;
  const stale = !!cachedAt && ageMs <= staleWindowMs;
  return { fresh, stale, age_ms: ageMs, response };
}

function buildCacheableApiResponse(response, ttlSeconds) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `public, max-age=0, s-maxage=${ttlSeconds}, stale-while-revalidate=${Math.max(60, ttlSeconds * 5)}`);
  headers.set('x-edge-cached-at', String(Date.now()));
  headers.set('x-edge-cache-ttl', String(ttlSeconds));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function handleHealth(env, ctx) {
  const startedAt = Date.now();
  const gasUrl = env.MOOTA_GAS_URL;
  if (!gasUrl) {
    return new Response(JSON.stringify({ status: 'ok', upstream: 'not_configured' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const cacheKey = new Request('https://local.health/cache', { method: 'GET' });
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
    const res = await fetchWithRetry(gasUrl, { method: 'GET' }, { maxAttempts: 3, timeoutMs: 8000 });
    const ms = Date.now() - startedAt;
    const out = new Response(JSON.stringify({ status: 'ok', upstream: res.ok ? 'ok' : 'degraded', upstream_status: res.status, latency_ms: ms }), {
      status: res.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=0, s-maxage=30' }
    });
    if (ctx) ctx.waitUntil(caches.default.put(cacheKey, out.clone()));
    return out;
  } catch (e) {
    const ms = Date.now() - startedAt;
    return new Response(JSON.stringify({ status: 'error', upstream: 'down', latency_ms: ms, message: String(e) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function calcDelay(attempt) {
  const base = Math.min(8000, 250 * 2 ** (attempt - 1));
  return Math.round(base * (0.6 + Math.random() * 0.8));
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 522 || status === 524;
}

async function fetchWithRetry(url, init, opts) {
  const maxAttempts = Math.max(1, Number(opts?.maxAttempts ?? 3));
  const timeoutMs = Math.max(1, Number(opts?.timeoutMs ?? 25000));
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let controller;
    let timeoutId;
    try {
      const requestInit = init ? { ...init } : {};
      if (!requestInit.signal && typeof AbortController !== 'undefined') {
        controller = new AbortController();
        requestInit.signal = controller.signal;
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      }
      const res = await fetch(url, requestInit);
      if (timeoutId) clearTimeout(timeoutId);
      if ((!res.ok) && isRetryableStatus(res.status) && attempt < maxAttempts) {
        await sleep(calcDelay(attempt));
        continue;
      }
      return res;
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId);
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(calcDelay(attempt));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error('fetch failed');
}

function isCacheableAssetPath(pathname) {
  const p = (pathname || '').toLowerCase();
  if (!p) return false;
  if (p === '/' || p.endsWith('.html')) return false;
  return (
    p.endsWith('.css') ||
    p.endsWith('.js') ||
    p.endsWith('.mjs') ||
    p.endsWith('.json') ||
    p.endsWith('.svg') ||
    p.endsWith('.png') ||
    p.endsWith('.jpg') ||
    p.endsWith('.jpeg') ||
    p.endsWith('.webp') ||
    p.endsWith('.ico') ||
    p.endsWith('.woff2') ||
    p.endsWith('.woff') ||
    p.endsWith('.ttf')
  );
}

function resolveAssetCacheControl(pathname) {
  const p = String(pathname || '').toLowerCase();
  if (!p || p === '/' || p.endsWith('.html')) {
    return 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
  }
  if (p.endsWith('/site.config.js') || p === '/site.config.js') {
    return 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400';
  }
  if (p.endsWith('/config.js') || p === '/config.js') {
    return 'public, max-age=86400, s-maxage=86400, immutable';
  }
  if (isCacheableAssetPath(p)) {
    return 'public, max-age=31536000, s-maxage=31536000, immutable';
  }
  return 'public, max-age=300, s-maxage=300';
}

function withStaticCacheHeaders(response, pathname) {
  try {
    const headers = new Headers(response.headers);
    const cacheControl = resolveAssetCacheControl(pathname);
    if (cacheControl) headers.set('Cache-Control', cacheControl);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (e) {
    return response;
  }
}

function withMetricHeaders(response, extra) {
  try {
    const headers = new Headers(response.headers);
    if (extra) {
      Object.keys(extra).forEach(k => {
        headers.set(k, extra[k]);
      });
    }
    headers.set('x-worker', 'pages-advanced');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (e) {
    return response;
  }
}

async function tryGetCacheMeta(bodyText) {
  if (!bodyText) return null;
  const t = String(bodyText).trim();
  if (!t || t[0] !== '{') return null;
  try {
    const obj = JSON.parse(t);
    const action = String(obj?.action || '');
    if (!action) return null;
    const keyObj = Object.assign({}, obj);
    delete keyObj.rid;
    delete keyObj.ts;
    delete keyObj.nonce;
    return { action, key: keyObj };
  } catch (e) {
    return null;
  }
}

function getApiCacheTtls(env) {
  const defaults = {
    get_public_cache_state: 5,
    get_global_settings: 300,
    get_products: 60,
    get_product: 60,
    get_page_content: 60,
    get_pages: 120
  };
  try {
    const raw = env.API_CACHE_TTLS_JSON;
    if (!raw) return defaults;
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object') return defaults;
    return { ...defaults, ...parsed };
  } catch (e) {
    return defaults;
  }
}

async function buildApiCacheKey(requestUrl, action, keyObj) {
  const u = new URL(requestUrl);
  const payload = JSON.stringify(keyObj || {});
  const hash = await sha256Base64Url(payload);
  u.searchParams.set('a', String(action || ''));
  u.searchParams.set('k', hash);
  return new Request(u.toString(), { method: 'GET' });
}

async function sha256Base64Url(text) {
  const data = new TextEncoder().encode(String(text || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function normalizeMootaSignature(value) {
  let normalized = String(value || '').trim();
  if (!normalized) return '';
  normalized = normalized.replace(/^sha256=/i, '').trim();
  return normalized.replace(/[^a-f0-9]/ig, '').toLowerCase();
}

function maskMootaSignature(value) {
  const sig = String(value || '');
  if (!sig) return '';
  if (sig.length <= 12) return sig;
  return sig.slice(0, 8) + '...' + sig.slice(-4);
}

async function computeMootaHmacHex(text, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(String(text || '')));
  const bytes = new Uint8Array(signed);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function verifyMootaSignature(text, secret, rawSignature) {
  const normalizedSecret = String(secret || '').trim();
  const received = normalizeMootaSignature(rawSignature);
  if (!normalizedSecret) {
    return { ok: false, code: 'missing_secret', received, expected: '' };
  }
  if (!received) {
    return { ok: false, code: 'missing_signature', received: '', expected: '' };
  }
  const expected = await computeMootaHmacHex(text, normalizedSecret);
  return {
    ok: received === expected,
    code: received === expected ? 'ok' : 'invalid_signature',
    received,
    expected
  };
}

function maybeCompress(request, response) {
  // Let Cloudflare negotiate gzip/brotli at the edge.
  // Manual gzip here caused double-compressed HTML/CSS/JS in production.
  return response;
}

const _rl = new Map();
function softRateLimitOk(request, rpm) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const now = Date.now();
    const windowMs = 60000;
    const entry = _rl.get(ip) || { resetAt: now + windowMs, count: 0 };
    if (now > entry.resetAt) {
      entry.resetAt = now + windowMs;
      entry.count = 0;
    }
    entry.count++;
    _rl.set(ip, entry);
    return entry.count <= rpm;
  } catch (e) {
    return true;
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function createWebhookRequestId(request) {
  return request.headers.get('CF-Ray')
    || request.headers.get('X-Request-ID')
    || request.headers.get('X-Correlation-ID')
    || crypto.randomUUID();
}

function pickForwardHeader(request, name, maxLen = 1024) {
  const value = request.headers.get(name);
  if (!value) return '';
  const normalized = String(value).trim();
  if (!normalized) return '';
  return normalized.length > maxLen ? normalized.slice(0, maxLen) : normalized;
}

function buildMootaForwardHeaders(request, requestId) {
  const headers = new Headers();
  headers.set('Content-Type', pickForwardHeader(request, 'Content-Type', 128) || 'application/json');
  headers.set('X-Webhook-Request-ID', requestId);
  headers.set('X-Webhook-Source', 'moota');

  const passthroughHeaders = [
    'Signature',
    'X-Signature',
    'X-MOOTA-SIGNATURE',
    'X-MOOTA-USER',
    'X-MOOTA-WEBHOOK',
    'User-Agent',
    'CF-Connecting-IP',
    'X-Forwarded-For',
    'X-Forwarded-Proto',
    'CF-Ray'
  ];

  for (const name of passthroughHeaders) {
    const value = pickForwardHeader(request, name);
    if (value) headers.set(name, value);
  }

  const cfIp = headers.get('CF-Connecting-IP');
  if (cfIp && !headers.get('X-Forwarded-For')) {
    headers.set('X-Forwarded-For', cfIp);
  }

  return headers;
}

async function handleWebhook(request, gasUrl, secretToken) {
  const requestId = createWebhookRequestId(request);
  if (!gasUrl) {
    return jsonResponse({
      status: 'error',
      message: 'Missing environment variable MOOTA_GAS_URL',
      request_id: requestId
    }, 500);
  }

  try {
    const signature = request.headers.get('Signature')
      || request.headers.get('X-Signature')
      || request.headers.get('X-MOOTA-SIGNATURE')
      || '';
    const mootaUser = request.headers.get('X-MOOTA-USER') || '';
    const mootaWebhook = request.headers.get('X-MOOTA-WEBHOOK') || '';
    const userAgent = request.headers.get('User-Agent') || '';
    const body = await request.text();
    console.log('[moota-webhook] Incoming webhook', {
      request_id: requestId,
      body_bytes: body.length,
      has_signature: !!signature,
      has_x_moota_user: !!mootaUser,
      has_x_moota_webhook: !!mootaWebhook
    });

    if (!signature) {
      console.warn('[moota-webhook] Missing signature header', {
        request_id: requestId,
        has_x_moota_user: !!mootaUser,
        has_x_moota_webhook: !!mootaWebhook,
        user_agent: userAgent,
        worker_has_secret_token: !!String(secretToken || '').trim()
      });
      return jsonResponse({
        status: 'error',
        message: 'Missing Signature header from Moota webhook',
        request_id: requestId,
        diagnostics: {
          has_x_moota_user: !!mootaUser,
          has_x_moota_webhook: !!mootaWebhook,
          user_agent: userAgent || '',
          worker_has_secret_token: !!String(secretToken || '').trim()
        }
      }, 400);
    }

    let workerVerification = {
      ok: false,
      code: 'worker_secret_not_configured',
      received: normalizeMootaSignature(signature),
      expected: ''
    };

    if (String(secretToken || '').trim()) {
      workerVerification = await verifyMootaSignature(body, secretToken, signature);
      if (!workerVerification.ok) {
        console.warn('[moota-webhook] Invalid signature at worker', {
          request_id: requestId,
          validation_code: workerVerification.code,
          received_signature: maskMootaSignature(workerVerification.received),
          expected_signature: maskMootaSignature(workerVerification.expected),
          has_x_moota_user: !!mootaUser,
          has_x_moota_webhook: !!mootaWebhook
        });
        return jsonResponse({
          status: 'error',
          message: 'Invalid Signature at Worker. Secret Token di Worker tidak cocok dengan Signature dari Moota.',
          request_id: requestId,
          diagnostics: {
            validation_code: workerVerification.code,
            received_signature: maskMootaSignature(workerVerification.received),
            expected_signature: maskMootaSignature(workerVerification.expected),
            has_x_moota_user: !!mootaUser,
            has_x_moota_webhook: !!mootaWebhook
          }
        }, 401);
      }
    } else {
      console.warn('[moota-webhook] MOOTA_TOKEN is not configured in Worker; skipping Worker-level signature verification', {
        request_id: requestId
      });
    }

    const targetUrl = new URL(gasUrl);
    targetUrl.searchParams.append('moota_forwarded', '1');
    targetUrl.searchParams.append('moota_sig_present', '1');
    targetUrl.searchParams.append('moota_signature', signature);
    targetUrl.searchParams.append('moota_sig_verified', workerVerification.ok ? '1' : '0');
    targetUrl.searchParams.append('moota_sig_verified_by', workerVerification.ok ? 'worker' : workerVerification.code);
    targetUrl.searchParams.append('moota_request_id', requestId);
    if (mootaUser) targetUrl.searchParams.append('moota_user', mootaUser);
    if (mootaWebhook) targetUrl.searchParams.append('moota_webhook', mootaWebhook);
    if (userAgent) targetUrl.searchParams.append('moota_user_agent', userAgent.substring(0, 120));

    const forwardHeaders = buildMootaForwardHeaders(request, requestId);

    let response;
    try {
      response = await fetchWithRetry(targetUrl.toString(), {
        method: 'POST',
        headers: forwardHeaders,
        body
      }, { maxAttempts: 4, timeoutMs: 25000 });
    } catch (err) {
      console.error('[moota-webhook] Upstream GAS unreachable', {
        request_id: requestId,
        error: String(err)
      });
      return jsonResponse({
        status: 'error',
        message: 'GAS unreachable after retries: ' + String(err),
        request_id: requestId
      }, 502);
    }

    const resultText = await response.text();
    let resultJson = null;
    try {
      resultJson = resultText ? JSON.parse(resultText) : null;
    } catch (parseError) {
      resultJson = null;
    }

    if (resultJson && typeof resultJson === 'object') {
      if (!Object.prototype.hasOwnProperty.call(resultJson, 'request_id')) {
        resultJson.request_id = requestId;
      }
      if (!Object.prototype.hasOwnProperty.call(resultJson, 'worker_forwarded')) {
        resultJson.worker_forwarded = true;
      }
      return jsonResponse(resultJson, response.status);
    }

    return jsonResponse({
      status: response.ok ? 'success' : 'error',
      message: response.ok ? 'Webhook forwarded successfully.' : 'Webhook forwarding failed at upstream.',
      request_id: requestId,
      upstream_status: response.status,
      upstream_body_preview: String(resultText || '').slice(0, 500)
    }, response.status);
  } catch (error) {
    console.error('[moota-webhook] Unhandled worker error', {
      request_id: requestId,
      error: String(error)
    });
    return jsonResponse({
      status: 'error',
      message: String(error),
      request_id: requestId
    }, 500);
  }
}
