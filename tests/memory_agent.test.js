import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { MemoryManager } from '../src/agent/memory/index.js';
import { MemoryBank } from '../src/agent/memory_bank.js';
import { SeenReporter } from '../src/agent/memory/seen.js';
import { ObservationWatcher } from '../src/agent/memory/observer.js';
import { getCommand, parseCommandMessage } from '../src/agent/commands/index.js';
import { History } from '../src/agent/history.js';
import { Prompter } from '../src/models/prompter.js';
import { formatPerception, terrainAgentName, fetchPerception, clearPerceptionCache } from '../src/agent/topography_service.js';
import settings from '../src/agent/settings.js';

function fakeAgent(over = {}) {
    const agent = {
        name: 'Bot', last_sender: 'Alice', prompter: { profile: {} },
        bot: { entity: { position: { x: 0, y: 64, z: 0 } }, time: { age: 24000 * 12 }, game: { dimension: 'overworld' } },
        ...over,
    };
    agent.memory = MemoryManager.create(agent, { path: ':memory:', backend: 'jsonl' });
    return agent;
}
const run = (agent, name, ...args) => getCommand(name).perform(agent, ...args);

test('commands are registered, concise and parse', () => {
    for (const n of ['!rememberPlace', '!recallPlace', '!knownPlaces', '!whoIs', '!searchMemory', '!confirmPlace']) {
        const c = getCommand(n);
        assert.ok(c, n);
        assert.ok(c.description.length < 130, `${n} doc too long`);
    }
    const parsed = parseCommandMessage('!rememberPlace("Gorff", 1000, 1000)');
    assert.deepEqual(parsed.args, ['Gorff', 1000, 1000]);
    assert.ok(getCommand('!rememberHere') && getCommand('!goToRememberedPlace') && getCommand('!savedPlaces'));
});

test('!rememberPlace: told by the conversation partner when far, observed when within 48 blocks', async () => {
    const agent = fakeAgent();
    assert.match(await run(agent, '!rememberPlace', 'Gorff', 1000, 1000), /told by Alice/);
    assert.match(await run(agent, '!rememberPlace', 'Near', 10, 10), /I am here/);
    agent.last_sender = null;
    assert.match(await run(agent, '!rememberPlace', 'Mystery', 500, 500), /unverified/);
    const out = await run(agent, '!recallPlace', 'Gorff');
    assert.match(out, /only heard of, never visited/);
    assert.match(out, /Alice said \(1000,1000\) \[told, day 12\]/);
    assert.match(await run(agent, '!recallPlace', 'Near'), /visited \(observed 0 days ago\)/);
});

test('!knownPlaces lists names WITH coordinates nearest first; unknown names give a no-record answer', async () => {
    const agent = fakeAgent();
    await run(agent, '!rememberPlace', 'Far', 900, 0);
    await run(agent, '!rememberPlace', 'Closer', 100, 0);
    const list = await run(agent, '!knownPlaces');
    assert.match(list, /^Known places \(nearest first\): Closer \(100,0\) 100E heard; Far \(900,0\) 900E heard/);
    assert.match(await run(agent, '!recallPlace', 'Atlantis'), /No record of a place called "Atlantis"/);
    assert.match(await run(agent, '!whoIs', 'Nobody'), /No record of a person/);
    assert.ok(agent.memory.store.recentEvents(10, 'unknown').length >= 2, 'unanswerable questions are logged as unknown events');
});

