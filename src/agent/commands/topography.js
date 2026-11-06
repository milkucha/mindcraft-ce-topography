import settings from '../settings.js';

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8090';
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RUNS = 80;
const MAX_TRANSITIONS = 40;
const MAX_SHORELINE_POINTS = 400;

const pad = (str) => {
    return '\n' + str + '\n';
};

function getServiceUrl() {
    const configured = globalThis.process?.env?.TOPOGRAPHY_SERVICE_URL
        || settings.topography_service_url
        || DEFAULT_SERVICE_URL;
    return configured.replace(/\/+$/, '');
}

function formatCoordinate(x, z) {
    return `(${x},${z})`;
}

function formatHeight(value) {
    return Number.isFinite(value) ? String(value) : '?';
}

function formatName(name) {
    if (!name)
        return 'unknown';
    return String(name).replace(/^minecraft:/, '');
}

function formatDecimal(value) {
    return Number.isFinite(value) ? value.toFixed(2) : '?';
}

function formatCountPairs(counts, limit = 8) {
    const entries = Object.entries(counts || {})
        .filter(([name, count]) => name !== 'air' && count > 0);
    if (entries.length === 0)
        return 'none';
    entries.sort((a, b) => b[1] - a[1]);
    const shown = entries.slice(0, limit).map(([name, count]) => `${name}=${count}`);
    if (entries.length > limit)
        shown.push(`+${entries.length - limit} more`);
    return shown.join(', ');
}

function formatBlockPairs(pairs, limit = 10) {
    const filtered = (Array.isArray(pairs) ? pairs : [])
        .filter(([name, count]) => name && !/^(minecraft:)?air$/.test(name) && count > 0);
    if (filtered.length === 0)
        return 'none';
    const shown = filtered.slice(0, limit).map(([name, count]) => `${formatName(name)}=${count}`);
    if (filtered.length > limit)
        shown.push(`+${filtered.length - limit} more`);
    return shown.join(', ');
}

function formatList(values) {
    if (!Array.isArray(values) || values.length === 0)
        return 'none';
    return values.join(', ');
}

async function queryService(endpoint, params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
        search.set(key, String(value));
    const url = `${getServiceUrl()}${endpoint}?${search.toString()}`;
    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
        throw new Error(`cannot reach topography service at ${getServiceUrl()} (${error.message})`);
    }
    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }
    if (!response.ok) {
        const message = payload && payload.error ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
    }
    if (!payload || typeof payload !== 'object')
        throw new Error('service returned an invalid response');
    return payload;
}

async function runQuery(endpoint, params, formatter) {
    try {
        const data = await queryService(endpoint, params);
        return formatter(data);
    } catch (error) {
        return `Topography error: ${error.message}`;
    }
}

function formatTopography(data) {
    const lines = [
        `TOPOGRAPHY ${formatCoordinate(data.from.x, data.from.z)} -> ${formatCoordinate(data.to.x, data.to.z)}: ${data.sample_count} columns, surface y ${formatHeight(data.min_y)}..${formatHeight(data.max_y)}.`
    ];
    const runs = data.runs || [];
    for (const run of runs.slice(0, MAX_RUNS)) {
        const span = run.x1 === run.x2 && run.z1 === run.z2
            ? formatCoordinate(run.x1, run.z1)
            : `${formatCoordinate(run.x1, run.z1)}->${formatCoordinate(run.x2, run.z2)}`;
        lines.push(`- ${span} y=${formatHeight(run.y)} ${formatName(run.material)} (${run.length})`);
    }
    if (runs.length > MAX_RUNS)
        lines.push(`- ... ${runs.length - MAX_RUNS} more runs omitted`);
    const transitions = data.transitions || [];
    if (transitions.length > 0) {
        const shown = transitions.slice(0, MAX_TRANSITIONS)
            .map(t => `${formatCoordinate(t.x, t.z)} ${t.from}->${t.to}`);
        if (transitions.length > MAX_TRANSITIONS)
            shown.push(`+${transitions.length - MAX_TRANSITIONS} more`);
        lines.push(`Shoreline crossings: ${shown.join(', ')}`);
    } else {
        lines.push('No land/water crossings along this line.');
    }
    return pad(lines.join('\n'));
}

function formatAreaComposition(data) {
    const surface = data.surface || {};
    const lines = [
        `AREA_COMPOSITION center=${formatCoordinate(data.center.x, data.center.z)} radius=${data.radius}: ${data.columns} columns, ${data.chunks} chunks, biome ${formatName(data.dominant_biome)}.`,
        `- surface y ${formatHeight(surface.min_y)}..${formatHeight(surface.max_y)} avg ${formatDecimal(surface.avg_y)}, water ${(100 * (surface.water_fraction || 0)).toFixed(1)}%.`,
        `- composition: ${formatCountPairs(data.composition)}.`,
        `- artificiality ${formatDecimal(data.artificiality_score)} (chunk avg ${formatDecimal(data.avg_chunk_artificiality)}).`,
        `- top blocks: ${formatBlockPairs(data.top_blocks)}.`,
        `- strong indicators: ${formatCountPairs(data.strong_indicators)}.`
    ];
    if (Array.isArray(data.engineered_blocks) && data.engineered_blocks.length > 0)
        lines.push(`- built: ${formatBlockPairs(data.engineered_blocks)}.`);
    if (data.highest_ground && Number.isFinite(data.highest_ground.y)) {
        const dx = data.highest_ground.x - data.center.x;
        const dz = data.highest_ground.z - data.center.z;
        const distance = Math.round(Math.hypot(dx, dz));
        lines.push(`- highest ground: (${data.highest_ground.x},${data.highest_ground.z}) y=${formatHeight(data.highest_ground.y)}, ~${distance} blocks from center.`);
    }
    if (data.missing_chunks)
        lines.push(`- missing chunks: ${data.missing_chunks} (not loaded from the save yet).`);
    return pad(lines.join('\n'));
}

