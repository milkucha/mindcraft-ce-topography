/**
 * Structured extraction at summarization time. The model returns {"memory": "...", "facts": [...]};
 * we parse defensively and assign provenance (who said it, when, which event) from the turns in code.
 */
import { recordPlaceClaim, recordPlaceFact, addClaim } from './ops.js';
import { clip } from './util.js';

const MAX_FACTS = 20;
const PREDICATES = new Set(['location', 'name', 'description', 'attribute']);

export function stripFences(text) {
    let t = String(text ?? '');
    if (t.includes('</think>')) t = t.split('</think>').pop();
    t = t.trim();
    const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    return t;
}

/** -> { memory: string, facts: [], structured: boolean }. Never throws. */
export function parseMemoryResponse(raw) {
    const text = stripFences(raw);
    const attempt = (s) => { try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
    let obj = attempt(text);
    if (!obj) {
        const a = text.indexOf('{'), b = text.lastIndexOf('}');
        if (a !== -1 && b > a) obj = attempt(text.slice(a, b + 1));
    }
    if (obj && ('memory' in obj || 'facts' in obj)) {
        const facts = Array.isArray(obj.facts) ? obj.facts.filter(f => f && typeof f === 'object') : [];
        const memory = typeof obj.memory === 'string' ? obj.memory.trim() : null;
        return { memory, facts, structured: true };
    }
    // salvage a truncated/garbled JSON blob: pull the memory string out if we can
    const m = text.match(/"memory"\s*:\s*"((?:[^"\\]|\\.)*)"?/);
    if (m) {
        let mem = m[1];
        try { mem = JSON.parse(`"${m[1]}"`); } catch { /* keep raw */ }
        return { memory: mem.trim(), facts: [], structured: false };
    }
    return { memory: text, facts: [], structured: false };
}

/** Describe turns for attribution: speaker comes from the "<name>: " prefix added by History.add. */
export function describeTurns(turns, selfName, eventIds = []) {
    return turns.map((t, i) => {
        const content = String(t.content ?? '');
        if (t.role === 'assistant') return { speaker: 'self', text: content, role: 'assistant', eventId: eventIds[i] ?? null };
        if (t.role === 'user') {
            const m = content.match(/^([^:\n]{1,32}):\s?([\s\S]*)$/);
            if (m && m[1] !== selfName) return { speaker: m[1].trim(), text: m[2], role: 'user', eventId: eventIds[i] ?? null };
            return { speaker: null, text: content, role: 'user', eventId: eventIds[i] ?? null };
        }
        return { speaker: null, text: content, role: 'system', eventId: eventIds[i] ?? null };
    });
}

export function parseCoords(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const x = Number(value.x), z = Number(value.z);
        if (Number.isFinite(x) && Number.isFinite(z)) return { x: Math.round(x), z: Math.round(z) };
        return null;
    }
    const nums = Array.isArray(value) ? value.map(Number)
        : String(value ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (nums.length === 2 && nums.every(Number.isFinite)) return { x: Math.round(nums[0]), z: Math.round(nums[1]) };
    if (nums.length === 3 && nums.every(Number.isFinite)) return { x: Math.round(nums[0]), z: Math.round(nums[2]) };
    return null;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Find the turn the fact came from; returns the turnInfo or null. Model-claimed speaker is only a tie-break. */
export function attributeFact(fact, infos) {
    const subject = String(fact.subject ?? '').trim().toLowerCase();
    if (!subject) return null;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc(subject)}([^\\p{L}\\p{N}]|$)`, 'iu');
    const valueText = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value ?? '');
    const nums = valueText.match(/-?\d+/g) ?? [];
    const words = valueText.toLowerCase().match(/\p{L}{4,}/gu) ?? [];
    let best = null, bestScore = 0;
    infos.forEach((info, i) => {
        if (info.role === 'system') return;
        const lower = info.text.toLowerCase();
        if (!re.test(info.text)) return;
        let score = 10;
        for (const n of nums) if (lower.includes(n)) score += 2;
        for (const w of words) if (lower.includes(w)) score += 1;
        if (fact.speaker && info.speaker && String(fact.speaker).toLowerCase() === info.speaker.toLowerCase()) score += 0.5;
        if (score >= bestScore) { best = info; bestScore = score; } // >= : later turn wins ties
    });
    return best;
}

/**
 * Ingest model facts. `ctx`: {store, infos, ts, day}. Returns number of facts stored.
 */
export function ingestFacts(ctx, facts) {
    const { store, infos, ts = Date.now(), day = null } = ctx;
    let stored = 0;
    for (const raw of (facts ?? []).slice(0, MAX_FACTS)) {
        try {
            const type = String(raw.type ?? '').toLowerCase();
            const predicate = String(raw.predicate ?? '').toLowerCase();
            const subject = clip(raw.subject ?? '', 80);
            if (!['place', 'person', 'general'].includes(type) || !subject || !PREDICATES.has(predicate) || raw.value === undefined || raw.value === null) continue;
            const info = attributeFact(raw, infos);
            let source;
            if (info?.speaker && info.speaker !== 'self') source = { kind: 'told', name: info.speaker, event_id: info.eventId };
            else if (info?.speaker === 'self') source = { kind: 'inferred', name: 'self', event_id: info.eventId };
            else source = { kind: 'inferred', name: null, event_id: info?.eventId ?? null };
            const value = typeof raw.value === 'string' ? clip(raw.value, 300) : raw.value;
            if (type === 'place') {
                if (predicate === 'location') {
                    const c = parseCoords(value);
                    if (!c) continue;
                    recordPlaceClaim(store, { name: subject, x: c.x, z: c.z, source, ts, day });
                } else {
                    recordPlaceFact(store, { name: subject, predicate, value: typeof value === 'string' ? value : JSON.stringify(value), source, ts, day });
                }
            } else {
                const sid = subject.toLowerCase();
                if (type === 'person') store.touchPerson(subject, ts);
                addClaim(store, { subject_type: type, subject_id: sid, predicate, value, source_kind: source.kind, source_name: source.name, ts, day, event_id: source.event_id ?? null });
            }
            stored++;
        } catch (e) {
            console.warn('[memory] skipped fact:', e?.message || e);
        }
    }
    return stored;
}
