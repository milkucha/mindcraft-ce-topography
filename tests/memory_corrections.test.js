import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryManager } from '../src/agent/memory/index.js';
import { openStore } from '../src/agent/memory/store.js';
import { recordPlaceClaim, recordObservation, markPlaceStatus, nearestPlaces } from '../src/agent/memory/ops.js';
import { renderPlace, placeStatus, conflictLines } from '../src/agent/memory/beliefs.js';
import { getCommand } from '../src/agent/commands/index.js';

const SETTLEMENT = { id: 's:1', center: { x: 277, z: -733 }, bbox: { x1: 242, z1: -771, x2: 328, z2: -707 }, building_count: 12 };

function fakeAgent(over = {}) {
    const agent = {
        name: 'Bot', last_sender: 'milkucha', prompter: { profile: {} },
        bot: { entity: { position: { x: 281, y: 64, z: -747 } }, time: { age: 24000 * 37 }, game: { dimension: 'overworld' } },
        ...over,
    };
    agent.memory = MemoryManager.create(agent, { path: ':memory:', backend: 'jsonl' });
    return agent;
}
const run = (agent, name, ...args) => getCommand(name).perform(agent, ...args);
const hear = (agent, text, who = 'milkucha') => agent.memory.recordTurn({ role: 'user', content: `${who}: ${text}` });
const observeVillage = (agent) => recordObservation(agent.memory.store, {
    settlement: SETTLEMENT, survey: { summary: '12 buildings; oak planks walls', building_count: 12 }, botPos: { x: 281, z: -747 }, ts: 1, day: 37,
});

test('replay of the Milkantis/Gondarfulos incident: no invented location, names stay on the right place', async () => {
    const agent = fakeAgent();
    observeVillage(agent);
    const store = agent.memory.store;

    // "Milkantis is home" names a place without a location; the model passes its own position anyway.
    hear(agent, 'something to remember: Milkantis is home');
    const out = await run(agent, '!rememberPlace', 'Milkantis', 281, -747);
    assert.match(out, /NO location/);
    const milkantis = store.findPlacesByName('Milkantis')[0];
    assert.equal(milkantis.cx, null, 'no position was invented');
    assert.equal(store.getClaims('place', String(milkantis.id), { predicate: 'location' }).length, 0);
    assert.equal(store.getClaims('place', String(milkantis.id), { predicate: 'name' })[0].source_kind, 'told', 'name provenance is told, not observed');

    // "the village we're in is Gondarfulos": here -> position is theirs, and it lands inside the surveyed village
    hear(agent, "the village we're in is the village of Gondarfulos");
    assert.match(await run(agent, '!rememberPlace', 'Gondarfulos', 281, -747), /told by milkucha/);
    const gondar = store.findPlacesByName('Gondarfulos')[0];
    assert.ok(gondar, 'told name now belongs to the surveyed village');
    const recall = await run(agent, '!recallPlace', 'Gondarfulos');
    assert.match(recall, /12 buildings/);
    assert.doesNotMatch(await run(agent, '!recallPlace', 'Milkantis'), /12 buildings/, 'the survey must not leak onto Milkantis');

    // and the later correction ends nothing that was never claimed, but it is recorded and shown
    hear(agent, 'Milkantis is not in this world, there are no coordinates for this');
    assert.equal(placeStatus(store, milkantis.id).state, 'no_location');
    assert.match(await run(agent, '!recallPlace', 'Milkantis'), /no known location/);
    assert.match(await run(agent, '!knownPlaces'), /no known location: Milkantis/);
});

test('rememberPlace: coordinates given by the speaker are theirs; model-initiated places keep the old rules', async () => {
    const agent = fakeAgent();
    hear(agent, 'my chest is at x=312 z=-740, call it Stash');
    assert.match(await run(agent, '!rememberPlace', 'Stash', 312, -740), /told by milkucha/);
    assert.equal(agent.memory.store.findPlacesByName('Stash')[0].cx, 312);

    // nothing said about "Camp": the model's own initiative at its own position is still an observation
    const out = await run(agent, '!rememberPlace', 'Camp', 281, -747);
    assert.match(out, /I am here/);
});

test('a told "gone" is a status claim: shown as GONE, kept with its old location, out of the nearby index', async () => {
    const agent = fakeAgent({ bot: { entity: { position: { x: 0, y: 64, z: 0 } }, time: { age: 24000 * 37 }, game: { dimension: 'overworld' } } });
    const store = agent.memory.store;
    await run(agent, '!rememberPlace', 'Bridge of Gonardlo', 690, -462);
    assert.match(agent.memory.placesText(), /Bridge of Gonardlo/);

    hear(agent, 'this is the sphere now, the Bridge of Gonardlo is gone');
    const place = store.findPlacesByName('Bridge of Gonardlo')[0];
    assert.equal(placeStatus(store, place.id).state, 'gone');
    assert.doesNotMatch(agent.memory.placesText(), /Bridge of Gonardlo/, 'a gone place is not "nearby"');
    const text = renderPlace(store, place.id);
    assert.match(text, /GONE: milkucha said it no longer exists/);
    assert.match(text, /Earlier record:/);
    assert.match(await run(agent, '!knownPlaces'), /Bridge of Gonardlo \(690,-462\).*GONE/);
    assert.equal(nearestPlaces(store, 0, 0).length, 0);
    assert.equal(nearestPlaces(store, 0, 0, 5, { includeGone: true }).length, 1);

    // and it can be undone: nothing was deleted
    await run(agent, '!updatePlace', 'Bridge of Gonardlo', 'exists');
    assert.match(agent.memory.placesText(), /Bridge of Gonardlo/);
});

