/**
 * Write-path operations on a store. Provenance (source kind, name, time, event) is always supplied by
 * code from the situation (who spoke, whether the bot was there), never taken from LLM output.
 * Told claims are NEVER auto-merged into observed places: a mechanical link_candidate is stored with a
 * confidence from the distance; a link is made by a deliberate act (confirmLink / !confirmPlace) or by an
 * observation whose bbox clearly contains the told point.
 */
import { refreshPlace, belief, locOf, placeClaims, visitInfo, placeStatus } from './beliefs.js';
import { dist, distToBbox, bboxOverlap, direction } from './util.js';

export const LINK_RADIUS = 96;
export const OBSERVED_MATCH_DISTANCE = 48;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Add a claim; identical repeat from the same source is a no-op; older claims from the same source are superseded. */
export function addClaim(store, claim) {
    const prior = store.getClaims(claim.subject_type, claim.subject_id, { predicate: claim.predicate })
        .filter(c => c.source_kind === claim.source_kind && (c.source_name ?? null) === (claim.source_name ?? null));
    const dup = prior.find(c => same(c.value, claim.value));
    if (dup) return dup.id;
    const id = store.addClaim(claim);
    for (const c of prior) store.supersedeClaim(c.id, id, claim.ts ?? Date.now());
    return id;
}

function observedLocs(store, placeId) {
    return placeClaims(store, placeId, 'location').filter(c => c.source_kind === 'observed' && locOf(c));
}

/** Distance from a told point to the observed area of a place (0 when inside the bbox). */
function pointToObserved(store, point, obsPlaceId) {
    const o = locOf(belief(observedLocs(store, obsPlaceId)).best);
    if (!o) return null;
    if (o.bbox) return distToBbox(point.x, point.z, o.bbox);
    return Math.max(0, dist(o.x, o.z, point.x, point.z) - (o.r ?? 0));
}

export function confirmLink(store, linkId) {
    const l = store.t.links.get(Number(linkId));
    if (!l || l.status === 'confirmed') return false;
    const told = store.getPlace(l.told_place), obs = store.getPlace(l.observed_place);
    if (!told || !obs || told.id === obs.id) return false;
    store.updatePlace(told.id, { merged_into: store.resolvePlace(obs.id) });
    store.setLinkStatus(l.id, 'confirmed');
    refreshPlace(store, obs.id);
    return true;
}

/** Recompute link candidates between told-only places and observed places touching `placeId`. */
export function relink(store, placeId, ts = Date.now()) {
    const live = store.listPlaces();
    const isObs = (p) => observedLocs(store, p.id).length > 0;
    const focus = store.resolvePlace(placeId);
    const told = [], obsd = [];
    for (const p of live) (isObs(p) ? obsd : told).push(p);
    const pairs = [];
    const focusIsObs = obsd.some(p => p.id === focus);
    if (focusIsObs) for (const t of told) pairs.push([t, store.getPlace(focus)]);
    else if (told.some(p => p.id === focus)) for (const o of obsd) pairs.push([store.getPlace(focus), o]);
    for (const [t, o] of pairs) {
        for (const c of placeClaims(store, t.id, 'location')) {
            const loc = locOf(c);
            if (!loc || c.source_kind === 'observed') continue;
            const d = pointToObserved(store, loc, o.id);
            if (d === null || d > LINK_RADIUS) continue;
            const confidence = d === 0 ? 1 : Math.max(0.05, 1 - d / (LINK_RADIUS * 1.25));
            const id = store.addLink({ told_place: t.id, observed_place: o.id, claim_id: c.id, distance: d, confidence, ts });
            if (d === 0) confirmLink(store, id); // clearly contained by the observed area
        }
    }
}

function exactPlace(store, name) {
    const n = String(name).trim().toLowerCase();
    return store.listPlaces().find(p => p.name && p.name.toLowerCase() === n) ?? null;
}

/**
 * Record a named location claim. source: {kind:'told'|'observed'|'inferred', name, event_id, derived_from}.
 * Same-name claims attach to the same named place (they are competing claims about one name).
 */
export function recordPlaceClaim(store, { name, x = null, z = null, y = null, radius = 32, source, nameSource = null, ts = Date.now(), day = null }) {
    // x/z are optional: someone can name a place without saying where it is, and we must not invent a position.
    // nameSource lets the name be "told" while the location comes from somewhere else (e.g. the bot's own position).
    const hasLoc = Number.isFinite(x) && Number.isFinite(z);
    let place = exactPlace(store, name);
    if (!place) {
        const id = store.createPlace({ name, kind: 'place', cx: hasLoc ? x : null, cz: hasLoc ? z : null, radius: hasLoc ? radius : null, ts });
        place = store.getPlace(id);
    }
    const fields = (s) => ({ source_kind: s.kind, source_name: s.name ?? null, event_id: s.event_id ?? null, derived_from: s.derived_from ?? null });
    const base = { subject_type: 'place', subject_id: place.id, ts, day };
    addClaim(store, { ...base, ...fields(nameSource ?? source), predicate: 'name', value: name });
    if (hasLoc) {
        const value = { x, z, r: radius }; if (y !== null && y !== undefined) value.y = y;
        addClaim(store, { ...base, ...fields(source), predicate: 'location', value });
        if (source.kind === 'observed')
            store.addObservation({ place_id: place.id, ts, day, pos: { x, z }, digest: { via: 'visit', note: 'was there when it was recorded' } });
    }
    refreshPlace(store, place.id);
    if (hasLoc) relink(store, place.id, ts);
    return place.id;
}

export const PLACE_STATES = new Set(['gone', 'exists', 'no_location']);