test('!whoIs and !searchMemory compose answers from records with sources', async () => {
    const agent = fakeAgent();
    const t = { role: 'user', content: 'Alice: the sunken temple is east of the red lake' };
    agent.memory.recordTurn(t);
    agent.memory.recordTurn({ role: 'assistant', content: 'Good to know!' });
    const who = await run(agent, '!whoIs', 'alice');
    assert.match(who, /Alice: known since/);
    assert.match(who, /Recently said: "the sunken temple/);
    const found = await run(agent, '!searchMemory', 'sunken temple');
    assert.match(found, /\[day 12, heard Alice\] the sunken temple is east/);
    assert.match(await run(agent, '!searchMemory', 'quantum chromodynamics'), /No record matching/);
});

test('MemoryBank is backed by the archive: survives a fresh bank and exposes names', () => {
    const agent = fakeAgent();
    const bank = new MemoryBank();
    bank.attach(agent.memory);
    bank.rememberPlace('base', 12, 70, -30);
    const fresh = new MemoryBank();
    fresh.attach(agent.memory);
    assert.deepEqual(fresh.recallPlace('base'), [12, 70, -30]);
    assert.match(fresh.getKeys(), /base/);
    const none = new MemoryBank();
    assert.equal(none.recallPlace('base'), undefined); // no archive, no local copy
});

test('live raw events: heard and said are logged once; terrain and system turns are not', () => {
    const agent = fakeAgent();
    const heard = { role: 'user', content: 'Alice: hello Bot' };
    agent.memory.recordTurn(heard);
    agent.memory.recordTurn(heard); // same turn object: no duplicate
    agent.memory.recordTurn({ role: 'assistant', content: 'hi Alice' });
    agent.memory.recordTurn({ role: 'system', content: 'Command output' });
    agent.memory.recordTurn({ role: 'system', content: 'TOPOGRAPHY 16x16 ...' });
    const kinds = agent.memory.store.recentEvents(10).map(e => e.kind).sort();
    assert.deepEqual(kinds, ['heard', 'said']);
    // summarisation logs the rest (system as did) but never duplicates already-logged turns
    const ids = agent.memory.logTurns([heard, { role: 'system', content: 'Command output' }, { role: 'system', content: 'TOPOGRAPHY 16x16' }]);
    assert.equal(ids[0] !== null, true);
    assert.equal(ids[2], null);
    assert.equal(agent.memory.store.countEvents(), 3);
});

function historyFor(agent, responses) {
    mkdirSync('./bots/__memtest/histories', { recursive: true });
    agent.name = '__memtest';
    agent.prompter = { profile: {}, promptMemSaving: async () => responses.shift() };
    agent.self_prompter = { state: 0, isStopped: () => true };
    agent.task = {};
    return new History(agent);
}

test('summarisation: events first, JSON facts stored with provenance, core cap enforced, plain text fallback', async () => {
    const agent = fakeAgent();
    const json = JSON.stringify({ memory: 'x'.repeat(3000), facts: [{ type: 'place', subject: 'Gorff', predicate: 'location', value: [1000, 1000], speaker: 'Eve' }] });
    const h = historyFor(agent, ['```json\n' + json + '\n```', 'plain old summary', '{"memory": "broken', null]);
    try {
        const turns = [{ role: 'user', content: 'Alice: Gorff is at 1000, 1000' }, { role: 'assistant', content: 'ok' }];
        await h.summarizeMemories(turns);
        assert.ok(h.memory.length <= 1000 + 90 && h.memory.includes('Memory truncated to 1000 chars'), h.memory.length);
        const g = agent.memory.store.findPlacesByName('Gorff')[0];
        const c = agent.memory.store.getClaims('place', g.id, { predicate: 'location' })[0];
        assert.equal(c.source_name, 'Alice');
        assert.equal(agent.memory.store.countEvents(), 2);
        await h.summarizeMemories([{ role: 'user', content: 'Alice: more talk' }]);
        assert.equal(h.memory, 'plain old summary');
        await h.summarizeMemories([{ role: 'user', content: 'Alice: even more' }]);
        assert.equal(h.memory, 'broken');
        await assert.doesNotReject(() => h.summarizeMemories([{ role: 'user', content: 'Alice: last' }]).catch(() => {}));
        assert.ok(agent.memory.store.countEvents() >= 5, 'raw turns are stored even when the model output is junk');
    } finally { rmSync('./bots/__memtest', { recursive: true, force: true }); }
});

test('prompt placeholders: $RECALL and $PLACES are filled (or empty) and present in the default profile', async () => {
    const profile = JSON.parse(readFileSync(new URL('../profiles/defaults/_default.json', import.meta.url), 'utf8'));
    for (const key of ['conversing', 'coding']) {
        assert.match(profile[key], /\$PLACES/, key);
        assert.match(profile[key], /\$RECALL/, key);
    }
    assert.match(profile.saving_memory, /\$CORE_CHARS/);
    const agent = fakeAgent();
    await run(agent, '!rememberPlace', 'Gorff', 100, 0);
    const fake = { agent, profile: {} };
    const messages = [{ role: 'user', content: 'Bob: how do I get to Gorff? $FOO' }];
    const filled = await Prompter.prototype.replaceStrings.call(fake, 'P:$PLACES|R:$RECALL', messages);
    assert.match(filled, /^P:Known places: Gorff 100E\|R:RECORDS/);
    assert.match(filled, /Alice said \(100,0\) \[told/);
    const empty = await Prompter.prototype.replaceStrings.call(fake, 'P:$PLACES|R:$RECALL', [{ role: 'user', content: 'Bob: hi' }]);
    assert.equal(empty, 'P:Known places: Gorff 100E|R:');
    const noMemory = await Prompter.prototype.replaceStrings.call({ agent: { name: 'Bot' }, profile: {} }, 'P:$PLACES|R:$RECALL', messages);
    assert.equal(noMemory, 'P:|R:');
    assert.equal(await Prompter.prototype.replaceStrings.call(fake, 'C:$CORE_CHARS', null), `C:${settings.core_memory_chars ?? 800}`);
    // typical size of the always-on additions
    const typical = await Prompter.prototype.replaceStrings.call(fake, '$PLACES\n$RECALL', messages);
    assert.ok(typical.length < 700, `typical additions ${typical.length} chars`);
});

// ---- stub service ----
async function stubService(handler) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let body = ''; for await (const c of req) body += c;
        requests.push({ method: req.method, url: req.url, body });
        const out = handler(req, body);
        res.statusCode = out?.status ?? 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(out?.json ?? {}));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const prev = process.env.TOPOGRAPHY_SERVICE_URL;
    process.env.TOPOGRAPHY_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    return { requests, close: async () => { process.env.TOPOGRAPHY_SERVICE_URL = prev ?? ''; if (!prev) delete process.env.TOPOGRAPHY_SERVICE_URL; await new Promise(r => server.close(r)); } };
}

