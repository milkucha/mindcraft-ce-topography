import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import settings from '../src/agent/settings.js';
import {
    getServiceUrl,
    fetchPerception,
    formatPerception,
    clearPerceptionCache
} from '../src/agent/topography_service.js';
import { Prompter } from '../src/models/prompter.js';

const perceptionFixture = {
    service: 'topography',
    center: { x: 120, z: -46 },
    size_chunks: 16,
    window: { cx1: 7, cz1: -49, cx2: 22, cz2: -34 },
    resolution: 'lod',
    lod: [
        {
            cell_chunks: 1,
            cells_per_side: 4,
            cx1: 7,
            cz1: -49,
            heights: [64, 65, 66, 67, 65, 66, 66, 67, 64, 65, 66, 67, 64, 65, 66, 67],
            water: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        },
        {
            cell_chunks: 2,
            cells_per_side: 4,
            cx1: 5,
            cz1: -47,
            heights: [64, 65, 67, 68, 64, 66, 67, 69, 63, 65, 68, 70, 63, 65, 69, 71],
            water: [0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]
        },
        {
            cell_chunks: 4,
            cells_per_side: 4,
            cx1: 1,
            cz1: -43,
            heights: [63, 65, 70, 72, 63, 66, 71, 73, 64, 67, 72, 74, 64, 68, 73, 75],
            water: [0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        }
    ],
    surface: { min_y: 63, max_y: 78, avg_y: 68.4, relief: 15 },
    water: { at_center: false, nearest: { dx: 48, dz: 0, distance: 48, direction: 'east' } },
    biome: 'minecraft:plains',
    composition: {
        natural: 12345,
        engineered: 120,
        liquid: 800,
        air: 0,
        water_fraction: 0.06,
        top_blocks: [
            ['minecraft:stone', 5000],
            ['minecraft:grass_block', 3200],
            ['minecraft:oak_planks', 100]
        ],
        artificiality_score: 0.01
    },
    missing_chunks: 0,
    updated_at: 1699999999.0,
    window_version: 42
};

let server;
let baseUrl;
let requestCount;
let previousEnv;
let previousUrlSetting;

test.before(async () => {
    requestCount = 0;
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/perception') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown endpoint' }));
            return;
        }
        requestCount += 1;
        const x = url.searchParams.get('x');
        if (x === '500') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'boom' }));
            return;
        }
        if (x === '599') {
            const timer = setTimeout(() => {
                if (!res.writableEnded) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(perceptionFixture));
                }
            }, 500);
            res.on('close', () => clearTimeout(timer));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(perceptionFixture));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    previousEnv = process.env.TOPOGRAPHY_SERVICE_URL;
    previousUrlSetting = settings.topography_service_url;
    process.env.TOPOGRAPHY_SERVICE_URL = baseUrl;
    clearPerceptionCache();
});

test.after(async () => {
    if (previousEnv === undefined)
        delete process.env.TOPOGRAPHY_SERVICE_URL;
    else
        process.env.TOPOGRAPHY_SERVICE_URL = previousEnv;
    if (previousUrlSetting === undefined)
        delete settings.topography_service_url;
    else
        settings.topography_service_url = previousUrlSetting;
    delete settings.topography_perception;
    clearPerceptionCache();
    await new Promise(resolve => server.close(resolve));
});

test('getServiceUrl prefers env, then settings, then the default', () => {
    const savedEnv = process.env.TOPOGRAPHY_SERVICE_URL;
    const savedSetting = settings.topography_service_url;
    try {
        delete process.env.TOPOGRAPHY_SERVICE_URL;
        delete settings.topography_service_url;
        assert.equal(getServiceUrl(), 'http://127.0.0.1:8090');
        settings.topography_service_url = 'http://settings.test:9000/';
        assert.equal(getServiceUrl(), 'http://settings.test:9000');
        process.env.TOPOGRAPHY_SERVICE_URL = 'http://env.test:9001/';
        assert.equal(getServiceUrl(), 'http://env.test:9001');
    } finally {
        if (savedEnv === undefined)
            delete process.env.TOPOGRAPHY_SERVICE_URL;
        else
            process.env.TOPOGRAPHY_SERVICE_URL = savedEnv;
        if (savedSetting === undefined)
            delete settings.topography_service_url;
        else
            settings.topography_service_url = savedSetting;
    }
});

