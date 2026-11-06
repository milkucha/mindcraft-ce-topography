/**
 * Per-agent memory store (bots/<agent>/memory.db).
 *
 * MUTABILITY CLASSES (the contract every backend upholds):
 *  - events:        append-only raw record (heard|observed|said|did|unknown). Never updated or deleted.
 *  - claims:        never deleted and their content never changes; a newer claim SUPERSEDES an older one
 *                   (superseded_by / valid_to). Conflicting claims are all kept with provenance.
 *  - observations:  append-only snapshots. A new visit adds a new observation; old ones are not mutated.
 *  - places/people: entity rows with derived, rebuildable cache columns (name, centre, bbox, merged_into).
 *  - links:         link candidates (told place <-> observed place). status moves candidate->confirmed|rejected
 *                   only by a deliberate act (command) or an observation that clearly contains the told point.
 *  - core text:     (history.memory, outside this store) is sticky and revisable; it is NOT the record.
 * Beliefs and summaries are derived from these tables and can be rebuilt at any time.
 *
 * Backends: SqliteStore (node:sqlite, FTS5 when available) and JsonlStore (append-only JSONL log with an
 * in-memory index). Both implement the same interface; openStore() picks one.
 */
import { mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tokenize } from './util.js';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
export const sqliteAvailable = () => sqlite !== null && typeof sqlite.DatabaseSync === 'function';

export const SCHEMA_VERSION = 2;

const TABLES = {
    places: { pk: 'id', cols: ['id', 'name', 'kind', 'cx', 'cz', 'radius', 'bbox', 'first_seen', 'merged_into'], json: ['bbox'] },
    claims: { pk: 'id', cols: ['id', 'subject_type', 'subject_id', 'predicate', 'value', 'source_kind', 'source_name', 'ts', 'day', 'valid_to', 'superseded_by', 'event_id', 'derived_from'], json: ['value'] },
    observations: { pk: 'id', cols: ['id', 'place_id', 'ts', 'day', 'pos', 'digest'], json: ['pos', 'digest'] },
    people: { pk: 'name', cols: ['name', 'display', 'summary', 'first_seen', 'last_seen'], json: [] },
    links: { pk: 'id', cols: ['id', 'told_place', 'observed_place', 'claim_id', 'distance', 'confidence', 'status', 'ts'], json: [] },
};
const EVENT_COLS = ['id', 'ts', 'day', 'kind', 'speaker', 'text', 'pos'];

const MIGRATIONS = [
    {
        version: 1,
        sql: `
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day INTEGER, kind TEXT NOT NULL, speaker TEXT, text TEXT NOT NULL, pos TEXT);
CREATE INDEX events_speaker ON events(speaker, id);
CREATE TABLE places (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT, cx REAL, cz REAL, radius REAL, bbox TEXT, first_seen INTEGER, merged_into INTEGER);
CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, predicate TEXT NOT NULL, value TEXT, source_kind TEXT NOT NULL, source_name TEXT, ts INTEGER NOT NULL, day INTEGER, valid_to INTEGER, superseded_by INTEGER, event_id INTEGER REFERENCES events(id), derived_from INTEGER REFERENCES events(id));
CREATE INDEX claims_subject ON claims(subject_type, subject_id);
CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, place_id INTEGER NOT NULL, ts INTEGER NOT NULL, day INTEGER, pos TEXT, digest TEXT);
CREATE INDEX observations_place ON observations(place_id, ts);
CREATE TABLE people (name TEXT PRIMARY KEY, display TEXT, summary TEXT, first_seen INTEGER, last_seen INTEGER);
CREATE TABLE links (id INTEGER PRIMARY KEY AUTOINCREMENT, told_place INTEGER NOT NULL, observed_place INTEGER NOT NULL, claim_id INTEGER, distance REAL, confidence REAL, status TEXT NOT NULL DEFAULT 'candidate', ts INTEGER);
-- append-only guards
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT, 'observations are append-only'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT, 'observations are append-only'); END;
CREATE TRIGGER claims_no_delete BEFORE DELETE ON claims BEGIN SELECT RAISE(ABORT, 'claims are superseded, never deleted'); END;
CREATE TRIGGER claims_immutable BEFORE UPDATE OF subject_type, subject_id, predicate, value, source_kind, source_name, ts, day, event_id, derived_from ON claims BEGIN SELECT RAISE(ABORT, 'claim content is immutable; supersede instead'); END;
`,
    },
    {
        version: 2,
        // Full-text index over event text and names/descriptions. FTS5 when present, else a plain table.
        run(db, hasFts5) {
            if (hasFts5) db.exec(`CREATE VIRTUAL TABLE fts USING fts5(text, kind UNINDEXED, ref UNINDEXED, tokenize='unicode61 remove_diacritics 2')`);
            else db.exec(`CREATE TABLE fts (text TEXT, kind TEXT, ref INTEGER)`);
            const ins = db.prepare('INSERT INTO fts(text, kind, ref) VALUES (?, ?, ?)');
            for (const r of db.prepare('SELECT id, text FROM events').all()) ins.run(r.text, 'event', r.id);
            for (const r of db.prepare("SELECT id, subject_id, predicate, value FROM claims WHERE predicate IN ('name','description','attribute')").all()) {
                let v = r.value; try { v = JSON.parse(r.value); } catch { /* keep raw */ }
                ins.run(`${r.subject_id} ${typeof v === 'string' ? v : JSON.stringify(v)}`, 'claim', r.id);
            }
        },
    },
];