const SETTLEMENT = { id: 's:1', center: { x: 1043, z: 1010 }, bbox: { x1: 1000, z1: 980, x2: 1090, z2: 1040 }, building_count: 12, distance: 5, direction: 'north', inside: true, confidence: 0.8, evidence: ['12 roofed structures'] };

test('observation watcher: settlements -> survey -> place + observation + observed claims; resurvey throttled', async () => {
    const svc = await stubService((req) => {
        if (req.url.startsWith('/settlements')) return { json: { settlements: [SETTLEMENT, { ...SETTLEMENT, id: 's:2', inside: false }], unexplored_chunks: 0 } };
        if (req.url.startsWith('/survey')) return { json: { building_count: 12, summary: '12 oak houses around a well', palette: { walls: [['minecraft:oak_planks', 420]] }, landmarks: [{ kind: 'well', x: 1040, y: 64, z: 1010 }] } };
        return { status: 404 };
    });
    try {
        const agent = fakeAgent();
        const store = agent.memory.store;
        // A told claim exists first: it must NOT be merged automatically
        agent.last_sender = 'Alice';
        await run(agent, '!rememberPlace', 'Gorff', 1000, 1000);
        agent.bot.entity.position = { x: 1040, y: 64, z: 1005 }; // the bot walks there later
        const w = new ObservationWatcher(agent.memory, { intervalMs: 0 });
        const t0 = Date.now();
        assert.match(await w.tick(agent, t0), /^observed:/);
        const reqs = svc.requests.map(r => r.url);
        assert.ok(reqs[0].startsWith('/settlements?x=1040&z=1005&radius=64&agent=Bot'), reqs[0]);
        assert.ok(/^\/survey\?x1=1000&z1=980&x2=1090&z2=1040&agent=Bot/.test(reqs[1]), reqs[1]);
        const obsPlace = store.listPlaces().find(p => p.kind === 'settlement');
        assert.ok(obsPlace);
        assert.equal(store.getObservations(obsPlace.id).length, 1);
        assert.equal(store.getObservations(obsPlace.id)[0].digest.summary, '12 oak houses around a well');
        const claims = store.getClaims('place', obsPlace.id);
        assert.ok(claims.some(c => c.predicate === 'location' && c.source_kind === 'observed'));
        // (1000,1000) is inside the bbox -> clearly contained -> link confirmed through the explicit rule
        assert.equal(store.resolvePlace(store.findPlacesByName('Gorff')[0].id), obsPlace.id);
        // within resurvey window: no new survey
        const before = svc.requests.length;
        assert.equal(await w.tick(agent, t0 + 60000), 'none');
        assert.equal(svc.requests.length, before + 1);
        // after the window: a second observation snapshot is appended (never mutated)
        assert.match(await w.tick(agent, t0 + 31 * 60000), /^observed:/);
        assert.equal(store.getObservations(obsPlace.id).length, 2);
    } finally { await svc.close(); }
});

