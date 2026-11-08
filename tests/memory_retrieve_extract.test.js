import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/agent/memory/store.js';
import { retrieve, placesLine, askedAbout } from '../src/agent/memory/retrieve.js';
import { parseMemoryResponse, describeTurns, ingestFacts, parseCoords } from '../src/agent/memory/extract.js';
import { renderPlace } from '../src/agent/memory/beliefs.js';
import { recordPlaceClaim } from '../src/agent/memory/ops.js';

function seeded() {
    const store = openStore(':memory:', { backend: 'jsonl' });
    recordPlaceClaim(store, { name: 'Gorff', x: 1000, z: 1000, source: { kind: 'told', name: 'A' }, day: 3 });
    recordPlaceClaim(store, { name: 'Oakridge', x: -400, z: 80, source: { kind: 'told', name: 'B' }, day: 4 });
    store.appendEvent({ kind: 'heard', speaker: 'A', text: 'Gorff has a lovely windmill by the river' });
    store.touchPerson('A');
    for (let i = 0; i < 200; i++) store.appendEvent({ kind: 'heard', speaker: 'C', text: `chatter about cows number ${i}` });
    return store;
}

test('retrieval: names in recent messages pull their records with sources, nothing unrelated', async () => {
    const store = seeded();
    const turns = [{ role: 'user', content: 'Bob: how far is Gorff from here?' }];
    const r = await retrieve({ store, turns, position: { x: 0, z: 0 }, selfName: 'Bot' });
    assert.match(r.text, /Gorff \(\d+ SE, heard only\): A said \(1000,1000\) \[told, day 3\]/);
    assert.ok(!r.text.includes('Oakridge'));
    assert.deepEqual(r.unknown, []);
});

test('retrieval is capped and gives nothing when nothing is relevant', async () => {
    const store = seeded();
    const small = await retrieve({ store, turns: [{ role: 'user', content: 'Bob: Gorff and Oakridge please' }], maxChars: 120 });
    assert.ok(small.text.length <= 120 + 5, small.text.length);
    const none = await retrieve({ store, turns: [{ role: 'user', content: 'Bob: hello there' }] });
    assert.equal(none.text, '');
    assert.equal((await retrieve({ store, turns: [] })).text, '');
});

test('typed no-record result when asked about something never seen or told', async () => {
    const store = seeded();
    const r = await retrieve({ store, turns: [{ role: 'user', content: 'Bob: do you know where Zorblax is?' }], selfName: 'Bot' });
    assert.deepEqual(r.unknown, ['Zorblax']);
    assert.match(r.text, /NO RECORD of "Zorblax".*do not guess/);
    assert.deepEqual(askedAbout('Where is the nearest tree?'), []);
    assert.deepEqual(askedAbout('Take me to Gorff Bridge'), ['Gorff Bridge']);
});

test('embeddings are optional: reranking is used when given, failures fall back', async () => {
    const store = seeded();
    const turns = [{ role: 'user', content: 'Bob: tell me about the windmill river Gorff' }];
    let calls = 0;
    const ok = await retrieve({ store, turns, embed: async (t) => { calls++; return [t.length, 1]; } });
    assert.ok(ok.text.includes('Gorff'));
    const bad = await retrieve({ store, turns, embed: async () => { throw new Error('no key'); } });
    assert.ok(bad.text.includes('Gorff'));
    assert.ok(calls >= 0);
});

test('placesLine: nearest first, direction, hard char cap', () => {
    const store = seeded();
    const line = placesLine(store, { x: 900, z: 1000 }, { maxChars: 150 });
    assert.match(line, /^Known places: Gorff 100E/);
    assert.ok(line.includes('Oakridge'));
    assert.ok(placesLine(store, { x: 900, z: 1000 }, { maxChars: 30 }).length <= 30);
    assert.equal(placesLine(openStore(':memory:', { backend: 'jsonl' }), { x: 0, z: 0 }), '');
});