const parse = (s) => { if (s === null || s === undefined) return null; try { return JSON.parse(s); } catch { return null; } };

class BaseStore {
    constructor() {
        this.backend = 'base';
        this.t = { places: new Map(), claims: new Map(), observations: new Map(), people: new Map(), links: new Map() };
        this.seq = { places: 0, claims: 0, observations: 0, links: 0 };
        this.closed = false;
    }

    // ---- backend hooks ----
    _insert(/* table, row */) { throw new Error('abstract'); }
    _update(/* table, key, patch */) { throw new Error('abstract'); }
    _eventInsert(/* row */) { throw new Error('abstract'); }
    _ftsAdd(/* kind, ref, text */) { throw new Error('abstract'); }

    _ins(table, row) {
        const spec = TABLES[table];
        if (spec.pk === 'id') { row.id = ++this.seq[table]; }
        for (const c of spec.cols) if (row[c] === undefined) row[c] = null;
        this._insert(table, row);
        this.t[table].set(row[spec.pk], row);
        return row;
    }
    _upd(table, key, patch) {
        const row = this.t[table].get(key);
        if (!row) return null;
        Object.assign(row, patch);
        this._update(table, key, patch);
        return row;
    }
    _hydrate(table, rows) {
        const spec = TABLES[table];
        for (const r of rows) {
            for (const j of spec.json) if (typeof r[j] === 'string') r[j] = parse(r[j]);
            this.t[table].set(r[spec.pk], r);
            if (spec.pk === 'id' && r.id > this.seq[table]) this.seq[table] = r.id;
        }
    }

    // ---- events ----
    appendEvent({ ts = Date.now(), day = null, kind, speaker = null, text, pos = null }) {
        if (!kind || !text) throw new Error('event needs kind and text');
        const row = { ts, day, kind, speaker, text: String(text), pos };
        row.id = this._eventInsert(row);
        this._ftsAdd('event', row.id, row.text);
        return row.id;
    }

    // ---- places ----
    createPlace({ name = null, kind = 'place', cx = null, cz = null, radius = null, bbox = null, ts = Date.now() }) {
        const row = this._ins('places', { name, kind, cx, cz, radius, bbox, first_seen: ts, merged_into: null });
        if (name) this._ftsAdd('place', row.id, name);
        return row.id;
    }
    getPlace(id) { return this.t.places.get(Number(id)) ?? null; }
    /** Follow merged_into to the surviving place id. */
    resolvePlace(id) {
        let p = this.getPlace(id), guard = 0;
        while (p && p.merged_into && guard++ < 50) p = this.getPlace(p.merged_into);
        return p ? p.id : null;
    }
    /** ids of a place and every place merged (transitively) into it. */
    placeGroup(id) {
        const out = [Number(id)];
        for (let i = 0; i < out.length; i++)
            for (const p of this.t.places.values()) if (p.merged_into === out[i] && !out.includes(p.id)) out.push(p.id);
        return out;
    }
    listPlaces({ includeMerged = false } = {}) {
        const all = [...this.t.places.values()];
        return includeMerged ? all : all.filter(p => !p.merged_into);
    }
    updatePlace(id, patch) {
        const allowed = {};
        for (const k of ['name', 'kind', 'cx', 'cz', 'radius', 'bbox', 'merged_into']) if (k in patch) allowed[k] = patch[k];
        if ('name' in allowed && allowed.name) this._ftsAdd('place', Number(id), allowed.name);
        return this._upd('places', Number(id), allowed);
    }
    findPlacesByName(name) {
        const n = String(name ?? '').trim().toLowerCase();
        if (!n) return [];
        const live = this.listPlaces().filter(p => p.name);
        const exact = live.filter(p => p.name.toLowerCase() === n);
        if (exact.length) return exact;
        return live.filter(p => p.name.toLowerCase().includes(n) || (n.length > 3 && n.includes(p.name.toLowerCase())));
    }
    placeNames() {
        const out = [];
        for (const p of this.listPlaces()) if (p.name) out.push({ id: p.id, name: p.name });
        return out;
    }

