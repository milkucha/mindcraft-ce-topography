/**
 * On-demand retrieval for the prompt: $RECALL (relevant records, size-capped) and $PLACES (one-line index).
 * Answers are composed from stored records with their source attached; when the user asks about a named
 * thing with no record, a typed `unknown` result is returned so the bot says it does not know.
 */
import { renderPlace, renderPerson, renderGeneral, placeDisplayName, visitInfo } from './beliefs.js';
import { nearestPlaces } from './ops.js';
import { tokenize, clip, STOPWORDS, dist, direction } from './util.js';
import { cosineSimilarity } from '../../utils/math.js';

export const DEFAULT_RECALL_CHARS = 900; // ~300 tokens
export const DEFAULT_PLACES_CHARS = 150;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, name) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(name)}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);

const ASK = /(?:where(?:'s|\s+is|\s+are|\s+was)|who(?:'s|\s+is|\s+was)|(?:do|did|have)\s+you\s+(?:know|remember|heard|seen|been)(?:\s+(?:of|about|to))?|heard\s+of|know\s+(?:about|of)|(?:way|path|road|directions?|lead\s+me|take\s+me|guide\s+me|go|get|come|travel)\s+to|tell\s+me\s+about)\s+(?:the\s+|a\s+|an\s+|to\s+|about\s+|of\s+)*"?([A-Z][\p{L}\p{N}'_-]*(?:\s+[A-Z][\p{L}\p{N}'_-]*){0,2})"?/gu;

/** Capitalised names the latest user message asks about. */
export function askedAbout(text, selfName = '') {
    const out = [];
    for (const m of String(text ?? '').matchAll(ASK)) {
        const term = m[1].trim();
        const low = term.toLowerCase();
        if (STOPWORDS.has(low) || low === String(selfName).toLowerCase()) continue;
        out.push(term);
    }
    return [...new Set(out)];
}

export function turnText(t) {
    const c = String(t?.content ?? '');
    return t?.role === 'user' ? c.replace(/^[^:\n]{1,32}:\s?/, '') : c;
}

function knows(store, term) {
    if (store.findPlacesByName(term).length || store.getPerson(term)) return true;
    if (store.getClaims('general', term.toLowerCase()).length) return true;
    const low = term.toLowerCase();
    return store.search(term, 5).some(h => String(h.text).toLowerCase().includes(low));
}

/** One place with distance/direction from `pos` and a visited/heard-only tag. */
export function placeLine(store, place, pos) {
    let text = renderPlace(store, place.id);
    const tags = [];
    if (pos && Number.isFinite(place.cx)) tags.push(`${Math.round(dist(pos.x, pos.z, place.cx, place.cz))} ${direction(pos.x, pos.z, place.cx, place.cz)}`);
    const v = visitInfo(store, place.id);
    tags.push(v.visited ? 'visited' : 'heard only');
    const i = text.indexOf(': ');
    if (i > 0) text = `${text.slice(0, i)} (${tags.join(', ')})${text.slice(i)}`;
    return text;
}

export function placesLine(store, pos, { n = 5, maxChars = DEFAULT_PLACES_CHARS } = {}) {
    if (!store || !pos) return '';
    const items = [];
    for (const { place, d, dir } of nearestPlaces(store, pos.x, pos.z, n)) {
        const label = place.name ?? `${place.kind === 'settlement' ? 'settlement' : 'place'}@(${Math.round(place.cx)},${Math.round(place.cz)})`;
        items.push(`${label} ${Math.round(d)}${dir}`);
    }
    let out = '';
    for (const it of items) {
        const next = out ? `${out}, ${it}` : `Known places: ${it}`;
        if (next.length > maxChars) break;
        out = next;
    }
    return out;
}

/**
 * @returns {Promise<{text:string, unknown:string[], places:number[], people:string[]}>}
 */