function formatShoreline(data) {
    const segments = data.segments || [];
    const lines = [
        `SHORELINE center=${formatCoordinate(data.center.x, data.center.z)} radius=${data.radius}: water_at_center=${Boolean(data.water_at_center)}, ${segments.length} segments, ${data.point_count} points.`
    ];
    if (segments.length === 0)
        lines.push('- no shoreline found in range.');
    let printed = 0;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const points = [];
        for (const [x, z] of segment) {
            if (printed >= MAX_SHORELINE_POINTS)
                break;
            points.push(formatCoordinate(x, z));
            printed += 1;
        }
        if (points.length === 0) {
            lines.push(`- segment ${i + 1}: omitted (point limit reached).`);
            continue;
        }
        const omitted = segment.length - points.length;
        const suffix = omitted > 0 ? ` ... (${omitted} more)` : '';
        lines.push(`- segment ${i + 1}: ${points.join(' ')}${suffix}`);
        if (printed >= MAX_SHORELINE_POINTS)
            break;
    }
    if (printed >= MAX_SHORELINE_POINTS && printed < data.point_count)
        lines.push(`- point limit reached (${MAX_SHORELINE_POINTS} of ${data.point_count} points shown).`);
    if (data.missing_chunks)
        lines.push(`- missing chunks: ${data.missing_chunks}`);
    return pad(lines.join('\n'));
}

function formatRecall(data) {
    const column = data.column || {};
    const surface = data.surface || {};
    const lines = [
        `RECALL ${formatCoordinate(column.x, column.z)} [chunk ${data.chunk.cx},${data.chunk.cz}]: column y=${formatHeight(column.y)} ${formatName(column.material)}${column.water ? ' (water)' : ''}, ground y=${formatHeight(column.ground_y)} ${formatName(column.ground_material)}.`,
        `- chunk surface y ${formatHeight(surface.min_y)}..${formatHeight(surface.max_y)} avg ${formatDecimal(surface.avg_y)}, water columns ${surface.water_columns ?? '?'}.`,
        `- biome ${formatName(data.dominant_biome)}, artificiality ${formatDecimal(data.artificiality_score)}.`,
        `- composition: ${formatCountPairs(data.composition)}.`,
        `- top blocks: ${formatBlockPairs(data.top_blocks)}.`,
        `- strong indicators: ${formatList(data.strong_indicators)}.`
    ];
    if (data.source)
        lines.push(`- source: ${data.source}`);
    return pad(lines.join('\n'));
}

export const topographyList = [
    {
        name: '!topography',
        description: 'Get a 1D surface height/material profile along a line between two coordinates. Use for bridges, roads, or foundations. For highest/lowest ground, area, or direction questions use the automatic TOPOGRAPHY block or !area_composition instead.',
        params: {
            'x1': { type: 'int', description: 'Start x coordinate.' },
            'z1': { type: 'int', description: 'Start z coordinate.' },
            'x2': { type: 'int', description: 'End x coordinate.' },
            'z2': { type: 'int', description: 'End z coordinate.' }
        },
        perform: function (agent, x1, z1, x2, z2) {
            return runQuery('/topography', { x1, z1, x2, z2 }, formatTopography);
        }
    },
    {
        name: '!area_composition',
        description: 'Get a 2D area summary around a coordinate: block composition, biome, surface stats, highest ground, and built/engineered blocks. Use for area, peak, or direction questions.',
        params: {
            'x': { type: 'int', description: 'Center x coordinate.' },
            'z': { type: 'int', description: 'Center z coordinate.' },
            'radius': { type: 'int', description: 'Radius in blocks around the center.', domain: [1, 257, '[)'] }
        },
        perform: function (agent, x, z, radius) {
            return runQuery('/area_composition', { x, z, radius }, formatAreaComposition);
        }
    },
    {
        name: '!shoreline',
        description: 'Get the exact shoreline polyline (list of x,z points) of the nearest water body around a coordinate.',
        params: {
            'x': { type: 'int', description: 'Center x coordinate.' },
            'z': { type: 'int', description: 'Center z coordinate.' },
            'radius': { type: 'int', description: 'Radius in blocks around the center.', domain: [1, 257, '[)'] }
        },
        perform: function (agent, x, z, radius) {
            return runQuery('/shoreline', { x, z, radius }, formatShoreline);
        }
    },
    {
        name: '!recall',
        description: 'Recall the stored topographic summary (surface, biome, composition) for the chunk containing a coordinate that was explored before.',
        params: {
            'x': { type: 'int', description: 'x coordinate to recall.' },
            'z': { type: 'int', description: 'z coordinate to recall.' }
        },
        perform: function (agent, x, z) {
            return runQuery('/recall', { x, z }, formatRecall);
        }
    }
];
