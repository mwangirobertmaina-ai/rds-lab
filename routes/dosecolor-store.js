'use strict';
// ============================================================================
// routes/dosecolor-store.js — pluggable persistence for DoseColor / pharmacy
//
// Two drivers behind one async interface, chosen at boot:
//   * FILE  (default)  — the original single JSON snapshot. No dependencies.
//                        Used whenever DATABASE_URL is not set, so existing
//                        deployments keep working exactly as before.
//   * POSTGRES         — one row per record (facilities, staff, products,
//                        suppliers, orders, labels, purchase orders) plus a
//                        small key/value table for bounded singletons. Writes
//                        are per-record diffs, not a whole-file rewrite, so the
//                        store scales to a large, growing number of chemists
//                        and can be shared by several server instances.
//                        Needs the `pg` package (installed on the server only).
//
// Interface: createStore(opts) -> { kind, init?(), loadAll(), flush(S), close?() }
//   loadAll() -> a snapshot object (same shape print.js keeps in memory) or null
//   flush(S)  -> persists the current in-memory snapshot durably
// ============================================================================
const fs = require('fs');
const crypto = require('crypto');

// record collections kept one-row-per-record
const ROW_MAPS = ['facilities', 'staff', 'products', 'suppliers'];     // maps keyed by id
const ROW_ARRAYS = ['orders', 'labels', 'purchaseOrders'];             // arrays keyed by record.id
// small bounded singletons kept as one JSON document each
const KV = ['sessions', 'agents', 'seq', 'oseq', 'pseq', 'meta'];

const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v) || '').digest('hex');

// ----------------------------------------------------------------------------
// FILE driver: identical behaviour to the previous dosecolor.snapshot file
// ----------------------------------------------------------------------------
function fileDriver(file) {
    return {
        kind: 'file',
        async loadAll() {
            try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
            catch (e) { if (e.code !== 'ENOENT') console.error('[DOSECOLOR] could not read snapshot:', e.message); return null; }
        },
        async flush(S) {
            if (!file) return;
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(S));
            fs.renameSync(tmp, file);
        },
        async close() {}
    };
}

// ----------------------------------------------------------------------------
// POSTGRES driver
//   dc_record(coll, id, doc jsonb)  PK(coll,id)   — one row per record
//   dc_kv(k, doc jsonb)             PK(k)         — bounded singletons
// Order / label / purchase-order rows are append-or-update only (never deleted
// here), so trimming the in-memory working set never loses persisted history.
// ----------------------------------------------------------------------------
function pgDriver(pool) {
    const q = (sql, params) => pool.query(sql, params);
    const shadow = { row: new Map(), kv: new Map() };   // key -> last persisted hash
    return {
        kind: 'postgres',
        async init() {
            await q('CREATE TABLE IF NOT EXISTS dc_record (coll text NOT NULL, id text NOT NULL, doc jsonb NOT NULL, updated_at timestamptz DEFAULT now(), PRIMARY KEY (coll, id))', []);
            await q('CREATE TABLE IF NOT EXISTS dc_kv (k text PRIMARY KEY, doc jsonb NOT NULL, updated_at timestamptz DEFAULT now())', []);
            await q('CREATE INDEX IF NOT EXISTS dc_record_coll_idx ON dc_record (coll)', []);
        },
        async loadAll() {
            const S = { v: 1, facilities: {}, staff: {}, sessions: {}, agents: {}, labels: [], seq: {}, products: {}, orders: [], oseq: {}, suppliers: {}, purchaseOrders: [], pseq: {} };
            const rec = await q('SELECT coll, id, doc FROM dc_record', []);
            for (const r of rec.rows) {
                const doc = typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc;
                if (ROW_MAPS.includes(r.coll)) S[r.coll][r.id] = doc;
                else if (ROW_ARRAYS.includes(r.coll)) S[r.coll].push(doc);
                shadow.row.set(r.coll + '\u0000' + r.id, hash(doc));
            }
            const kv = await q('SELECT k, doc FROM dc_kv', []);
            for (const r of kv.rows) {
                const doc = typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc;
                S[r.k] = doc; shadow.kv.set(r.k, hash(doc));
            }
            return S;
        },
        async flush(S) {
            // per-record upsert for every row collection; delete only from the
            // id-keyed maps (staff can be removed). Arrays are never deleted here.
            for (const coll of ROW_MAPS.concat(ROW_ARRAYS)) {
                const isMap = ROW_MAPS.includes(coll);
                const recs = isMap ? Object.values(S[coll] || {}) : (S[coll] || []);
                const seen = new Set();
                for (const rec of recs) {
                    if (!rec || rec.id == null) continue;
                    const id = String(rec.id); seen.add(id);
                    const key = coll + '\u0000' + id, h = hash(rec);
                    if (shadow.row.get(key) !== h) {
                        await q('INSERT INTO dc_record (coll, id, doc, updated_at) VALUES ($1,$2,$3::jsonb, now()) ON CONFLICT (coll, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()', [coll, id, JSON.stringify(rec)]);
                        shadow.row.set(key, h);
                    }
                }
                if (isMap) {
                    for (const key of Array.from(shadow.row.keys())) {
                        if (!key.startsWith(coll + '\u0000')) continue;
                        const id = key.slice(coll.length + 1);
                        if (!seen.has(id)) { await q('DELETE FROM dc_record WHERE coll=$1 AND id=$2', [coll, id]); shadow.row.delete(key); }
                    }
                }
            }
            for (const k of KV) {
                const doc = S[k]; if (doc === undefined) continue;
                const h = hash(doc);
                if (shadow.kv.get(k) !== h) {
                    await q('INSERT INTO dc_kv (k, doc, updated_at) VALUES ($1,$2::jsonb, now()) ON CONFLICT (k) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()', [k, JSON.stringify(doc)]);
                    shadow.kv.set(k, h);
                }
            }
        },
        async close() { try { if (pool.end) await pool.end(); } catch (e) {} }
    };
}

// ----------------------------------------------------------------------------
function createStore(opts) {
    opts = opts || {};
    const url = opts.databaseUrl;
    if (url || opts.injectPool) {
        let pool = opts.injectPool;
        if (!pool) {
            const pg = require('pg');       // lazy: only loaded when a database is configured
            const ssl = (opts.pgSsl || /render\.com|amazonaws\.com|heroku|neon\.tech|supabase/.test(String(url))) ? { rejectUnauthorized: false } : undefined;
            pool = new pg.Pool({ connectionString: url, max: opts.pgMax || 10, ssl });
        }
        return pgDriver(pool);
    }
    return fileDriver(opts.file);
}

module.exports = { createStore, fileDriver, pgDriver, ROW_MAPS, ROW_ARRAYS, KV };