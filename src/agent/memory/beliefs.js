/**
 * Beliefs are DERIVED from claims; nothing here writes raw records (refreshPlace only updates cache columns).
 * Ordering: observed (newest first) > told (newest first) > inferred (newest first).
 * Conflicting claims are never discarded: the rendered text keeps every live claim with its source
 * ("the claim and the ruins may disagree and neither erases the other").
 */
import { clip, dist, distToBbox } from './util.js';

const RANK = { observed: 0, told: 1, inferred: 2 };
export const CONSISTENT_MARGIN = 16;

export function rankClaims(claims) {
    return [...claims].sort((a, b) => (RANK[a.source_kind] - RANK[b.source_kind]) || (b.ts - a.ts) || (b.id - a.id));
}

/** {best, others} for a list of claims (already filtered to one subject+predicate). */
export function belief(claims) {
    const ranked = rankClaims(claims.filter(c => !c.superseded_by));
    return { best: ranked[0] ?? null, others: ranked.slice(1) };
}

export function locOf(claim) {
    const v = claim?.value;
    if (v && Number.isFinite(v.x) && Number.isFinite(v.z)) return v;
    return null;
}

const fmtPt = (v) => `(${Math.round(v.x)},${Math.round(v.z)})`;
export function when(c) {
    if (c.day !== null && c.day !== undefined) return `day ${c.day}`;
    return new Date(c.ts).toISOString().slice(0, 10);
}
function who(c) { return c.source_name && c.source_name !== 'self' ? c.source_name : null; }

/** Live claims about a place and every place merged into it. */
export function placeClaims(store, placeId, predicate = null) {
    const out = [];
    for (const id of store.placeGroup(store.resolvePlace(placeId) ?? placeId)) out.push(...store.getClaims('place', id, { predicate }));
    return out;
}

/**
 * Live status of a place from its 'status' claims: 'gone' | 'exists' | 'no_location' (null when nobody said).
 * Ranked like any other claim (observed > told > inferred, newest first); nothing is deleted.
 */
export function placeStatus(store, placeId) {
    const best = belief(placeClaims(store, placeId, 'status')).best;
    return best ? { state: String(best.value), claim: best } : null;
}

/** Refresh derived cache columns (name, centre, area) from the claims. Safe to call any time. */
export function refreshPlace(store, placeId) {
    const place = store.getPlace(placeId);
    if (!place) return;
    const patch = {};
    const nameClaim = belief(placeClaims(store, placeId, 'name')).best;
    if (nameClaim && typeof nameClaim.value === 'string' && nameClaim.value !== place.name) patch.name = nameClaim.value;
    const loc = locOf(belief(placeClaims(store, placeId, 'location')).best);
    if (loc) {
        const bbox = loc.bbox ?? null;
        const r = loc.r ?? (bbox ? Math.hypot(bbox.x2 - bbox.x1, bbox.z2 - bbox.z1) / 2 : 32);
        if (place.cx !== loc.x || place.cz !== loc.z || place.radius !== r) { patch.cx = loc.x; patch.cz = loc.z; patch.radius = r; patch.bbox = bbox; }
    } else if (Number.isFinite(place.cx) && placeClaims(store, placeId, 'location').length === 0) {
        // every location claim has been retracted: stop advertising a position
        patch.cx = null; patch.cz = null; patch.radius = null; patch.bbox = null;
    }
    if (Object.keys(patch).length) store.updatePlace(placeId, patch);
}

export function placeDisplayName(store, place) {
    if (place.name) return place.name;
    if (Number.isFinite(place.cx)) return `${place.kind === 'settlement' ? 'settlement' : 'place'} near (${Math.round(place.cx)},${Math.round(place.cz)})`;
    return `place #${place.id}`;
}

/** {visited:boolean, last: observation|null} accumulated, never shrinking. */
export function visitInfo(store, placeId) {
    const last = store.latestObservation(store.placeGroup(store.resolvePlace(placeId) ?? placeId));
    return { visited: !!last, last };
}

