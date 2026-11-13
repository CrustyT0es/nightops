// Night Ops: talking to the server. post(action, body) sends {action, ...body} as JSON to the API address
// (config.js) and resolves to the answer's JSON when it says ok. Anything else rejects with an ApiError:
// { code, message, status, offline } where offline is true for network failures, timeouts and answers that
// clearly didn't come from Night Ops (a wifi login page). Messages are plain sentences a player can read.

export class ApiError extends Error {
  constructor({ code = 'error', message = 'Something went wrong. Try again.', status = 0, offline = false, fromServer = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.offline = !!offline;
    this.fromServer = !!fromServer; // true when Night Ops itself answered with this error
    this.ok = false;
    // Handy for screens that check `result.error`: an ApiError reads like { ok: false, error: { code, message } }.
    this.error = { code, message };
  }
}

export const WORDS = {
  offline: 'No connection. Check your signal and try again.',
  noNetwork: "You're offline. Night Ops reconnects when you're back online.",
  timeout: 'The server is taking too long. Check your signal and try again.',
  portal: "The internet isn't working on this network (a wifi sign-in page?). Try mobile data.",
  bad_answer: 'The server sent an answer Night Ops could not read. Try again.',
  server: 'The server had a problem. Try again in a moment.',
  busy: 'The server is busy. Try again in a moment.',
  too_big: 'That was too big to send.',
  no_server: "Night Ops can't find its server. Check the address in config.js.",
  error: 'Something went wrong. Try again.',
};

function fallbackFor(status) {
  if (status === 413) return { code: 'too_big', message: WORDS.too_big };
  if (status === 429) return { code: 'busy', message: WORDS.busy };
  if (status >= 500) return { code: 'server', message: WORDS.server };
  return { code: 'error', message: WORDS.error };
}

function cleanMessage(m) {
  if (typeof m !== 'string') return '';
  const s = m.replace(/\s+/g, ' ').trim();
  return s.length > 240 ? `${s.slice(0, 237)}...` : s;
}

// Turn anything thrown into an ApiError.
export function toApiError(e) {
  if (e instanceof ApiError) return e;
  if (e && typeof e === 'object' && e.name === 'ApiError') return new ApiError(e);
  return new ApiError({ code: 'error', message: WORDS.error });
}

// createApi(base, { fetch, key, online })
//   base:   the API address ('/api' in development, the Supabase function URL in production)
//   fetch:  a fetch function (tests pass a fake)
//   key:    optional public key sent as apikey + Authorization (only if config.js has one)
//   online: () => false when the device knows it's offline
export function createApi(base, { fetch: fetchFn, key = '', online } = {}) {
  const doFetch = fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const isOnline = online || (() => globalThis.navigator?.onLine !== false);
  const url = String(base || '/api');

  async function post(action, body = {}, { timeoutMs = 10000, keepalive = false, signal } = {}) {
    if (!doFetch) throw new ApiError({ code: 'offline', message: WORDS.offline, offline: true });
    const payload = JSON.stringify({ ...(body && typeof body === 'object' ? body : {}), action });
    const headers = { 'content-type': 'application/json' };
    if (key) {
      headers.apikey = key;
      headers.authorization = `Bearer ${key}`;
    }

    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (ctrl) ctrl.abort();
    }, Math.max(1, timeoutMs));
    const onAbort = () => ctrl && ctrl.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let res;
    let text;
    // A fetch that ignores the abort signal (or a body that never ends) still times out.
    let backstop = null;
    const timeout = new Promise((_, reject) => {
      backstop = setTimeout(() => reject(new Error('timeout')), Math.max(1, timeoutMs) + 50);
    });
    timeout.catch(() => {});
    try {
      let request;
      try {
        request = Promise.resolve(doFetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: ctrl ? ctrl.signal : undefined,
          cache: 'no-store',
          credentials: 'omit',
          // keepalive requests may not be bigger than 64 KB; only small ones (leave) ask for it.
          keepalive: keepalive && payload.length < 60000,
        }));
      } catch (e) {
        request = Promise.reject(e);
      }
      request.catch(() => {}); // it may fail after the timeout won; nobody is waiting then
      res = await Promise.race([request, timeout]);
      const body = Promise.resolve().then(() => res.text());
      body.catch(() => {});
      text = await Promise.race([body, timeout]);
    } catch (e) {
      if (timedOut || (e && e.message === 'timeout')) {
        throw new ApiError({ code: 'timeout', message: WORDS.timeout, offline: true });
      }
      if (signal && signal.aborted) {
        throw new ApiError({ code: 'aborted', message: 'Stopped.', offline: false });
      }
      throw new ApiError({ code: 'offline', message: isOnline() ? WORDS.offline : WORDS.noNetwork, offline: true });
    } finally {
      clearTimeout(timer);
      clearTimeout(backstop);
      if (signal) signal.removeEventListener?.('abort', onAbort);
    }

    const status = Number(res.status) || 0;
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!json || typeof json !== 'object') {
      // HTML or nothing: a wifi sign-in page, a proxy, or the server falling over.
      if (status >= 200 && status < 400) throw new ApiError({ code: 'portal', message: WORDS.portal, status, offline: true });
      if (status === 502 || status === 503 || status === 504) {
        throw new ApiError({ code: 'server', message: WORDS.server, status, offline: true });
      }
      if (status === 404 || status === 405) {
        // A plain web page answered: the API address is wrong (or the server isn't set up yet).
        throw new ApiError({ code: 'no_server', message: WORDS.no_server, status });
      }
      const f = fallbackFor(status);
      throw new ApiError({ ...f, status });
    }

    if (res.ok && json.ok !== false) return json;

    const err = json.error && typeof json.error === 'object' ? json.error : {};
    const f = fallbackFor(status);
    const code = typeof err.code === 'string' && err.code ? err.code : f.code;
    const message = cleanMessage(err.message) || f.message;
    throw new ApiError({ code, message, status: status || 400, offline: false, fromServer: true });
  }

  return { post, base: url };
}
