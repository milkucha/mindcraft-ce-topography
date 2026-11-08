import { Vec3 } from 'vec3';
import { findBridgeSpan, planBridge, isWaterBlock } from '../library/bridge_plan.js';
import { formatBridgeSpan } from './topography.js';

// TEMPORARY test aid for the topography A/B runs. `!bridgePlan` answers the same question as
// `!bridgeSpan` but from the blocks the bot has loaded (bot.blockAt) instead of the topography
// service, so an agent without topography can still get a bridge plan. It is only exposed to
// profiles with `local_bridge_plan: true`. Remove it together with that flag when the test is over.

const DIRECTIONS = {
    north: { x: 0, z: -1 },
    south: { x: 0, z: 1 },
    east: { x: 1, z: 0 },
    west: { x: -1, z: 0 },
};
const MAX_SPAN = 96;
const SCAN_UP = 24;
const FALLBACK_MIN_Y = -64;

// Blocks that are walked through or sit on top of the ground, not the ground itself.
function isNotGround(block) {
    return block.boundingBox === 'empty'
        || /_leaves$|_log$|_wood$/.test(block.name);
}

/** Column reader over the bot's loaded world; same `{ y, water }` shape the planner expects. */
export function makeLocalSurface(bot) {
    const cache = new Map();
    const unloadedChunks = new Set();
    const minY = bot.game?.minY ?? FALLBACK_MIN_Y;

    function scan(x, z) {
        const top = Math.floor(bot.entity.position.y) + SCAN_UP;
        for (let y = top; y >= minY; y--) {
            const block = bot.blockAt(new Vec3(x, y, z));
            if (!block) {
                unloadedChunks.add(`${x >> 4},${z >> 4}`);
                return null;
            }
            if (isWaterBlock(block.name)) {
                let bedY = null;
                for (let by = y - 1; by >= minY; by--) {
                    const below = bot.blockAt(new Vec3(x, by, z));
                    if (!below) break;
                    if (!isWaterBlock(below.name) && !isNotGround(below)) {
                        bedY = by;
                        break;
                    }
                }
                return { y, water: true, bed_y: bedY };
            }
            if (!isNotGround(block))
                return { y, water: false };
        }
        return null;
    }

    return {
        get(x, z) {
            const key = `${x},${z}`;
            if (!cache.has(key))
                cache.set(key, scan(x, z));
            return cache.get(key);
        },
        unloadedChunkCount: () => unloadedChunks.size,
    };
}

/** Build the `/bridge_span`-shaped data from the bot's own view and format it like `!bridgeSpan`. */
export function localBridgeSpan(bot, x, z, direction) {
    const name = String(direction || '').toLowerCase();
    const dir = DIRECTIONS[name];
    if (!dir)
        return `Direction must be north, south, east or west (got "${direction}").`;

    const reader = makeLocalSurface(bot);
    const start = { x, z };
    const span = findBridgeSpan({ getSurface: reader.get, start, dir, maxLength: MAX_SPAN });
    const missing = reader.unloadedChunkCount();
    if (span.error) {
        return formatBridgeSpan({
            start, dir: name, span: 0, caution: [span.error], missing_chunks: missing,
        });
    }

    const water = span.water.map(column => {
        const bed = reader.get(column.x, column.z)?.bed_y;
        return {
            x: column.x, z: column.z, y: column.y,
            bed_y: bed ?? null,
            depth: bed == null ? null : column.y - bed,
        };
    });
    const beds = water.map(c => c.bed_y).filter(v => v != null);
    const depths = water.map(c => c.depth).filter(v => v != null);
    const plan = planBridge({ getSurface: reader.get, start, dir, maxLength: MAX_SPAN });

    return formatBridgeSpan({
        start,
        dir: name,
        span: water.length,
        water_y: Math.max(...water.map(c => c.y)),
        bed_y: beds.length ? { min: Math.min(...beds), max: Math.max(...beds) } : null,
        depth: depths.length
            ? { min: Math.min(...depths), max: Math.max(...depths), avg: depths.reduce((a, b) => a + b, 0) / depths.length }
            : null,
        near_shore: span.nearShore,
        far_shore: span.farShore,
        deck_y: plan.error ? null : plan.deckY,
        water,
        caution: [],
        missing_chunks: missing,
    });
}

export const localBridgeList = [
    {
        name: '!bridgePlan',
        description: 'Scan from a shore coordinate in a compass direction using the blocks around you and report the water crossing: near/far shore, water depth, bed height, safe deck y, and a pillar/landing plan. Only sees terrain loaded near you. Use before building a bridge.',
        params: {
            'x': { type: 'int', description: 'Start x coordinate (on the near shore).' },
            'z': { type: 'int', description: 'Start z coordinate (on the near shore).' },
            'direction': { type: 'string', description: 'north, south, east or west.' }
        },
        perform: function (agent, x, z, direction) {
            return localBridgeSpan(agent.bot, x, z, direction);
        }
    }
];