test('observation watcher: throttled, honours switches, disables itself on 404, never throws', async () => {
    const svc = await stubService(() => ({ status: 404, json: { error: 'nope' } }));
    try {
        const agent = fakeAgent();
        const w = new ObservationWatcher(agent.memory, { intervalMs: 10000 });
        assert.equal(await w.tick(agent, 100000), 'disabled');
        assert.equal(await w.tick(agent, 200000), null);
        assert.equal(svc.requests.length, 1);
        const off = fakeAgent();
        off.prompter.profile.memory_auto_observe = false;
        assert.equal(await new ObservationWatcher(off.memory, { intervalMs: 0 }).tick(off, 1), null);
        const nether = fakeAgent({ bot: { entity: { position: { x: 1, y: 1, z: 1 } }, game: { dimension: 'the_nether' } } });
        assert.equal(await new ObservationWatcher(nether.memory, { intervalMs: 0 }).tick(nether, 1), null);
        const unreachable = fakeAgent();
        process.env.TOPOGRAPHY_SERVICE_URL = 'http://127.0.0.1:1';
        assert.equal(await new ObservationWatcher(unreachable.memory, { intervalMs: 0 }).tick(unreachable, 1), null);
    } finally { await svc.close(); }
});

test('seen reporter: batches chunks, dedupes, one POST per interval, agent in body', async () => {
    const svc = await stubService(() => ({ json: { accepted: 3 } }));
    try {
        const agent = fakeAgent();
        const seen = new SeenReporter(agent, { intervalMs: 50 });
        const handlers = {};
        const bot = { ...agent.bot, on: (ev, fn) => { handlers[ev] = fn; }, world: { getColumns: () => [{ chunkX: 7, chunkZ: 8 }] } };
        seen.attach(bot);
        for (let i = 0; i < 5; i++) handlers.chunkColumnLoad({ x: i * 16, z: 32 });
        handlers.chunkColumnLoad({ x: 0, z: 32 }); // duplicate
        await new Promise(r => setTimeout(r, 400));
        assert.equal(svc.requests.length, 1, 'one batched POST');
        const body = JSON.parse(svc.requests[0].body);
        assert.equal(svc.requests[0].method, 'POST');
        assert.equal(svc.requests[0].url, '/seen');
        assert.equal(body.agent, 'Bot');
        assert.equal(body.dimension, 'minecraft:overworld');
        assert.equal(body.chunks.length, 6); // 5 loaded + 1 from getColumns
        // already-sent chunks are not resent; new ones go in the next batch
        handlers.chunkColumnLoad({ x: 0, z: 32 });
        handlers.chunkColumnLoad({ x: 160, z: 32 });
        await new Promise(r => setTimeout(r, 300));
        assert.equal(svc.requests.length, 2);
        assert.deepEqual(JSON.parse(svc.requests[1].body).chunks, [[10, 2]]);
    } finally { await svc.close(); }
});

test('seen reporter: never throws or blocks when the service is down; off when topography_seen_only is false', async () => {
    const agent = fakeAgent();
    process.env.TOPOGRAPHY_SERVICE_URL = 'http://127.0.0.1:1';
    try {
        const seen = new SeenReporter(agent, { intervalMs: 10 });
        seen.addChunk(1, 1);
        assert.equal(await seen.flush(), 0);
        assert.ok(seen.pending.get('minecraft:overworld')?.has('1,1'), 'requeued for later');
        agent.prompter.profile.topography_seen_only = false;
        assert.equal(await seen.flush(), 0);
        assert.equal(seen.pending.size, 0);
    } finally { delete process.env.TOPOGRAPHY_SERVICE_URL; }
});

test('terrain requests carry agent=<name> unless topography_seen_only is false; unexplored is reported compactly', async () => {
    const svc = await stubService(() => ({ json: { center: { x: 0, z: 0 }, size_chunks: 16, lod: [], unexplored_chunks: 7 } }));
    try {
        clearPerceptionCache();
        const agent = fakeAgent();
        const text = await fetchPerception(agent, { enabled: true });
        const perceptionRequests = () => svc.requests.filter(r => r.url.startsWith('/perception'));
        assert.match(perceptionRequests()[0].url, /agent=Bot/);
        assert.match(text, /unexplored: 7 chunks/);
        clearPerceptionCache();
        agent.prompter.profile.topography_seen_only = false;
        await fetchPerception(agent, { enabled: true });
        assert.ok(!/agent=/.test(perceptionRequests()[1].url));
        assert.equal(terrainAgentName(agent), null);
        assert.match(formatPerception({ center: { x: 0, z: 0 }, unexplored_chunks: 2 }), /unexplored: 2 chunks/);
        // terrain commands (separate code path)
        const { topographyList } = await import('../src/agent/commands/topography.js');
        agent.prompter.profile.topography_seen_only = true;
        const cmd = topographyList.find(c => c.name === '!area_composition');
        const svc2Url = svc.requests.length;
        await cmd.perform(agent, 0, 0, 10);
        assert.match(svc.requests[svc2Url].url, /^\/area_composition\?.*agent=Bot/);
    } finally { await svc.close(); }
});