function consistencyTag(bestObserved, loc) {
    if (!bestObserved) return '';
    const o = locOf(bestObserved);
    if (!o) return '';
    const d = o.bbox ? distToBbox(loc.x, loc.z, o.bbox) : Math.max(0, dist(o.x, o.z, loc.x, loc.z) - (o.r ?? 0));
    return d <= CONSISTENT_MARGIN ? ', consistent' : `, ~${Math.round(dist(o.x, o.z, loc.x, loc.z))} off`;
}

function describeLocationClaim(c, firstObserved) {
    const loc = locOf(c);
    if (!loc) return null;
    if (c.source_kind === 'observed') return `I saw it around ${fmtPt(loc)} on ${when(c)} [observed]`;
    if (c.source_kind === 'told')
        return `${who(c) ?? 'someone'} said ${fmtPt(loc)} [told, ${when(c)}${c === firstObserved ? '' : consistencyTag(firstObserved, loc)}]`;
    return `${fmtPt(loc)} [inferred, ${when(c)}]`;
}

/** Link-candidate lines for a place (told<->observed). */
export function linkLines(store, placeId) {
    const group = new Set(store.placeGroup(placeId));
    const lines = [];
    for (const l of store.getLinks({ status: 'candidate' })) {
        const told = store.getPlace(l.told_place), obs = store.getPlace(l.observed_place);
        if (!told || !obs || told.merged_into || obs.merged_into) continue;
        const claim = store.getClaim(l.claim_id);
        const d = Math.round(l.distance ?? 0);
        const word = (l.confidence ?? 0) >= 0.6 ? 'probably' : 'possibly';
        if (group.has(obs.id)) {
            lines.push(`${word} the same as ${placeDisplayName(store, told)} (told by ${claim ? (who(claim) ?? 'someone') : 'someone'}, ${d} blocks from what I saw)`);
        } else if (group.has(told.id)) {
            lines.push(`${word} the place I saw: ${placeDisplayName(store, obs)} (${d} blocks from the told point; !confirmPlace("${told.name ?? ''}") if same)`);
        }
    }
    return lines;
}

const SOURCE_LABEL = { observed: 'I saw', told: null, inferred: 'I inferred' };
function claimVoice(c) {
    if (c.source_kind === 'told') return `${who(c) ?? 'someone'} said`;
    return SOURCE_LABEL[c.source_kind] ?? c.source_kind;
}
export const CONFLICT_DISTANCE = 48;

/**
 * Places where the live records disagree. Never resolves anything; it only makes the disagreement impossible
 * to miss so the answer can give both sides with their sources.
 */
export function conflictLines(store, placeId) {
    const out = [];
    const locs = rankClaims(placeClaims(store, placeId, 'location')).filter(c => locOf(c));
    const status = placeStatus(store, placeId);
    for (let i = 0; i < locs.length && !out.length; i++) {
        for (let j = i + 1; j < locs.length; j++) {
            const a = locs[i], b = locs[j];
            if (a.source_kind === b.source_kind && (a.source_name ?? null) === (b.source_name ?? null)) continue;
            const la = locOf(a), lb = locOf(b);
            const gap = dist(la.x, la.z, lb.x, lb.z);
            if (gap <= Math.max(CONFLICT_DISTANCE, (la.r ?? 0) + (lb.r ?? 0))) continue;
            out.push(`CONFLICT on location: ${claimVoice(a)} ${fmtPt(la)} but ${claimVoice(b)} ${fmtPt(lb)} (~${Math.round(gap)} apart). Give both, with who said each.`);
            break;
        }
    }
    if (status?.state === 'no_location' && locs.length)
        out.push(`CONFLICT: ${claimVoice(status.claim)} it has no location, yet a location is recorded. Give both.`);
    if (status?.state === 'gone') {
        const later = locs.find(c => c.source_kind === 'observed' && c.ts > status.claim.ts);
        if (later) out.push(`CONFLICT: ${claimVoice(status.claim)} it is gone, but I saw it afterwards (${when(later)}). Give both.`);
    }
    return out;
}

