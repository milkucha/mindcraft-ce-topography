import settings from './settings.js';

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8090';
const DEFAULT_SIZE_CHUNKS = 16;
const DEFAULT_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 1000;
const MAX_BLOCK_CHARS = 1000;
const PUSH_INTERVAL_MS = 2000;

const cache = new Map();
let lastPushKey = null;
let lastPushAt = 0;

export function getServiceUrl() {
    const configured = globalThis.process?.env?.TOPOGRAPHY_SERVICE_URL
        || settings.topography_service_url
        || DEFAULT_SERVICE_URL;
    return configured.replace(/\/+$/, '');
}

export function clearPerceptionCache() {
    cache.clear();
}

export function resetPushState() {
    lastPushKey = null;
    lastPushAt = 0;
}

function isEnabled(opts) {
    if (opts.enabled !== undefined)
        return opts.enabled !== false;
    if (settings.topography_enabled === false)
        return false;
    return (settings.topography_perception ?? true) !== false;
}

function resolvePosition(agent, opts) {
    const directX = opts.x ?? opts.center?.x;
    const directZ = opts.z ?? opts.center?.z;
    if (Number.isFinite(directX) && Number.isFinite(directZ))
        return { x: Math.floor(directX), z: Math.floor(directZ) };
    const position = agent?.bot?.entity?.position;
    if (Number.isFinite(position?.x) && Number.isFinite(position?.z))
        return { x: Math.floor(position.x), z: Math.floor(position.z) };
    return null;
}

function formatName(name) {
    if (!name)
        return 'unknown';
    return String(name).replace(/^minecraft:/, '');
}

function formatHeight(value) {
    return Number.isFinite(value) ? String(Math.round(value)) : '?';
}

function formatDecimal(value) {
    if (!Number.isFinite(value))
        return '?';
    return String(Math.round(value * 100) / 100);
}

function levelRows(level, index) {
    const size = Number(level?.cells_per_side);
    if (!Number.isInteger(size) || size <= 0)
        return null;
    const heights = Array.isArray(level.heights) ? level.heights : [];
    const water = Array.isArray(level.water) ? level.water : [];
    if (index === 0) {
        const heightRows = [];
        const waterRows = [];
        for (let row = 0; row < size; row++) {
            heightRows.push(heights.slice(row * size, (row + 1) * size));
            waterRows.push(water.slice(row * size, (row + 1) * size));
        }
        return { heightRows, waterRows };
    }
    const heightRows = [heights.slice(0, size)];
    const waterRows = [water.slice(0, size)];
    for (let row = 1; row < size - 1; row++) {
        heightRows.push([heights[row * size], heights[row * size + size - 1]]);
        waterRows.push([water[row * size], water[row * size + size - 1]]);
    }
    heightRows.push(heights.slice((size - 1) * size, size * size));
    waterRows.push(water.slice((size - 1) * size, size * size));
    return { heightRows, waterRows };
}

function formatRows(rows) {
    return rows
        .map(row => row.map(formatHeight).join(' '))
        .join(' / ');
}

function formatWaterRows(rows) {
    return rows
        .map(row => row.map(value => Number(value) ? '1' : '0').join(' '))
        .join(' / ');
}

function formatLevelLabel(level, index) {
    const chunks = Number(level?.cell_chunks) || 1;
    return `${index === 0 ? 'inner' : 'ring'} ${chunks}ch/cell`;
}

function formatComposition(composition) {
    if (!composition || typeof composition !== 'object')
        return null;
    const parts = [];
    const natural = Number(composition.natural) || 0;
    const engineered = Number(composition.engineered) || 0;
    const liquid = Number(composition.liquid) || 0;
    const air = Number(composition.air) || 0;
    const total = natural + engineered + liquid + air;
    if (total > 0) {
        const percent = value => Math.round((100 * value) / total);
        parts.push(`natural ${percent(natural)}%, engineered ${percent(engineered)}%, water ${percent(liquid)}%`);
    }
    const topBlocks = Array.isArray(composition.top_blocks) ? composition.top_blocks : [];
    const top = topBlocks
        .filter(pair => Array.isArray(pair) && pair[0] && (!Number.isFinite(pair[1]) || pair[1] > 0))
        .slice(0, 3)
        .map(pair => formatName(pair[0]));
    if (top.length > 0)
        parts.push(`top: ${top.join(', ')}`);
    if (Number.isFinite(composition.artificiality_score))
        parts.push(`artificiality ${formatDecimal(composition.artificiality_score)}`);
    const engineeredBlocks = Array.isArray(composition.engineered_blocks)
        ? composition.engineered_blocks
        : [];
    const built = engineeredBlocks
        .filter(pair => Array.isArray(pair) && pair[0])
        .slice(0, 4)
        .map(pair => `${formatName(pair[0])} ${Number(pair[1]) || 0}`);
    if (built.length > 0)
        parts.push(`built: ${built.join(', ')}`);
    return parts.length > 0 ? parts.join('; ') : null;
}

