/**
 * MemoryManager: the agent-facing facade over the store. Every method is safe to call when the store
 * failed to open (no-ops) and never throws into the agent loop.
 */
import { openStore } from './store.js';
import { cfg, ObservationWatcher } from './observer.js';
import { SeenReporter } from './seen.js';
import { retrieve, placesLine, placeLine, askedAbout, turnText, DEFAULT_RECALL_CHARS, DEFAULT_PLACES_CHARS } from './retrieve.js';
import { recordPlaceClaim, confirmLink, lookupLocation, nearestPlaces } from './ops.js';
import { renderPerson, renderGeneral, placeDisplayName, visitInfo, when } from './beliefs.js';
import { describeTurns, ingestFacts } from './extract.js';
import { clip, dist, direction } from './util.js';

const TRANSIENT = /^(?:SYSTEM:\s*)?(TOPOGRAPHY|SHORELINE|AREA_COMPOSITION|RECALL|CHUNK|\[earlier )/;
export const NEAR_ENOUGH_TO_OBSERVE = 48;

export class MemoryManager {
    static create(agent, { path = null, backend = 'auto' } = {}) {
        let store = null;
        try {
            if (cfg(agent, 'memory_archive', true) !== false)
                store = openStore(path ?? `./bots/${agent.name}/memory.db`, { backend: cfg(agent, 'memory_backend', backend) });
        } catch (e) {
            console.warn('[memory] could not open memory store:', e?.message || e);
        }
        return new MemoryManager(agent, store);
    }

    constructor(agent, store) {
        this.agent = agent;
        this.store = store;
        this.logged = new WeakMap(); // turn -> event id
        this.watcher = new ObservationWatcher(this);
        this.seen = new SeenReporter(agent);
        this.recentUnknown = new Map();
    }

    get enabled() { return !!this.store; }
    get selfName() { return this.agent?.name ?? 'self'; }

    day() {
        const age = this.agent?.bot?.time?.age;
        return Number.isFinite(age) ? Math.floor(age / 24000) : null;
    }
    pos() {
        const p = this.agent?.bot?.entity?.position;
        return Number.isFinite(p?.x) && Number.isFinite(p?.z) ? { x: p.x, z: p.z, y: p.y } : null;
    }
    _safe(fn, fallback) {
        if (!this.store) return fallback;
        try { return fn(); } catch (e) { console.warn('[memory]', e?.message || e); return fallback; }
    }

    attachBot(bot) {
        try { this.seen.attach(bot); } catch (e) { console.warn('[memory] seen reporter:', e?.message || e); }
    }

    tick() {
        if (!this.store) return;
        this.watcher.tick(this.agent).catch(() => {});
    }

    // ---- raw event log ----
    _eventFor(turn) {
        const content = String(turn.content ?? '');
        if (turn.role === 'system' || TRANSIENT.test(content.trim())) return null;
        if (turn.role === 'assistant') return { kind: 'said', speaker: 'self', text: content };
        const m = content.match(/^([^:\n]{1,32}):\s?([\s\S]*)$/);
        if (m && m[1] !== this.selfName) return { kind: 'heard', speaker: m[1].trim(), text: m[2] };
        return null;
    }

    recordTurn(turn) {
        return this._safe(() => {
            if (this.logged.has(turn)) return this.logged.get(turn);
            const e = this._eventFor(turn);
            if (!e || !e.text.trim()) return null;
            const id = this.store.appendEvent({ ...e, ts: Date.now(), day: this.day(), pos: this.pos() });
            this.logged.set(turn, id);
            if (e.kind === 'heard') this.store.touchPerson(e.speaker);
            return id;
        }, null);
    }

    /** Append turns about to be summarised that were not already logged live; returns event ids per turn (or null). */
    logTurns(turns) {
        return this._safe(() => {
            let known = null;
            return turns.map(turn => {
                if (this.logged.has(turn)) return this.logged.get(turn);
                const content = String(turn.content ?? '');
                if (TRANSIENT.test(content.trim())) return null;
                let e = this._eventFor(turn);
                if (!e && turn.role === 'system') e = { kind: 'did', speaker: null, text: content };
                if (!e || !e.text.trim()) return null;
                if (!known) known = new Map(this.store.recentEvents(300).map(r => [`${r.kind}|${r.speaker}|${r.text}`, r.id]));
                const dup = known.get(`${e.kind}|${e.speaker}|${e.text}`);
                if (dup) { this.logged.set(turn, dup); return dup; } // already stored before a restart
                const id = this.store.appendEvent({ ...e, ts: Date.now(), day: this.day(), pos: this.pos() });
                this.logged.set(turn, id);
                return id;
            });
        }, turns.map(() => null));
    }

    /** Called by History after promptMemSaving: store model facts with code-assigned provenance. */
    ingestSummary(turns, eventIds, facts) {
        return this._safe(() => {
            if (!facts?.length) return 0;
            const infos = describeTurns(turns, this.selfName, eventIds);
            return ingestFacts({ store: this.store, infos, ts: Date.now(), day: this.day() }, facts);
        }, 0);
    }

    // ---- deterministic write commands ----
    rememberPlace(name, x, z, { radius = 32 } = {}) {
        return this._safe(() => {
            const p = this.pos();
            const sender = this.agent?.last_sender;
            let source;
            if (p && dist(p.x, p.z, x, z) <= NEAR_ENOUGH_TO_OBSERVE) source = { kind: 'observed', name: 'self' };
            else if (sender && sender !== this.selfName && sender !== 'system') source = { kind: 'told', name: sender };
            else source = { kind: 'inferred', name: 'self' };
            if (source.kind === 'told') source.event_id = this.store.eventsBySpeaker(sender, 1)[0]?.id ?? null;
            const day = this.day();
            recordPlaceClaim(this.store, { name, x, z, radius, source, day });
            this.store.appendEvent({ kind: 'did', speaker: 'self', day, pos: p, text: `remembered place "${name}" at (${x},${z}) [${source.kind}${source.kind === 'told' ? ' by ' + source.name : ''}]` });
            const how = source.kind === 'told' ? `told by ${source.name}` : source.kind === 'observed' ? 'I am here' : 'unverified';
            return `Remembered "${name}" around (${x},${z}), radius ${radius} [${how}].`;
        }, 'Memory is unavailable.');
    }

    rememberHere(name, x, y, z) {
        return this._safe(() => {
            recordPlaceClaim(this.store, { name, x: Math.round(x), z: Math.round(z), y: Math.round(y), radius: 8, source: { kind: 'observed', name: 'self' }, day: this.day() });
            return true;
        }, false);
    }

    lookup(name) { return this._safe(() => lookupLocation(this.store, name), null); }
    placeNames() { return this._safe(() => this.store.placeNames().map(p => p.name), []); }

    recordUnknown(term) {
        return this._safe(() => {
            const key = term.toLowerCase();
            const last = this.recentUnknown.get(key) ?? 0;
            if (Date.now() - last < 10 * 60000) return;
            this.recentUnknown.set(key, Date.now());
            this.store.appendEvent({ kind: 'unknown', speaker: this.agent?.last_sender ?? null, day: this.day(), pos: this.pos(), text: `asked about "${term}" but I have no record` });
        }, undefined);
    }

    // ---- read side ----
    async recall(turns) {
        if (!this.store || !turns?.length) return '';
        try {
            const embed = cfg(this.agent, 'memory_use_embeddings', false) && this.agent?.prompter?.embedding_model?.embed
                ? this._embedder() : null;
            const r = await retrieve({
                store: this.store, turns, position: this.pos(), embed, selfName: this.selfName,
                maxChars: Number(cfg(this.agent, 'memory_recall_chars', DEFAULT_RECALL_CHARS)),
            });
            for (const t of r.unknown) this.recordUnknown(t);
            return r.text;
        } catch (e) {
            console.warn('[memory] recall failed:', e?.message || e);
            return '';
        }
    }

    _embedder() {
        const model = this.agent.prompter.embedding_model;
        this._embCache ??= new Map();
        return async (text) => {
            const key = text.slice(0, 300);
            if (!this._embCache.has(key)) {
                if (this._embCache.size > 500) this._embCache.clear();
                this._embCache.set(key, await model.embed(key));
            }
            return this._embCache.get(key);
        };
    }

    placesText() {
        return this._safe(() => placesLine(this.store, this.pos(), { maxChars: Number(cfg(this.agent, 'memory_places_chars', DEFAULT_PLACES_CHARS)) }), '');
    }

    // ---- command-facing queries (strings for the LLM) ----
    recallPlace(name) {
        return this._safe(() => {
            const places = this.store.findPlacesByName(name);
            if (!places.length) { this.recordUnknown(name); return `No record of a place called "${name}". I have not seen it or been told about it.`; }
            const p = this.pos();
            return places.slice(0, 2).map(pl => {
                const v = visitInfo(this.store, pl.id);
                let vis = 'only heard of, never visited';
                if (v.visited) {
                    const day = this.day();
                    vis = v.last.day !== null && day !== null ? `visited (observed ${Math.max(0, day - v.last.day)} days ago)` : `visited (observed ${when(v.last)})`;
                }
                return `[${vis}] ${placeLine(this.store, pl, p)}`;
            }).join('\n');
        }, 'Memory is unavailable.');
    }

    knownPlaces(limit = 10) {
        return this._safe(() => {
            const p = this.pos() ?? { x: 0, z: 0 };
            const all = nearestPlaces(this.store, p.x, p.z, 1000);
            if (!all.length) return 'No known places yet.';
            const rows = all.slice(0, limit).map(({ place, d, dir }) => {
                const v = visitInfo(this.store, place.id).visited ? 'visited' : 'heard';
                return `${placeDisplayName(this.store, place)} (${Math.round(place.cx)},${Math.round(place.cz)}) ${Math.round(d)}${dir} ${v}`;
            });
            return 'Known places (nearest first): ' + rows.join('; ') + (all.length > limit ? `; +${all.length - limit} more (use !recallPlace or !searchMemory)` : '');
        }, 'Memory is unavailable.');
    }

    whoIs(name) {
        return this._safe(() => {
            const person = renderPerson(this.store, name);
            if (!person) { this.recordUnknown(name); return `No record of a person called "${name}".`; }
            const said = this.store.eventsBySpeaker(name, 3).filter(e => e.kind === 'heard');
            return person + (said.length ? ' Recently said: ' + said.map(e => `"${clip(e.text, 80)}"`).join(' | ') : '');
        }, 'Memory is unavailable.');
    }

    searchMemory(query) {
        return this._safe(() => {
            const hits = this.store.search(query, 12);
            const lines = [];
            const seen = new Set();
            for (const h of hits) {
                let line = null;
                if (h.kind === 'event') {
                    const e = this.store.getEvent(h.ref);
                    if (e) line = `[${e.day !== null && e.day !== undefined ? 'day ' + e.day : new Date(e.ts).toISOString().slice(0, 10)}, ${e.kind}${e.speaker ? ' ' + e.speaker : ''}] ${clip(e.text, 120)}`;
                } else if (h.kind === 'place') {
                    const pl = this.store.getPlace(this.store.resolvePlace(h.ref));
                    if (pl) line = placeLine(this.store, pl, this.pos());
                } else if (h.kind === 'claim') {
                    const c = this.store.getClaim(h.ref);
                    if (c) line = c.subject_type === 'place' ? placeLine(this.store, this.store.getPlace(this.store.resolvePlace(Number(c.subject_id))), this.pos())
                        : c.subject_type === 'person' ? renderPerson(this.store, c.subject_id) : renderGeneral(this.store, c.subject_id);
                }
                if (line && !seen.has(line)) { seen.add(line); lines.push(line); }
                if (lines.length >= 5) break;
            }
            if (!lines.length) { this.recordUnknown(query); return `No record matching "${query}".`; }
            return lines.join('\n');
        }, 'Memory is unavailable.');
    }

    confirmPlace(name) {
        return this._safe(() => {
            const group = this.store.findPlacesByName(name);
            const ids = new Set(group.flatMap(p => this.store.placeGroup(p.id)));
            const cands = this.store.getLinks({ status: 'candidate' }).filter(l => ids.has(l.told_place) || ids.has(l.observed_place))
                .sort((a, b) => b.confidence - a.confidence);
            if (!cands.length) return group.length ? `No unconfirmed sighting matches "${name}".` : `No record of "${name}".`;
            const l = cands[0];
            confirmLink(this.store, l.id);
            const obs = this.store.getPlace(l.observed_place);
            this.store.appendEvent({ kind: 'did', speaker: 'self', day: this.day(), text: `confirmed "${name}" is the place I saw near (${Math.round(obs.cx)},${Math.round(obs.cz)})` });
            return `Confirmed: "${name}" is the place I saw near (${Math.round(obs.cx)},${Math.round(obs.cz)}).`;
        }, 'Memory is unavailable.');
    }

    close() { try { this.store?.close(); } catch { /* ignore */ } }
}

export { askedAbout, turnText, direction };