    // ---- claims ----
    addClaim({ subject_type, subject_id, predicate, value, source_kind, source_name = null, ts = Date.now(), day = null, event_id = null, derived_from = null }) {
        if (!['place', 'person', 'general'].includes(subject_type)) throw new Error('bad subject_type');
        if (!['observed', 'told', 'inferred'].includes(source_kind)) throw new Error('bad source_kind');
        const row = this._ins('claims', {
            subject_type, subject_id: String(subject_id), predicate, value, source_kind, source_name, ts, day,
            valid_to: null, superseded_by: null, event_id, derived_from,
        });
        if (['name', 'description', 'attribute'].includes(predicate))
            this._ftsAdd('claim', row.id, `${row.subject_id} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
        return row.id;
    }
    getClaim(id) { return this.t.claims.get(Number(id)) ?? null; }
    getClaims(subject_type, subject_id, { predicate = null, includeSuperseded = false } = {}) {
        const sid = String(subject_id);
        const out = [];
        for (const c of this.t.claims.values()) {
            if (c.subject_type !== subject_type || c.subject_id !== sid) continue;
            if (predicate && c.predicate !== predicate) continue;
            if (!includeSuperseded && c.superseded_by) continue;
            out.push(c);
        }
        return out;
    }
    supersedeClaim(id, byId, ts = Date.now()) {
        const c = this.getClaim(id);
        if (!c || c.superseded_by) return false;
        this._upd('claims', Number(id), { superseded_by: Number(byId), valid_to: ts });
        return true;
    }

    // ---- observations (append-only snapshots) ----
    addObservation({ place_id, ts = Date.now(), day = null, pos = null, digest = null }) {
        return this._ins('observations', { place_id: Number(place_id), ts, day, pos, digest }).id;
    }
    getObservations(placeIds, limit = 20) {
        const ids = new Set([].concat(placeIds).map(Number));
        const out = [...this.t.observations.values()].filter(o => ids.has(o.place_id));
        out.sort((a, b) => b.ts - a.ts || b.id - a.id);
        return out.slice(0, limit);
    }
    latestObservation(placeIds) { return this.getObservations(placeIds, 1)[0] ?? null; }

    // ---- people ----
    touchPerson(name, ts = Date.now()) {
        const key = String(name).toLowerCase();
        const p = this.t.people.get(key);
        if (!p) { this._ins('people', { name: key, display: String(name), summary: null, first_seen: ts, last_seen: ts }); return; }
        if (ts > (p.last_seen ?? 0)) this._upd('people', key, { last_seen: ts });
    }
    getPerson(name) { return this.t.people.get(String(name).toLowerCase()) ?? null; }
    setPersonSummary(name, summary) {
        this.touchPerson(name);
        this._upd('people', String(name).toLowerCase(), { summary });
    }
    listPeople() { return [...this.t.people.values()]; }

    // ---- link candidates ----
    addLink({ told_place, observed_place, claim_id = null, distance, confidence, ts = Date.now() }) {
        for (const l of this.t.links.values())
            if (l.told_place === told_place && l.observed_place === observed_place && l.claim_id === claim_id) return l.id;
        return this._ins('links', { told_place, observed_place, claim_id, distance, confidence, status: 'candidate', ts }).id;
    }
    getLinks({ placeId = null, status = null } = {}) {
        return [...this.t.links.values()].filter(l =>
            (placeId === null || l.told_place === placeId || l.observed_place === placeId) && (!status || l.status === status));
    }
    setLinkStatus(id, status) { return this._upd('links', Number(id), { status }); }

    // ---- search ----
    _ftsSearch(/* tokens, limit */) { throw new Error('abstract'); }
    /** Ranked full-text hits: [{kind:'event'|'claim'|'place', ref, text}] */
    search(query, limit = 10) {
        const tokens = tokenize(query);
        if (!tokens.length) return [];
        return this._ftsSearch(tokens, limit);
    }
    getEvent(/* id */) { throw new Error('abstract'); }
    recentEvents(/* n, kind */) { throw new Error('abstract'); }
    eventsBySpeaker(/* name, n */) { throw new Error('abstract'); }
    countEvents() { throw new Error('abstract'); }
    close() { this.closed = true; }
}

export class SqliteStore extends BaseStore {
    constructor(path, { targetVersion = SCHEMA_VERSION } = {}) {
        super();
        this.backend = 'sqlite';
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
        this.db = new sqlite.DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
        this.hasFts5 = true;
        this._migrate(targetVersion);
        this.version = this.db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
        if (this.version >= 2) {
            try { this.db.prepare("SELECT 1 FROM fts WHERE fts MATCH 'x' LIMIT 1").get(); } catch { this.hasFts5 = false; }
        }
        for (const table of Object.keys(TABLES)) this._hydrate(table, this.db.prepare(`SELECT * FROM ${table}`).all());
        this._stmts = {};
        this._eventStmt = this.db.prepare('INSERT INTO events(ts, day, kind, speaker, text, pos) VALUES (?,?,?,?,?,?)');
        this._ftsStmt = this.version >= 2 ? this.db.prepare('INSERT INTO fts(text, kind, ref) VALUES (?,?,?)') : null;
    }
    _migrate(target) {
        this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER)');
        const done = new Set(this.db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
        let hasFts5 = true;
        try { this.db.exec('CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(a)'); this.db.exec('DROP TABLE temp.__fts_probe'); } catch { hasFts5 = false; }
        this.hasFts5 = hasFts5;
        for (const m of MIGRATIONS) {
            if (m.version > target || done.has(m.version)) continue;
            this.db.exec('BEGIN');
            try {
                if (m.sql) this.db.exec(m.sql);
                if (m.run) m.run(this.db, hasFts5);
                this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
                this.db.exec('COMMIT');
            } catch (e) { this.db.exec('ROLLBACK'); throw e; }
        }
    }
    _ser(spec, row) { return spec.cols.map(c => (spec.json.includes(c) ? (row[c] === null ? null : JSON.stringify(row[c])) : row[c])); }
    _insert(table, row) {
        const spec = TABLES[table];
        const sql = `INSERT INTO ${table}(${spec.cols.join(',')}) VALUES (${spec.cols.map(() => '?').join(',')})`;
        this.db.prepare(sql).run(...this._ser(spec, row));
    }
    _update(table, key, patch) {
        const spec = TABLES[table];
        const cols = Object.keys(patch);
        if (!cols.length) return;
        const vals = cols.map(c => (spec.json.includes(c) && patch[c] !== null ? JSON.stringify(patch[c]) : patch[c]));
        this.db.prepare(`UPDATE ${table} SET ${cols.map(c => `${c}=?`).join(',')} WHERE ${spec.pk}=?`).run(...vals, key);
    }
    _eventInsert(r) {
        return Number(this._eventStmt.run(r.ts, r.day, r.kind, r.speaker, r.text, r.pos ? JSON.stringify(r.pos) : null).lastInsertRowid);
    }
    _ftsAdd(kind, ref, text) { if (this._ftsStmt) this._ftsStmt.run(String(text), kind, ref); }
    /** Bulk append inside one transaction (used by imports and the scale test). */
    appendEvents(list) {
        this.db.exec('BEGIN');
        try { for (const e of list) this.appendEvent(e); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    _ftsSearch(tokens, limit) {
        if (!this._ftsStmt) return [];
        if (this.hasFts5) {
            const q = tokens.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
            return this.db.prepare('SELECT kind, ref, text FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?').all(q, limit);
        }
        const where = tokens.map(() => 'text LIKE ?').join(' OR ');
        return this.db.prepare(`SELECT kind, ref, text FROM fts WHERE ${where} ORDER BY rowid DESC LIMIT ?`).all(...tokens.map(t => `%${t}%`), limit);
    }
    _ev(r) { if (r) r.pos = parse(r.pos); return r; }
    getEvent(id) { return this._ev(this.db.prepare('SELECT * FROM events WHERE id=?').get(id)) ?? null; }
    recentEvents(n = 20, kind = null) {
        const rows = kind
            ? this.db.prepare('SELECT * FROM events WHERE kind=? ORDER BY id DESC LIMIT ?').all(kind, n)
            : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(n);
        return rows.map(r => this._ev(r));
    }
    eventsBySpeaker(name, n = 10) {
        return this.db.prepare('SELECT * FROM events WHERE speaker = ? COLLATE NOCASE ORDER BY id DESC LIMIT ?').all(name, n).map(r => this._ev(r));
    }
    countEvents() { return this.db.prepare('SELECT COUNT(*) c FROM events').get().c; }
    close() { if (!this.closed) { try { this.db.close(); } catch { /* ignore */ } } super.close(); }
}

export class JsonlStore extends BaseStore {
    constructor(path) {
        super();
        this.backend = 'jsonl';
        this.path = path;
        this.version = SCHEMA_VERSION;
        this.events = [];
        this.docs = [];
        this.index = new Map();
        this.loading = true;
        if (path && existsSync(path)) this._replay(readFileSync(path, 'utf8'));
        else if (path) mkdirSync(dirname(path), { recursive: true });
        this.loading = false;
    }
    _replay(text) {
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let rec; try { rec = JSON.parse(line); } catch { continue; } // tolerate a torn last line
            if (rec.t === 'ev') { this.events.push(rec.row); this._index('event', rec.row.id, rec.row.text); }
            else if (rec.t === 'ins') {
                this.t[rec.table].set(rec.row[TABLES[rec.table].pk], rec.row);
                if (rec.row.id > (this.seq[rec.table] ?? 0)) this.seq[rec.table] = rec.row.id;
            } else if (rec.t === 'upd') {
                const r = this.t[rec.table].get(rec.key); if (r) Object.assign(r, rec.patch);
            } else if (rec.t === 'fts') this._index(rec.kind, rec.ref, rec.text);
        }
    }
    _write(rec) { if (this.path && !this.loading) appendFileSync(this.path, JSON.stringify(rec) + '\n'); }
    _insert(table, row) { this._write({ t: 'ins', table, row }); }
    _update(table, key, patch) { this._write({ t: 'upd', table, key, patch }); }
    _eventInsert(row) {
        row.id = this.events.length + 1;
        this.events.push(row);
        this._write({ t: 'ev', row });
        return row.id;
    }
    _index(kind, ref, text) {
        const i = this.docs.push({ kind, ref, text }) - 1;
        for (const t of new Set(tokenize(text))) {
            let a = this.index.get(t); if (!a) this.index.set(t, a = []);
            a.push(i);
        }
    }
    _ftsAdd(kind, ref, text) {
        this._index(kind, ref, String(text));
        if (kind !== 'event') this._write({ t: 'fts', kind, ref, text: String(text) }); // events are re-indexed on replay
    }
    appendEvents(list) { for (const e of list) this.appendEvent(e); }
    _ftsSearch(tokens, limit) {
        const score = new Map();
        for (const t of tokens) {
            const a = this.index.get(t); if (!a) continue;
            const w = 1 / Math.log(2 + a.length);
            for (const i of a) score.set(i, (score.get(i) ?? 0) + w);
        }
        return [...score.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, limit)
            .map(([i]) => this.docs[i]);
    }
    getEvent(id) { return this.events[id - 1] ?? null; }
    recentEvents(n = 20, kind = null) {
        const out = [];
        for (let i = this.events.length - 1; i >= 0 && out.length < n; i--) if (!kind || this.events[i].kind === kind) out.push(this.events[i]);
        return out;
    }
    eventsBySpeaker(name, n = 10) {
        const k = String(name).toLowerCase(), out = [];
        for (let i = this.events.length - 1; i >= 0 && out.length < n; i--) if (String(this.events[i].speaker ?? '').toLowerCase() === k) out.push(this.events[i]);
        return out;
    }
    countEvents() { return this.events.length; }
}

/**
 * Open a store. `path` is the SQLite file (or ':memory:'). backend: 'auto' | 'sqlite' | 'jsonl'.
 * Falls back to JSONL (path with .jsonl extension) when node:sqlite is unavailable or fails.
 */
export function openStore(path, { backend = 'auto', targetVersion } = {}) {
    if (backend !== 'jsonl' && sqliteAvailable()) {
        try { return new SqliteStore(path, { targetVersion }); } catch (e) {
            if (backend === 'sqlite') throw e;
            console.warn(`[memory] sqlite unavailable (${e.message}); using JSONL backend`);
        }
    } else if (backend === 'sqlite') throw new Error('node:sqlite is not available');
    const jp = path === ':memory:' || path === null ? null : path.replace(/\.db$/, '') + '.jsonl';
    return new JsonlStore(jp);
}