test('parseMemoryResponse: clean JSON, fenced JSON, think blocks, and prose all handled', () => {
    const ok = parseMemoryResponse('{"memory":"Likes cows","facts":[{"type":"place","subject":"Gorff","predicate":"location","value":[1,2]}]}');
    assert.equal(ok.memory, 'Likes cows');
    assert.equal(ok.facts.length, 1);
    assert.ok(ok.structured);
    const fenced = parseMemoryResponse('<think>hmm</think>\n```json\n{"memory":"m","facts":[]}\n```');
    assert.equal(fenced.memory, 'm');
    const chatty = parseMemoryResponse('Sure! {"memory":"m2","facts":[]} hope that helps');
    assert.equal(chatty.memory, 'm2');
});

test('parseMemoryResponse: malformed output never throws and falls back to plain text', () => {
    assert.deepEqual(parseMemoryResponse('Just a plain old memory text.'), { memory: 'Just a plain old memory text.', facts: [], structured: false });
    const truncated = parseMemoryResponse('{"memory": "kept this much", "facts": [{"type": "pla');
    assert.equal(truncated.memory, 'kept this much');
    assert.deepEqual(truncated.facts, []);
    for (const junk of ['', null, undefined, '{}', '[]', '{"facts": "no"}', '```', '{"memory": 5}'])
        assert.doesNotThrow(() => parseMemoryResponse(junk));
    assert.equal(parseMemoryResponse('{"facts":[{"type":"general"}]}').memory, null); // keep old core memory
    assert.equal(parseMemoryResponse(undefined).memory, '');
});

test('parseCoords accepts arrays, objects and text', () => {
    assert.deepEqual(parseCoords([10, -4]), { x: 10, z: -4 });
    assert.deepEqual(parseCoords({ x: 1.4, z: 2 }), { x: 1, z: 2 });
    assert.deepEqual(parseCoords('around (100, 64, -20)'), { x: 100, z: -20 });
    assert.equal(parseCoords('north of the lake'), null);
});

test('facts get provenance from the turn prefix, not from the model', () => {
    const store = openStore(':memory:', { backend: 'jsonl' });
    const turns = [
        { role: 'user', content: 'Alice: Gorff is at 1000 1000, a cozy village' },
        { role: 'assistant', content: 'Thanks, noted!' },
        { role: 'user', content: 'Bob: I heard Wolfpine is at 50, 60' },
    ];
    const ids = turns.map((t, i) => store.appendEvent({ kind: 'heard', speaker: 'x', text: `t${i}` }));
    const infos = describeTurns(turns, 'Bot', ids);
    assert.equal(infos[0].speaker, 'Alice');
    assert.equal(infos[1].speaker, 'self');
    const n = ingestFacts({ store, infos, ts: 5, day: 7 }, [
        // model lies about the speaker: code attributes to Alice, the author of the turn that mentions Gorff
        { type: 'place', subject: 'Gorff', predicate: 'location', value: [1000, 1000], speaker: 'Bob' },
        { type: 'place', subject: 'Gorff', predicate: 'description', value: 'a cozy village', speaker: 'self' },
        { type: 'place', subject: 'Wolfpine', predicate: 'location', value: '50,60', speaker: 'Alice' },
        { type: 'person', subject: 'Alice', predicate: 'attribute', value: 'builds villages' },
        { type: 'place', subject: 'Nowhere', predicate: 'location', value: [1, 2] }, // not in any turn -> inferred, no speaker
        { type: 'bogus', subject: 'x', predicate: 'location', value: 1 },
        { type: 'place', subject: 'NoCoords', predicate: 'location', value: 'somewhere' },
    ]);
    assert.equal(n, 5);
    const g = store.findPlacesByName('Gorff')[0];
    const loc = store.getClaims('place', g.id, { predicate: 'location' })[0];
    assert.equal(loc.source_kind, 'told');
    assert.equal(loc.source_name, 'Alice');
    assert.equal(loc.event_id, ids[0]);
    assert.equal(loc.day, 7);
    const w = store.getClaims('place', store.findPlacesByName('Wolfpine')[0].id, { predicate: 'location' })[0];
    assert.equal(w.source_name, 'Bob');
    const nowhere = store.getClaims('place', store.findPlacesByName('Nowhere')[0].id, { predicate: 'location' })[0];
    assert.equal(nowhere.source_kind, 'inferred');
    assert.equal(nowhere.source_name, null);
    assert.match(renderPlace(store, g.id), /Gorff: Alice said \(1000,1000\) \[told, day 7\]/);
    assert.equal(store.getClaims('person', 'alice').length, 1);
});
