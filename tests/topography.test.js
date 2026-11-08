import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const fixtures = {
    '/topography': {
        from: { x: 10, z: 8 },
        to: { x: 22, z: 8 },
        sample_count: 13,
        min_y: 63,
        max_y: 66,
        runs: [
            { x1: 10, z1: 8, x2: 15, z2: 8, y: 65, material: 'minecraft:grass_block', length: 6 },
            { x1: 16, z1: 8, x2: 22, z2: 8, y: 63, material: 'minecraft:water', length: 7 }
        ],
        transitions: [{ x: 16, z: 8, from: 'land', to: 'water' }]
    },
    '/area_composition': {
        center: { x: 8, z: 8 },
        radius: 6,
        columns: 113,
        chunks: 1,
        missing_chunks: 0,
        dominant_biome: 'minecraft:plains',
        surface: { min_y: 64, max_y: 66, avg_y: 65, water_fraction: 0 },
        composition: { natural: 4096, engineered: 12 },
        artificiality_score: 0.0029,
        avg_chunk_artificiality: 0.0029,
        top_blocks: [['minecraft:stone', 2048]],
        strong_indicators: { 'minecraft:chest': 1 }
    },
    '/shoreline': {
        center: { x: 10, z: 8 },
        radius: 8,
        water_at_center: false,
        segments: [[[16, 0], [16, 8], [16, 16]]],
        point_count: 3,
        missing_chunks: 0
    },
    '/recall': {
        chunk: { cx: 0, cz: 0 },
        column: {
            x: 10,
            z: 8,
            y: 65,
            material: 'minecraft:grass_block',
            ground_y: 65,
            ground_material: 'minecraft:grass_block',
            water: false
        },
        surface: { min_y: 64, max_y: 66, avg_y: 65, water_columns: 0 },
        dominant_biome: 'minecraft:plains',
        artificiality_score: 0,
        composition: { natural: 4096, engineered: 0 },
        top_blocks: [['minecraft:grass_block', 256]],
        strong_indicators: [],
        source: 'cold'
    }
};

let server;
let baseUrl;
let commands;
let topographyList;

test.before(async () => {
    commands = await import('../src/agent/commands/index.js');
    ({ topographyList } = await import('../src/agent/commands/topography.js'));
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/area_composition' && url.searchParams.get('x') === '500') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'boom' }));
            return;
        }
        const fixture = fixtures[url.pathname];
        if (!fixture) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown endpoint' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fixture));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    globalThis.process.env.TOPOGRAPHY_SERVICE_URL = baseUrl;
});

test.after(async () => {
    delete globalThis.process.env.TOPOGRAPHY_SERVICE_URL;
    await new Promise(resolve => server.close(resolve));
});

function command(name) {
    const entry = topographyList.find(item => item.name === name);
    assert.ok(entry, `missing command ${name}`);
    return entry;
}

test('topography commands are registered and documented', () => {
    for (const name of ['!topography', '!area_composition', '!shoreline', '!recall']) {
        assert.equal(commands.commandExists(name), true, `${name} not registered`);
    }
    const docs = commands.getCommandDocs({ blocked_actions: [] });
    for (const name of ['!topography', '!area_composition', '!shoreline', '!recall']) {
        assert.match(docs, new RegExp(name.replace('!', '\\!')));
    }
    const parsed = commands.parseCommandMessage('!shoreline(8, 8, 16)');
    assert.deepEqual(parsed.args, [8, 8, 16]);
});

test('!topography formats runs and shoreline crossings', async () => {
    const output = await command('!topography').perform(null, 10, 8, 22, 8);
    assert.match(output, /TOPOGRAPHY \(10,8\) -> \(22,8\): 13 columns, surface y 63\.\.66/);
    assert.match(output, /\(10,8\)->\(15,8\) y=65 grass_block \(6\)/);
    assert.match(output, /\(16,8\)->\(22,8\) y=63 water \(7\)/);
    assert.match(output, /Shoreline crossings: \(16,8\) land->water/);
});

test('!area_composition formats composition and indicators', async () => {
    const output = await command('!area_composition').perform(null, 8, 8, 6);
    assert.match(output, /AREA_COMPOSITION center=\(8,8\) radius=6: 113 columns/);
    assert.match(output, /biome plains/);
    assert.match(output, /top blocks: stone=2048/);
    assert.match(output, /strong indicators: minecraft:chest=1/);
});

test('!shoreline formats polyline coordinates', async () => {
    const output = await command('!shoreline').perform(null, 10, 8, 8);
    assert.match(output, /SHORELINE center=\(10,8\) radius=8: water_at_center=false/);
    assert.match(output, /segment 1: \(16,0\) \(16,8\) \(16,16\)/);
});

test('!recall formats cold-storage summary', async () => {
    const output = await command('!recall').perform(null, 10, 8);
    assert.match(output, /RECALL \(10,8\) \[chunk 0,0\]/);
    assert.match(output, /column y=65 grass_block/);
    assert.match(output, /source: cold/);
    assert.match(output, /strong indicators: none/);
});

test('service errors are surfaced as compact text', async () => {
    const output = await command('!area_composition').perform(null, 500, 0, 1);
    assert.equal(output, 'Topography error: boom');

    const previous = globalThis.process.env.TOPOGRAPHY_SERVICE_URL;
    globalThis.process.env.TOPOGRAPHY_SERVICE_URL = 'http://127.0.0.1:1';
    try {
        const unreachable = await command('!topography').perform(null, 0, 0, 1, 1);
        assert.match(unreachable, /Topography error: cannot reach topography service/);
    } finally {
        globalThis.process.env.TOPOGRAPHY_SERVICE_URL = previous;
    }
});
