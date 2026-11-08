import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import settings from '../src/agent/settings.js';
import { botDir, worldName } from '../src/utils/botpaths.js';
import { validateNameFormat } from '../src/agent/connection_handler.js';

const load = f => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const P = { A: load('agent_a.json'), B: load('agent_b.json'), C: load('agent_c.json'), D: load('agent_d.json') };

test('botDir keeps the legacy layout without a world and namespaces with one', () => {
    const saved = { env: process.env.MINDCRAFT_WORLD, set: settings.world_name };
    try {
        delete process.env.MINDCRAFT_WORLD; settings.world_name = '';
        assert.equal(botDir('Bot'), './bots/Bot');
        settings.world_name = 'survival 1';
        assert.equal(worldName(), 'survival_1');
        assert.equal(botDir('Bot'), './bots/Bot/worlds/survival_1');
        process.env.MINDCRAFT_WORLD = '../evil';
        assert.equal(botDir('Bot'), './bots/Bot/worlds/_evil'); // no path traversal
        assert.ok(!botDir('Bot').includes('..'));
    } finally {
        if (saved.env === undefined) delete process.env.MINDCRAFT_WORLD; else process.env.MINDCRAFT_WORLD = saved.env;
        settings.world_name = saved.set;
    }
});

test('A/B/C/D: valid unique names, one shared chat model', () => {
    const names = Object.values(P).map(p => p.name);
    assert.equal(new Set(names).size, 4);
    for (const n of names) assert.ok(validateNameFormat(n).success, n);
    assert.equal(new Set(Object.values(P).map(p => p.model)).size, 1);
});

test('A and B are vanilla: every fork feature off and upstream prompts', () => {
    for (const p of [P.A, P.B]) {
        assert.equal(p.topography_enabled, false);
        assert.equal(p.memory_archive, false);
        assert.equal(p.memory_auto_observe, false);
        assert.equal(p.idle_chat, false);
        assert.equal(p.long_task_notice, false);
        for (const k of ['conversing', 'coding', 'saving_memory'])
            assert.doesNotMatch(p[k], /\$(TOPOGRAPHY|TOPO_GUIDE|RECALL|PLACES|CORE_CHARS)/, `${p.name}.${k}`);
    }
});

test('C and D run the full pipeline with the fork prompts, D and B add vision', () => {
    for (const p of [P.C, P.D]) {
        for (const off of ['topography_enabled', 'memory_archive', 'idle_chat', 'long_task_notice'])
            assert.notEqual(p[off], false, off);
        for (const k of ['conversing', 'coding', 'saving_memory']) assert.equal(p[k], undefined);
    }
    assert.equal(P.A.allow_vision, false);
    assert.equal(P.C.allow_vision, false);
    for (const p of [P.B, P.D]) { assert.equal(p.allow_vision, true); assert.ok(p.vision_model); }
    assert.equal(P.B.vision_model, P.D.vision_model);
});