/** Compact provenance-bearing text for one place. */
export function renderPlace(store, placeId, { now = Date.now() } = {}) {
    const place = store.getPlace(placeId);
    if (!place) return '';
    const names = rankClaims(placeClaims(store, placeId, 'name'));
    const display = names[0] && typeof names[0].value === 'string' ? names[0].value : placeDisplayName(store, place);
    const parts = [];
    const status = placeStatus(store, placeId);
    if (status?.state === 'gone')
        parts.push(`GONE: ${claimVoice(status.claim)} it no longer exists [${status.claim.source_kind}, ${when(status.claim)}].`);
    const locs = rankClaims(placeClaims(store, placeId, 'location')).filter(c => locOf(c));
    const firstObserved = locs.find(c => c.source_kind === 'observed') ?? null;
    const locTexts = locs.map(c => describeLocationClaim(c, firstObserved)).filter(Boolean);
    if (locTexts.length) parts.push((status?.state === 'gone' ? 'Earlier record: ' : '') + locTexts[0] + (locTexts.length > 1 ? '. ' + locTexts.slice(1).join('; ') : '') + '.');
    else if (status?.state === 'no_location') parts.push(`no known location: ${claimVoice(status.claim)} it has none (${when(status.claim)}).`);
    else parts.push('location unknown.');
    for (const l of conflictLines(store, placeId)) parts.push(l);
    const others = [...new Set(names.slice(1).filter(c => c.value !== names[0].value).map(c => `${c.value} (${c.source_kind}${who(c) ? ' by ' + who(c) : ''})`))];
    if (others.length) parts.push(`Also called ${others.slice(0, 2).join(', ')}.`);
    const desc = belief(placeClaims(store, placeId, 'description'));
    if (desc.best) {
        parts.push(`${clip(String(desc.best.value), 160)} [${desc.best.source_kind}${who(desc.best) ? ' ' + who(desc.best) : ''}, ${when(desc.best)}]`);
        if (desc.others[0] && desc.others[0].value !== desc.best.value)
            parts.push(`Also: ${clip(String(desc.others[0].value), 80)} [${desc.others[0].source_kind}${who(desc.others[0]) ? ' ' + who(desc.others[0]) : ''}].`);
    }
    for (const l of linkLines(store, placeId).slice(0, 2)) parts.push(l[0].toUpperCase() + l.slice(1) + '.');
    return `${display}: ${parts.join(' ')}`;
}

export function renderPerson(store, name) {
    const p = store.getPerson(name);
    const claims = rankClaims(store.getClaims('person', String(name).toLowerCase()));
    if (!p && !claims.length) return '';
    const parts = [];
    if (p) parts.push(`known since ${new Date(p.first_seen).toISOString().slice(0, 10)}, last seen ${new Date(p.last_seen).toISOString().slice(0, 10)}`);
    if (p?.summary) parts.push(clip(p.summary, 160));
    for (const c of claims.slice(0, 4))
        parts.push(`${c.predicate}: ${clip(typeof c.value === 'string' ? c.value : JSON.stringify(c.value), 100)} [${c.source_kind}${who(c) ? ' ' + who(c) : ''}, ${when(c)}]`);
    return `${p?.display ?? name}: ${parts.join('; ')}.`;
}

export function renderGeneral(store, subject) {
    const claims = rankClaims(store.getClaims('general', String(subject).toLowerCase()));
    if (!claims.length) return '';
    return `${subject}: ` + claims.slice(0, 3).map(c =>
        `${clip(typeof c.value === 'string' ? c.value : JSON.stringify(c.value), 120)} [${c.source_kind}${who(c) ? ' ' + who(c) : ''}, ${when(c)}]`).join('; ') + '.';
}
