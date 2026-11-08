import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rmSync } from 'node:fs';
import {
    normalizeDimension, getDimension, isOverworld, terrainUnavailableMessage,
    fetchPerception, pushPosition, resetPushState, clearPerceptionCache,
    formatPerception, pushPositionIfMoved
} from '../src/agent/topography_service.js';
import { History, compactStaleTerrain } from '../src/agent/history.js';

function agentIn(dimension, x = 10, z = 10) {
    return { bot: { game: { dimension }, entity: { position: { x, y: 64, z } } } };
}

async function withServer(handler, fn) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ method: req.method, url: req.url, body });
        const out = handler(req) ?? {};
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(out));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const previous = process.env.TOPOGRAPHY_SERVICE_URL;
    process.env.TOPOGRAPHY_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    try {
        await fn(requests);
    } finally {
        if (previous === undefined) delete process.env.TOPOGRAPHY_SERVICE_URL;
        else process.env.TOPOGRAPHY_SERVICE_URL = previous;
        await new Promise(resolve => server.close(resolve));
    }
}

test('normalizeDimension handles the common spellings', () => {
    assert.equal(normalizeDimension('overworld'), 'minecraft:overworld');
    assert.equal(normalizeDimension('minecraft:overworld'), 'minecraft:overworld');
    assert.equal(normalizeDimension('the_nether'), 'minecraft:the_nether');
    assert.equal(normalizeDimension('nether'), 'minecraft:the_nether');
    assert.equal(normalizeDimension('The_End'), 'minecraft:the_end');
    assert.equal(normalizeDimension(undefined), null);
    assert.equal(getDimension(agentIn('overworld')), 'minecraft:overworld');
});

test('overworld guard and message', () => {
    assert.equal(isOverworld(agentIn('minecraft:overworld')), true);
    assert.equal(isOverworld({}), true);
    assert.equal(terrainUnavailableMessage(agentIn('overworld')), null);
    assert.match(terrainUnavailableMessage(agentIn('the_nether')), /only available in the overworld/);
});

test('perception sends dimension; nether makes no request; unavailable injects nothing', async () => {
    await withServer(() => ({ service: 'topography', unavailable: 'dimension' }), async requests => {
        clearPerceptionCache();
        assert.equal(await fetchPerception(agentIn('overworld'), { enabled: true }), '');
        assert.equal(requests.length, 1);
        assert.match(requests[0].url, /dimension=minecraft%3Aoverworld/);
        clearPerceptionCache();
        assert.equal(await fetchPerception(agentIn('the_nether'), { enabled: true }), '');
        assert.equal(requests.length, 1, 'nether must not hit the service');
    });
    assert.equal(formatPerception({ service: 'topography', unavailable: 'dimension' }), '');
});

test('position push carries dimension and is skipped outside the overworld', async () => {
    await withServer(() => ({ accepted: true }), async requests => {
        resetPushState();
        pushPosition(agentIn('overworld', 100, 100), { enabled: true });
        await new Promise(r => setTimeout(r, 100));
        assert.equal(requests.length, 1);
        assert.equal(JSON.parse(requests[0].body).dimension, 'minecraft:overworld');
        resetPushState();
        pushPositionIfMoved(agentIn('the_end', 500, 500), { enabled: true });
        await new Promise(r => setTimeout(r, 100));
        assert.equal(requests.length, 1);
    });
});

test('composition percentages sum over shown categories and never list air', () => {
    const block = formatPerception({
        center: { x: 0, z: 0 }, size_chunks: 16, lod: [],
        composition: {
            natural: 300, engineered: 100, liquid: 100, air: 5000,
            top_blocks: [['minecraft:air', 5000], ['minecraft:cave_air', 100], ['minecraft:stone', 200]]
        }
    });
    assert.match(block, /natural 60%, engineered 20%, water 20%; top: stone/);
    assert.doesNotMatch(block, /air/);
    const third = formatPerception({ center: { x: 0, z: 0 }, lod: [], composition: { natural: 1, engineered: 1, liquid: 1 } });
    assert.match(third, /natural 34%, engineered 33%, water 33%/);
});

test('compactStaleTerrain stubs terrain turns only', () => {
    const turns = [
        { role: 'system', content: 'SHORELINE result: ...long...' },
        { role: 'system', content: 'Command output: fine' },
        { role: 'user', content: 'SHORELINE is a word' }
    ];
    assert.equal(compactStaleTerrain(turns, { all: true }), 1);
    assert.match(turns[0].content, /^\[earlier SHORELINE result omitted .* re-run the command if needed\]$/);
    assert.equal(turns[1].content, 'Command output: fine');
    assert.equal(compactStaleTerrain(turns, { all: true }), 0, 'stubs are not terrain turns again');
});

test('History stubs live terrain results after the next assistant turn and after moving', async () => {
    const name = `P0TestBot${process.pid}`;
    const agent = { name, bot: { entity: { position: { x: 0, y: 64, z: 0 } } } };
    try {
        const history = new History(agent);
        await history.add('system', 'TOPOGRAPHY line profile ...');
        await history.add('system', 'AREA_COMPOSITION ...');
        assert.match(history.turns[0].content, /^TOPOGRAPHY/);
        await history.add(name, 'Got it, building.');
        assert.match(history.turns[0].content, /earlier TOPOGRAPHY result omitted/);
        assert.match(history.turns[1].content, /earlier AREA_COMPOSITION result omitted/);
        assert.equal(history.turns[2].content, 'Got it, building.');

        await history.add('system', 'SHORELINE segments ...');
        agent.bot.entity.position.x = 10;
        await history.add('user', 'hello'); // moved 10 blocks: still fresh
        assert.match(history.turns.at(-2).content, /^SHORELINE/);
        agent.bot.entity.position.x = 40;
        await history.add('user', 'hello again'); // moved 40 blocks
        assert.match(history.turns.at(-3).content, /earlier SHORELINE result omitted/);
    } finally {
        rmSync(`./bots/${name}`, { recursive: true, force: true });
    }
});