test('questions and unrelated sentences are not corrections', () => {
    const agent = fakeAgent();
    recordPlaceClaim(agent.memory.store, { name: 'Oak Hollow', x: 10, z: 10, source: { kind: 'told', name: 'milkucha' } });
    hear(agent, 'Is Oak Hollow gone?');
    hear(agent, 'My gold is gone but Oak Hollow is fine');
    hear(agent, 'The old bridge is gone. Oak Hollow is where I live');
    const place = agent.memory.store.findPlacesByName('Oak Hollow')[0];
    assert.equal(placeStatus(agent.memory.store, place.id), null, 'the cue must be in the same clause as the place');
    hear(agent, 'Oak Hollow burned down last night');
    assert.equal(placeStatus(agent.memory.store, place.id), null, 'cues are narrow: unlisted phrasings are not guessed at');
    hear(agent, 'Well, Oak Hollow was destroyed');
    assert.equal(placeStatus(agent.memory.store, place.id).state, 'gone');
    const q = fakeAgent();
    recordPlaceClaim(q.memory.store, { name: 'Oak Hollow', x: 10, z: 10, source: { kind: 'told', name: 'milkucha' } });
    hear(q, 'Is Oak Hollow gone?');
    assert.equal(placeStatus(q.memory.store, q.memory.store.findPlacesByName('Oak Hollow')[0].id), null);
});

test('no_location ends told locations but keeps what the bot saw, and says they conflict', async () => {
    const agent = fakeAgent();
    const store = agent.memory.store;
    recordPlaceClaim(store, { name: 'Pond', x: 100, z: 100, source: { kind: 'told', name: 'milkucha' } });
    recordPlaceClaim(store, { name: 'Pond', x: 105, z: 100, source: { kind: 'observed', name: 'self' } });
    assert.match(await run(agent, '!updatePlace', 'Pond', 'no_location'), /position I saw myself/);
    const place = store.findPlacesByName('Pond')[0];
    const locs = store.getClaims('place', String(place.id), { predicate: 'location' });
    assert.deepEqual(locs.map(c => c.source_kind), ['observed'], 'only the told location was retracted');
    assert.match(conflictLines(store, place.id).join(' '), /says it has no location|said it has no location/);

    recordPlaceClaim(store, { name: 'Mirage', x: 5, z: 5, source: { kind: 'told', name: 'milkucha' } });
    await run(agent, '!updatePlace', 'Mirage', 'no_location');
    const mirage = store.findPlacesByName('Mirage')[0];
    assert.equal(mirage.cx, null, 'position cache is cleared once every location is retracted');
    assert.match(renderPlace(store, mirage.id), /no known location/);
});

test('disagreeing sources are flagged as a CONFLICT with both sides; agreeing ones are not', () => {
    const store = openStore(':memory:', { backend: 'jsonl' });
    recordPlaceClaim(store, { name: 'Gorff', x: 1000, z: 1000, source: { kind: 'told', name: 'A' } });
    recordPlaceClaim(store, { name: 'Gorff', x: 1010, z: 1005, source: { kind: 'told', name: 'B' } });
    const id = store.findPlacesByName('Gorff')[0].id;
    assert.equal(conflictLines(store, id).length, 0, 'close claims agree');
    recordPlaceClaim(store, { name: 'Gorff', x: 1400, z: 900, source: { kind: 'told', name: 'C' } });
    const lines = conflictLines(store, id);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /CONFLICT on location/);
    assert.match(renderPlace(store, id), /CONFLICT on location.*Give both/);
});

test('a gone place that is seen again afterwards is flagged', () => {
    const store = openStore(':memory:', { backend: 'jsonl' });
    recordPlaceClaim(store, { name: 'Mill', x: 50, z: 50, source: { kind: 'told', name: 'A' }, ts: 1 });
    markPlaceStatus(store, { name: 'Mill', state: 'gone', source: { kind: 'told', name: 'A' }, ts: 2 });
    recordPlaceClaim(store, { name: 'Mill', x: 52, z: 50, source: { kind: 'observed', name: 'self' }, ts: 3 });
    const id = store.findPlacesByName('Mill')[0].id;
    assert.match(conflictLines(store, id).join(' '), /it is gone, but I saw it afterwards/);
});

test('status updates work on the sqlite backend too (position cache is cleared with nulls)', () => {
    const store = openStore(':memory:', { backend: 'sqlite' });
    recordPlaceClaim(store, { name: 'Ghost', x: 1, z: 2, source: { kind: 'told', name: 'A' } });
    const res = markPlaceStatus(store, { name: 'Ghost', state: 'no_location', source: { kind: 'told', name: 'A' } });
    assert.equal(res.state, 'no_location');
    assert.equal(store.findPlacesByName('Ghost')[0].cx, null);
    assert.equal(markPlaceStatus(store, { name: 'Nobody', state: 'gone', source: { kind: 'told', name: 'A' } }), null);
    assert.equal(markPlaceStatus(store, { name: 'Ghost', state: 'bogus', source: { kind: 'told', name: 'A' } }), null);
});

test('!updatePlace: registered, concise, rejects unknown places and changes', async () => {
    const c = getCommand('!updatePlace');
    assert.ok(c && c.description.length < 130);
    const agent = fakeAgent();
    assert.match(await run(agent, '!updatePlace', 'Nowhere', 'gone'), /No record of a place called "Nowhere"/);
    recordPlaceClaim(agent.memory.store, { name: 'Dock', x: 9, z: 9, source: { kind: 'told', name: 'milkucha' } });
    assert.match(await run(agent, '!updatePlace', 'Dock', 'sideways'), /Unknown change/);
    assert.match(await run(agent, '!updatePlace', 'Dock', 'destroyed'), /no longer exists \[told by milkucha\]/);
});
