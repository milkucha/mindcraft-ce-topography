export const STOPWORDS = new Set((
    'the a an and or but of to in on at for with from by is are was were be been am do does did '
    + 'it its this that these those i you he she we they me my your our their him her them us '
    + 'what where when who whom how why which can could would should will shall may might '
    + 'there here have has had not no yes so if then than about into out up down over just '
    + 'get got go going know tell say said hey hi hello please thanks ok okay one some any'
).split(/\s+/));

export function tokenize(text, { keepStop = false } = {}) {
    const out = [];
    for (const m of String(text ?? '').toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
        const t = m[0];
        if (t.length < 2) continue;
        if (!keepStop && STOPWORDS.has(t)) continue;
        out.push(t);
    }
    return out;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `name` appears in `text` as a whole word/phrase (case-insensitive, unicode-aware). */
export function mentionsName(text, name) {
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}([^\\p{L}\\p{N}]|$)`, 'iu').test(String(text ?? ''));
}

export function clip(text, n) {
    text = String(text ?? '').replace(/\s+/g, ' ').trim();
    return text.length > n ? text.slice(0, Math.max(0, n - 1)) + '…' : text;
}

const DIRS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
/** Compass direction from (x1,z1) to (x2,z2). North is -Z, east is +X. */
export function direction(x1, z1, x2, z2) {
    const a = Math.atan2(z2 - z1, x2 - x1); // east=0, south=+pi/2
    const idx = Math.round(a / (Math.PI / 4));
    return DIRS[((idx % 8) + 8) % 8];
}

export function dist(x1, z1, x2, z2) {
    return Math.hypot(x2 - x1, z2 - z1);
}

/** Distance from a point to a bbox {x1,z1,x2,z2} (0 inside). */
export function distToBbox(x, z, b) {
    const dx = Math.max(Math.min(b.x1, b.x2) - x, 0, x - Math.max(b.x1, b.x2));
    const dz = Math.max(Math.min(b.z1, b.z2) - z, 0, z - Math.max(b.z1, b.z2));
    return Math.hypot(dx, dz);
}

export function bboxOverlap(a, b) {
    return Math.min(a.x1, a.x2) <= Math.max(b.x1, b.x2) && Math.max(a.x1, a.x2) >= Math.min(b.x1, b.x2)
        && Math.min(a.z1, a.z2) <= Math.max(b.z1, b.z2) && Math.max(a.z1, a.z2) >= Math.min(b.z1, b.z2);
}