export async function retrieve({ store, turns = [], position = null, maxChars = DEFAULT_RECALL_CHARS, embed = null, selfName = '' }) {
    const result = { text: '', unknown: [], places: [], people: [] };
    if (!store || !turns?.length) return result;
    const talk = turns.filter(t => (t.role === 'user' || t.role === 'assistant') && !/^\[earlier /.test(t.content ?? ''));
    const recent = talk.slice(-6);
    const text = recent.map(turnText).join('\n');
    const lastUser = [...talk].reverse().find(t => t.role === 'user');
    const lines = [];
    const seenPlaces = new Set();

    // 1) places / people named in the recent messages
    for (const { id, name } of store.placeNames()) {
        if (mentions(text, name) && !seenPlaces.has(id)) { seenPlaces.add(id); result.places.push(id); }
    }
    for (const p of store.listPeople()) if (mentions(text, p.display ?? p.name)) result.people.push(p.display ?? p.name);

    // 2) full-text hits (claims -> subjects, events -> snippets)
    const qTokens = [...new Set(recent.slice(-3).flatMap(t => tokenize(turnText(t))))];
    let eventHits = [];
    if (qTokens.length) {
        const hits = store.search(qTokens.join(' '), 24);
        for (const h of hits) {
            if (h.kind === 'place' && !seenPlaces.has(h.ref)) {
                const pl = store.getPlace(h.ref);
                const id = pl ? store.resolvePlace(pl.id) : null;
                if (id && !seenPlaces.has(id) && result.places.length < 3) { seenPlaces.add(id); result.places.push(id); }
            } else if (h.kind === 'claim') {
                const c = store.getClaim(h.ref);
                if (!c) continue;
                if (c.subject_type === 'place') {
                    const id = store.resolvePlace(Number(c.subject_id));
                    if (id && !seenPlaces.has(id) && result.places.length < 3) { seenPlaces.add(id); result.places.push(id); }
                } else if (c.subject_type === 'person' && !result.people.includes(c.subject_id) && result.people.length < 3) result.people.push(c.subject_id);
            } else if (h.kind === 'event') eventHits.push(h);
        }
        const need = Math.min(2, qTokens.length);
        eventHits = eventHits.filter(h => {
            const ht = new Set(tokenize(h.text));
            return qTokens.filter(t => ht.has(t)).length >= need;
        });
        if (embed && eventHits.length > 1) {
            try {
                const [qv, ...vs] = await Promise.all([embed(text), ...eventHits.map(h => embed(h.text))]);
                eventHits = eventHits.map((h, i) => ({ h, s: cosineSimilarity(qv, vs[i]) })).sort((a, b) => b.s - a.s).map(x => x.h);
            } catch { /* embeddings are optional */ }
        }
    }

    // 3) unknowns: asked about a name nobody told us and we never saw
    if (lastUser) {
        for (const term of askedAbout(turnText(lastUser), selfName)) if (!knows(store, term)) result.unknown.push(term);
    }
    for (const term of result.unknown)
        lines.push(`NO RECORD of "${term}": you have never seen it or been told about it. Say you don't know; do not guess.`);

    for (const id of result.places.slice(0, 3)) {
        const place = store.getPlace(id);
        if (place) lines.push(placeLine(store, place, position));
    }
    for (const name of result.people.slice(0, 2)) {
        const l = renderPerson(store, name);
        if (l) lines.push(l);
    }
    for (const t of qTokens.slice(0, 6)) {
        if (lines.length > 6) break;
        const g = renderGeneral(store, t);
        if (g) lines.push(g);
    }
    for (const h of eventHits.slice(0, 2)) {
        const e = store.getEvent(h.ref);
        if (!e || e.kind === 'unknown') continue;
        lines.push(`${e.kind === 'said' ? 'I said' : `${e.speaker ?? 'someone'} ${e.kind === 'heard' ? 'said' : e.kind}`}${e.day !== null && e.day !== undefined ? ` (day ${e.day})` : ''}: "${clip(e.text, 100)}"`);
    }

    if (!lines.length) return result;
    const head = 'RECORDS (prefer [observed] over [told]; cite who said it):';
    let out = head;
    for (const l of lines) {
        if (out.length + l.length + 1 > maxChars) { if (out === head) out += '\n' + clip(l, maxChars - head.length - 1); break; }
        out += '\n' + l;
    }
    result.text = out;
    return result;
}