function truncateBlock(block) {
    if (block.length <= MAX_BLOCK_CHARS)
        return block;
    const suffix = '\n... (truncated)';
    return block.slice(0, MAX_BLOCK_CHARS - suffix.length) + suffix;
}

export function formatPerception(data) {
    if (!data || typeof data !== 'object')
        return '';
    const center = data.center || {};
    const x = Number.isFinite(center.x) ? Math.floor(center.x) : 0;
    const z = Number.isFinite(center.z) ? Math.floor(center.z) : 0;
    const size = Number.isFinite(data.size_chunks) ? data.size_chunks : DEFAULT_SIZE_CHUNKS;
    const levels = Array.isArray(data.lod) ? data.lod : [];
    const lines = [];
    const cellSizes = levels.map(level => Number(level?.cell_chunks) || 1);
    const lodLabel = cellSizes.length > 0
        ? `${cellSizes.length === 1 ? 'level' : 'levels'} ${cellSizes.join('/')} chunks per cell`
        : 'no LOD data';
    lines.push(`TOPOGRAPHY ${size}x${size} chunks centered at (${x},${z}), LOD ${lodLabel}`);
    lines.push('compass: north=-Z, south=+Z, east=+X, west=-X; rows run north -> south');

    const heightLines = [];
    const waterLines = [];
    for (let index = 0; index < levels.length; index++) {
        const rows = levelRows(levels[index], index);
        if (!rows)
            continue;
        const label = formatLevelLabel(levels[index], index);
        if (rows.heightRows.some(row => row.length > 0))
            heightLines.push(`  ${label}: ${formatRows(rows.heightRows)}`);
        if (rows.waterRows.some(row => row.length > 0))
            waterLines.push(`  ${label}: ${formatWaterRows(rows.waterRows)}`);
    }
    if (heightLines.length > 0) {
        lines.push('heights (NW->SE, y):');
        lines.push(...heightLines);
    }
    if (waterLines.length > 0) {
        lines.push('water (0 land, 1 water):');
        lines.push(...waterLines);
    }

    const water = data.water;
    if (water && typeof water === 'object') {
        const centerLabel = water.at_center ? 'water' : 'land';
        const nearest = water.nearest;
        if (nearest && Number.isFinite(nearest.distance)) {
            lines.push(`nearest water: ${nearest.direction || 'unknown'}, ${Math.round(nearest.distance)} blocks; center: ${centerLabel}`);
        } else {
            lines.push(`nearest water: none; center: ${centerLabel}`);
        }
    }

    const surface = data.surface || {};
    const relief = Number.isFinite(surface.relief)
        ? surface.relief
        : (Number.isFinite(surface.max_y) && Number.isFinite(surface.min_y) ? surface.max_y - surface.min_y : null);
    const reliefPart = Number.isFinite(relief) ? `relief: ${formatHeight(relief)}; ` : '';
    lines.push(`${reliefPart}biome: ${formatName(data.biome)}`);

    const terrain = data.terrain || {};
    const highest = terrain.highest;
    if (highest && Number.isFinite(highest.y)) {
        const direction = highest.direction || 'here';
        const where = direction === 'here'
            ? 'at center'
            : `${direction}, ~${Math.round(highest.distance)} blocks`;
        lines.push(`highest ground: ${where}, y=${formatHeight(highest.y)}`);
    }
    const byDirection = terrain.highest_by_direction;
    if (byDirection && typeof byDirection === 'object') {
        const short = {
            north: 'N', northeast: 'NE', east: 'E', southeast: 'SE',
            south: 'S', southwest: 'SW', west: 'W', northwest: 'NW'
        };
        const order = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
        const parts = order
            .filter(d => byDirection[d] && Number.isFinite(byDirection[d].y))
            .map(d => `${short[d]} ${formatHeight(byDirection[d].y)}`);
        if (parts.length > 0)
            lines.push(`highest by direction: ${parts.join(' ')}`);
    }

    const composition = formatComposition(data.composition);
    if (composition)
        lines.push(`composition: ${composition}`);

    if (Number(data.missing_chunks) > 0)
        lines.push(`missing: ${data.missing_chunks} chunks`);

    return truncateBlock(lines.join('\n'));
}

