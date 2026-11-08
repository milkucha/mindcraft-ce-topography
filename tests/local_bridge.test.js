import test from 'node:test';
import assert from 'node:assert/strict';
import { localBridgeSpan } from '../src/agent/commands/local_bridge.js';
import { getCommand, getCommandDocs, executeCommand } from '../src/agent/commands/index.js';

// West-running crossing along z=0: shore x=0 and x=-6 at y=62 (grass), water x=-1..-5 with its
// top at y=62 and a bed that deepens in the middle.
const BED = { '-1': 61, '-2': 59, '-3': 57, '-4': 59, '-5': 61 };

function worldBlock(x, y, z) {
    if (z !== 0) return 'air';
    if (x >= 0 || x <= -6) return y <= 62 ? 'grass_block' : 'air';
    if (y > 62) return 'air';
    if (y === 60 && x === -2) return 'seagrass';
    return y > BED[x] ? 'water' : 'sand';
}

function fakeBot({ loaded = () => true } = {}) {
    return {
        entity: { position: { x: 0, y: 63, z: 0 } },
        game: { minY: 40 },
        blockAt(pos) {
            if (!loaded(pos.x, pos.z)) return null;
            const name = worldBlock(pos.x, pos.y, pos.z);
            return { name, position: pos, boundingBox: name === 'water' || name === 'air' || name === 'seagrass' ? 'empty' : 'block' };
        },
    };
}

function fakeAgent(profile) {
    return { prompter: { profile }, blocked_actions: [], bot: fakeBot() };
}

test('!bridgePlan reports shores, bed depth, deck y and a plan from the loaded world', () => {
    const output = localBridgeSpan(fakeBot(), 0, 0, 'West');
    assert.match(output, /BRIDGE_SPAN from \(0,0\) west: 5 water blocks at y=62, bed y=57\.\.61 \(depth 1\.\.5, avg 2\.60\)/);
    assert.match(output, /near shore \(0,0\) y=62, far shore \(-6,0\) y=62, deck y=64/);
    assert.match(output, /plan: deck 5 blocks at y=64/);
});

test('!bridgePlan reports a missing crossing instead of guessing', () => {
    const output = localBridgeSpan(fakeBot(), 0, 0, 'east');
    assert.match(output, /no water crossing found/);
});

test('!bridgePlan flags terrain that is not loaded', () => {
    const output = localBridgeSpan(fakeBot({ loaded: (x) => x > -3 }), 0, 0, 'west');
    assert.match(output, /missing chunks: \d+/);
    assert.doesNotMatch(output, /far shore \(-6/);
});

test('!bridgePlan rejects an unknown direction', () => {
    assert.match(localBridgeSpan(fakeBot(), 0, 0, 'up'), /Direction must be/);
});

test('!bridgePlan is only available to profiles with local_bridge_plan', async () => {
    assert.ok(getCommand('!bridgePlan'));
    const on = fakeAgent({ topography_enabled: false, local_bridge_plan: true });
    const off = fakeAgent({ topography_enabled: false });
    assert.match(getCommandDocs(on), /!bridgePlan/);
    assert.doesNotMatch(getCommandDocs(off), /!bridgePlan/);
    assert.match(await executeCommand(off, '!bridgePlan(0, 0, "west")'), /disabled for this agent/);
    assert.match(await executeCommand(on, '!bridgePlan(0, 0, "west")'), /BRIDGE_SPAN/);
});

test('!bridgePlan does not re-enable the topography commands', async () => {
    const agent = fakeAgent({ topography_enabled: false, local_bridge_plan: true });
    assert.doesNotMatch(getCommandDocs(agent), /!bridgeSpan/);
    assert.match(await executeCommand(agent, '!bridgeSpan(0, 0, "west")'), /disabled for this agent/);
});