test('formatPerception renders a compact LOD block within budget', () => {
    const block = formatPerception(perceptionFixture);
    assert.match(block, /^TOPOGRAPHY 16x16 chunks centered at \(120,-46\), LOD levels 1\/2\/4 chunks per cell/);
    assert.match(block, /heights \(NW->SE, y\):/);
    assert.match(block, /inner 1ch\/cell: 64 65 66 67 \/ 65 66 66 67/);
    assert.match(block, /ring 2ch\/cell: 64 65 67 68/);
    assert.match(block, /ring 4ch\/cell: 63 65 70 72/);
    assert.match(block, /water \(0 land, 1 water\):/);
    assert.match(block, /nearest water: east, 48 blocks; center: land/);
    assert.match(block, /relief: 15; biome: plains/);
    assert.match(block, /composition: natural 93%, engineered 1%, water 6%; top: stone, grass_block, oak_planks; artificiality 0\.01/);
    assert.ok(block.length <= 1000, `block was ${block.length} characters`);
    assert.doesNotMatch(block, /minecraft:/);
});

test('fetchPerception returns the formatted block from the service', async () => {
    clearPerceptionCache();
    const block = await fetchPerception(null, { x: 120, z: -46, size: 16 });
    assert.match(block, /^TOPOGRAPHY 16x16 chunks centered at \(120,-46\)/);
    assert.match(block, /biome: plains/);
});

test('failure and timeout return an empty string without throwing', async () => {
    clearPerceptionCache();
    const failed = await fetchPerception(null, { x: 500, z: 0, size: 16 });
    assert.equal(failed, '');

    clearPerceptionCache();
    const timedOut = await fetchPerception(null, { x: 599, z: 0, size: 16, timeout_ms: 50 });
    assert.equal(timedOut, '');
});

test('disabled perception returns an empty string', async () => {
    clearPerceptionCache();
    const saved = settings.topography_perception;
    settings.topography_perception = false;
    try {
        const block = await fetchPerception(null, { x: 123, z: 45, size: 16 });
        assert.equal(block, '');
    } finally {
        if (saved === undefined)
            delete settings.topography_perception;
        else
            settings.topography_perception = saved;
    }
});

test('perception requests are cached for one second', async () => {
    clearPerceptionCache();
    const before = requestCount;
    const first = await fetchPerception(null, { x: 200, z: -46, size: 16 });
    const second = await fetchPerception(null, { x: 200, z: -46, size: 16 });
    assert.equal(first, second);
    assert.ok(first.length > 0);
    assert.equal(requestCount - before, 1);
    clearPerceptionCache();
});

test('replaceStrings injects the perception block into the prompt', async () => {
    clearPerceptionCache();
    const agent = {
        name: 'tester',
        bot: { entity: { position: { x: 120, y: 64, z: -46 } } }
    };
    const prompter = Object.create(Prompter.prototype);
    prompter.agent = agent;
    prompter.profile = {};
    const prompt = await prompter.replaceStrings('$TOPOGRAPHY', []);
    assert.match(prompt, /TOPOGRAPHY 16x16 chunks centered at \(120,-46\)/);
    assert.match(prompt, /composition:/);

    const saved = settings.topography_perception;
    settings.topography_perception = false;
    try {
        const disabled = await prompter.replaceStrings('$TOPOGRAPHY', []);
        assert.equal(disabled, '');
    } finally {
        if (saved === undefined)
            delete settings.topography_perception;
        else
            settings.topography_perception = saved;
    }
});
