import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../src/agent/commands/index.js', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');

test('new terrain commands are registered as topography commands', () => {
    const set = index.match(/TOPOGRAPHY_COMMANDS = new Set\(\[([^\]]*)\]/s)[1];
    for (const name of ['!flatAreas', '!bridgeSpan', '!topography', '!recall'])
        assert.ok(set.includes(`'${name}'`), name);
});

test('commands are guarded outside the overworld and agent pushes position on update', () => {
    assert.match(index, /terrainUnavailableMessage\(agent\)/);
    assert.match(agent, /pushPositionIfMoved\(this\)/);
});
