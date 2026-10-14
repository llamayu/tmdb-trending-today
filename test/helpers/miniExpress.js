'use strict';
/**
 * A tiny stand-in for Express 4, used so the route tests can run where `express` isn't installed.
 * It mimics the parts this project relies on: ordered layers, `:param` matching ([^/]+? like path-to-regexp 0.1),
 * req.params / req.query / req.path / req.originalUrl, and res.set/status/type/json/send/redirect.
 * If you have real Express installed, the same routes work with it (that is what server.js uses).
 */

function compile(pattern) {
    const keys = [];
    const source = pattern
        .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
        .replace(/:(\w+)/g, (_, name) => { keys.push(name); return '([^/]+?)'; });
    return { regex: new RegExp(`^${source}/?$`, 'i'), keys };
}

const MIME = { text: 'text/plain; charset=utf-8', png: 'image/png', json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8' };

function createRes() {
    const headers = {};
    const res = {
        statusCode: 200,
        headersSent: false,
        body: undefined,
        headers,
        set(name, value) {
            if (typeof name === 'object') for (const [k, v] of Object.entries(name)) headers[k.toLowerCase()] = String(v);
            else headers[String(name).toLowerCase()] = String(value);
            return res;
        },
        setHeader(name, value) { return res.set(name, value); },
        status(code) { res.statusCode = code; return res; },
        type(t) { headers['content-type'] = MIME[t] || t; return res; },
        json(obj) { res.type('json'); return res.send(JSON.stringify(obj)); },
        send(body) {
            if (typeof body === 'string' && !headers['content-type']) res.type('html');
            res.body = body;
            res.headersSent = true;
            res._done();
            return res;
        },
        redirect(a, b) {
            const [code, url] = b === undefined ? [302, a] : [a, b];
            res.statusCode = code;
            headers.location = url;
            res.headersSent = true;
            res.body = '';
            res._done();
            return res;
        },
    };
    return res;
}

function express() {
    const stack = [];
    const app = {
        settings: {},
        disable(name) { app.settings[name] = false; },
        use(fn) { stack.push({ method: null, regex: null, keys: [], handlers: [fn] }); },
        get(path, ...handlers) { stack.push({ method: 'GET', ...compile(path), handlers }); },
        post(path, ...handlers) { stack.push({ method: 'POST', ...compile(path), handlers }); },

        /** Dispatch a request like a real one would be (GET unless `method` says otherwise). Resolves with { status, headers, body, json() }. */
        request(rawUrl, { method = 'GET', headers = {}, ip = '203.0.113.7' } = {}) {
            return new Promise((resolve, reject) => {
                const url = new URL(rawUrl, 'http://test.local');
                const query = {};
                for (const [k, v] of url.searchParams) query[k] = v;
                const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
                const req = { method, ip, headers: lower, originalUrl: url.pathname + url.search, path: url.pathname, query, params: {} };
                const res = createRes();
                res._done = () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: res.body,
                    json: () => JSON.parse(res.body),
                });

                const handlers = [];
                for (const layer of stack) {
                    if (layer.method === null) { handlers.push({ fn: layer.handlers[0], params: {} }); continue; }
                    if (layer.method !== method) continue;
                    const m = layer.regex.exec(url.pathname);
                    if (!m) continue;
                    const params = {};
                    layer.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
                    for (const fn of layer.handlers) handlers.push({ fn, params });
                }

                let i = 0;
                const next = (err) => {
                    while (i < handlers.length) {
                        const { fn, params } = handlers[i++];
                        const isErrorHandler = fn.length === 4;
                        if (err && !isErrorHandler) continue;
                        if (!err && isErrorHandler) continue;
                        req.params = params;
                        try {
                            const out = err ? fn(err, req, res, next) : fn(req, res, next);
                            if (out && typeof out.catch === 'function') out.catch(next); // Express 5 semantics; wrap() covers Express 4
                        } catch (e) { return next(e); }
                        return;
                    }
                    if (err) return reject(err);
                    res.status(404).type('text').send(`Cannot ${method} ${url.pathname}`);
                };
                next();
            });
        },
    };
    return app;
}

/** Stand-in for stremio-addon-sdk's addonBuilder (same call shape the app uses). */
class addonBuilder {
    constructor(manifest) { this.manifest = manifest; this.handlers = {}; }
    defineCatalogHandler(fn) { this.handlers.catalog = fn; return this; }
    getInterface() {
        const handlers = this.handlers;
        return {
            manifest: Object.freeze({ ...this.manifest }),
            get: (resource, type, id, extra) => {
                const handler = handlers[resource];
                if (!handler) return Promise.reject(new Error(`No handler for ${resource}`));
                return Promise.resolve(handler({ type, id, extra }));
            },
        };
    }
}

module.exports = { express, addonBuilder };