/**
 * Record a correction about a place that is already known: it is gone, it exists after all, or it has no
 * location. Claims are never deleted. A told "no_location" ends the told/inferred location claims (they are
 * superseded by the status claim); a location the bot saw itself is kept and surfaced as a conflict, because
 * observed beats told. Returns { placeId, state, keptObserved } or null for an unknown place/state.
 */
export function markPlaceStatus(store, { name, state, source, ts = Date.now(), day = null }) {
    if (!PLACE_STATES.has(state)) return null;
    const place = store.findPlacesByName(name)[0];
    if (!place) return null;
    const placeId = store.resolvePlace(place.id) ?? place.id;
    const claimId = addClaim(store, {
        subject_type: 'place', subject_id: placeId, predicate: 'status', value: state,
        source_kind: source.kind, source_name: source.name ?? null, ts, day,
        event_id: source.event_id ?? null, derived_from: source.derived_from ?? null,
    });
    let keptObserved = false;
    if (state === 'no_location') {
        for (const c of placeClaims(store, placeId, 'location')) {
            if (c.source_kind === 'observed' && source.kind !== 'observed') { keptObserved = true; continue; }
            store.supersedeClaim(c.id, claimId, ts);
        }
    }
    refreshPlace(store, placeId);
    return { placeId, state, keptObserved };
}

export function recordPlaceFact(store, { name, predicate, value, source, ts = Date.now(), day = null }) {
    let place = exactPlace(store, name);
    if (!place) place = store.getPlace(store.createPlace({ name, kind: 'place', ts }));
    addClaim(store, {
        subject_type: 'place', subject_id: place.id, predicate, value, source_kind: source.kind, source_name: source.name ?? null,
        ts, day, event_id: source.event_id ?? null, derived_from: source.derived_from ?? null,
    });
    if (predicate === 'name') refreshPlace(store, place.id);
    return place.id;
}

/** Compact survey digest stored on observations. */
export function surveyDigest(settlement, survey) {
    const d = { building_count: survey?.building_count ?? settlement?.building_count ?? null };
    if (survey?.summary) d.summary = String(survey.summary).slice(0, 400);
    if (survey?.palette?.walls) d.walls = survey.palette.walls.slice(0, 3);
    if (survey?.palette?.roof) d.roof = survey.palette.roof.slice(0, 2);
    if (survey?.dimensions) d.dimensions = survey.dimensions;
    if (Array.isArray(survey?.landmarks)) d.landmarks = survey.landmarks.slice(0, 6);
    if (settlement?.evidence) d.evidence = settlement.evidence.slice(0, 4);
    for (const k of ['sampled_chunks', 'missing_chunks', 'unexplored_chunks']) if (survey?.[k] !== undefined) d[k] = survey[k];
    return d;
}

export function findObservedPlace(store, bbox) {
    let best = null, bestD = Infinity;
    const cx = (bbox.x1 + bbox.x2) / 2, cz = (bbox.z1 + bbox.z2) / 2;
    for (const p of store.listPlaces()) {
        const o = locOf(belief(observedLocs(store, p.id)).best);
        if (!o) continue;
        const overlap = o.bbox ? bboxOverlap(o.bbox, bbox) : false;
        const d = dist(o.x, o.z, cx, cz);
        if ((overlap || d <= OBSERVED_MATCH_DISTANCE) && d < bestD) { best = p; bestD = d; }
    }
    return best;
}

/** Write a place (matched by overlap or created unnamed), an observation and observed location claims. */
export function recordObservation(store, { settlement, survey = null, botPos = null, ts = Date.now(), day = null, self = 'self' }) {
    const bbox = settlement.bbox ?? survey?.bbox;
    const center = settlement.center ?? { x: (bbox.x1 + bbox.x2) / 2, z: (bbox.z1 + bbox.z2) / 2 };
    let place = bbox ? findObservedPlace(store, bbox) : null;
    if (!place) place = store.getPlace(store.createPlace({ kind: 'settlement', cx: center.x, cz: center.z, bbox, ts }));
    const base = { subject_type: 'place', subject_id: place.id, source_kind: 'observed', source_name: self, ts, day };
    const r = bbox ? Math.hypot(bbox.x2 - bbox.x1, bbox.z2 - bbox.z1) / 2 : 32;
    addClaim(store, { ...base, predicate: 'location', value: { x: Math.round(center.x), z: Math.round(center.z), r: Math.round(r), bbox } });
    if (survey?.summary) addClaim(store, { ...base, predicate: 'description', value: String(survey.summary).slice(0, 400) });
    store.addObservation({ place_id: place.id, ts, day, pos: botPos, digest: surveyDigest(settlement, survey) });
    refreshPlace(store, place.id);
    relink(store, place.id, ts);
    return place.id;
}

/** Nearest known places with a centre: [{place, d, dir}] */
export function nearestPlaces(store, x, z, n = 5, { includeGone = false } = {}) {
    const out = [];
    for (const p of store.listPlaces()) {
        if (!Number.isFinite(p.cx)) continue;
        if (!includeGone && placeStatus(store, p.id)?.state === 'gone') continue; // a place that no longer exists is not "nearby"
        out.push({ place: p, d: dist(x, z, p.cx, p.cz), dir: direction(x, z, p.cx, p.cz) });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, n);
}

/** Best-believed location of a named place as {x,y,z} or null. */
export function lookupLocation(store, name) {
    const p = store.findPlacesByName(name)[0];
    if (!p) return null;
    const best = belief(placeClaims(store, p.id, 'location').filter(c => locOf(c))).best;
    const loc = locOf(best);
    return loc ? { x: loc.x, y: loc.y ?? null, z: loc.z, place: p } : null;
}

export { visitInfo };