function buildUrl(position, opts) {
    const search = new URLSearchParams();
    search.set('x', String(position.x));
    search.set('z', String(position.z));
    const size = opts.size ?? opts.size_chunks ?? settings.topography_render_chunks ?? DEFAULT_SIZE_CHUNKS;
    search.set('size_chunks', String(size));
    const materials = opts.materials ?? settings.topography_perception_materials ?? false;
    if (materials)
        search.set('materials', '1');
    return `${getServiceUrl()}/perception?${search.toString()}`;
}

async function requestPerception(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
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
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchPerception(agent, opts = {}) {
    if (!isEnabled(opts)) {
        if (opts.debug)
            console.log('[topography] perception disabled for this agent');
        return '';
    }
    const position = resolvePosition(agent, opts);
    if (!position)
        return '';
    const size = opts.size ?? opts.size_chunks ?? settings.topography_render_chunks ?? DEFAULT_SIZE_CHUNKS;
    const key = `${position.x},${position.z},${size}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        if (opts.debug)
            console.log(`[topography] cache hit x=${position.x} z=${position.z} size=${size} chars=${cached.value.length}`);
        return cached.value;
    }
    if (cached)
        cache.delete(key);
    const timeoutMs = opts.timeout_ms ?? opts.timeoutMs ?? settings.topography_perception_timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const url = buildUrl(position, opts);
    const started = Date.now();
    try {
        const data = await requestPerception(url, timeoutMs);
        const formatted = formatPerception(data);
        if (formatted)
            cache.set(key, { value: formatted, expiresAt: Date.now() + CACHE_TTL_MS });
        if (opts.debug) {
            console.log(
                `[topography] perception ok x=${position.x} z=${position.z} size=${size} ` +
                `ms=${Date.now() - started} chars=${formatted.length} ` +
                `missing=${data.missing_chunks} version=${data.window_version} url=${url}`
            );
        }
        return formatted;
    } catch (error) {
        const message = error?.message || error;
        if (opts.debug) {
            console.warn(
                `[topography] perception failed x=${position.x} z=${position.z} size=${size} ` +
                `ms=${Date.now() - started} url=${url}: ${message}`
            );
        } else {
            console.warn(`Topography perception unavailable: ${message}`);
        }
        return '';
    }
}

export function pushPosition(agent, opts = {}) {
    if (!isEnabled(opts)) {
        if (opts.debug)
            console.log('[topography] position push disabled for this agent');
        return;
    }
    const position = resolvePosition(agent, opts);
    if (!position)
        return;
    const size = opts.size ?? opts.size_chunks ?? settings.topography_render_chunks ?? DEFAULT_SIZE_CHUNKS;
    const key = `${Math.floor(position.x / 16)},${Math.floor(position.z / 16)},${size}`;
    const now = Date.now();
    if (key === lastPushKey && now - lastPushAt < PUSH_INTERVAL_MS)
        return;
    lastPushKey = key;
    lastPushAt = now;
    const body = JSON.stringify({ x: position.x, z: position.z, size_chunks: size });
    const url = `${getServiceUrl()}/position`;
    try {
        const request = fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        });
        if (opts.debug) {
            request.then(response => {
                console.log(
                    `[topography] position push x=${position.x} z=${position.z} size=${size} ` +
                    `status=${response.status} url=${url}`
                );
            }).catch(error => {
                console.warn(
                    `[topography] position push failed x=${position.x} z=${position.z} size=${size} ` +
                    `url=${url}: ${error?.message || error}`
                );
            });
        } else {
            request.catch(() => {});
        }
    } catch (error) {
        if (opts.debug)
            console.warn(`[topography] position push error: ${error?.message || error}`);
        // Fire-and-forget: a failed prefetch must never affect prompting.
    }
}
