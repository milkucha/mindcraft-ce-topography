import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/agent/memory/store.js';
import { belief, rankClaims, renderPlace, refreshPlace, visitInfo } from '../src/agent/memory/beliefs.js';
import { recordPlaceClaim, recordObservation, confirmLink, relink } from '../src/agent/memory/ops.js';

const DAY = 86400000;

function gorff(store, observeBbox = { x1: 1020, z1: 990, x2: 1066, z2: 1030 }) {
    // A says Gorff at (1000,1000) on day 3; B says (1200,900) on day 5
    recordPlaceClaim(store, { name: 'Gorff', x: 1000, z: 1000, source: { kind: 'told', name: 'A' }, ts: 3 * DAY, day: 3 });
    recordPlaceClaim(store, { name: 'Gorff', x: 1200, z: 900, source: { kind: 'told', name: 'B' }, ts: 5 * DAY, day: 5 });
    // later the bot itself observes a settlement near (1043,1010) on day 12
    const obs = recordObservation(store, {
        settlement: { id: 's:1', center: { x: 1043, z: 1010 }, bbox: observeBbox, building_count: 12 },
        survey: { summary: '12 buildings, oak walls', building_count: 12 }, botPos: { x: 1040, z: 1005 }, ts: 12 * DAY, day: 12,
    });
    return { obs, told: store.findPlacesByName('Gorff')[0].id };
}

test('rankClaims: observed > told > inferred, newest first within a class', () => {
    const mk = (id, source_kind, ts) => ({ id, source_kind, ts, superseded_by: null });
    const ranked = rankClaims([mk(1, 'inferred', 9), mk(2, 'told', 5), mk(3, 'observed', 1), mk(4, 'told', 7), mk(5, 'observed', 4)]);
    assert.deepEqual(ranked.map(c => c.id), [5, 3, 4, 2, 1]);
    const b = belief([mk(1, 'told', 9), mk(2, 'observed', 1), { ...mk(3, 'observed', 50), superseded_by: 9 }]);
    assert.equal(b.best.id, 2);
    assert.equal(b.others.length, 1);
});

test('scenario: told claims are NOT auto-merged; a link candidate is rendered with confidence', () => {
    const store = openStore(':memory:', { backend: 'jsonl' });
    const { obs, told } = gorff(store);
    assert.notEqual(obs, told, 'observed place and told place stay separate records');
    const links = store.getLinks({ status: 'candidate' });
    assert.equal(links.length, 1, 'only the near told point (A) becomes a candidate; B is ~190 away');
    assert.equal(links[0].told_place, told);
    assert.equal(links[0].observed_place, obs);
    assert.ok(links[0].confidence > 0.7 && links[0].confidence < 1);

    const observedText = renderPlace(store, obs);
    assert.match(observedText, /^settlement near \(1043,1010\): I saw it around \(1043,1010\) on day 12 \[observed\]/);
    assert.match(observedText, /probably the same as Gorff \(told by A, 20 blocks from what I saw\)/i);

    // the told record is still fully retrievable with speaker and date
    const toldText = renderPlace(store, told);
    assert.match(toldText, /^Gorff: B said \(1200,900\) \[told, day 5\]\. A said \(1000,1000\) \[told, day 3\]\./);
    assert.match(toldText, /possibly the place I saw|probably the place I saw/i);
    assert.equal(store.getClaims('place', told, { predicate: 'location' }).length, 2);
});

test('scenario: deliberate confirmation merges; observed outranks told but nothing is erased', () => {
    const store = openStore(':memory:', { backend: 'jsonl' });
    const { obs, told } = gorff(store);
    assert.ok(confirmLink(store, store.getLinks({ status: 'candidate' })[0].id));
    assert.equal(store.getLinks({ status: 'candidate' }).length, 0);
    assert.equal(store.resolvePlace(told), obs);
    const text = renderPlace(store, obs);
    assert.match(text, /^Gorff: I saw it around \(1043,1010\) on day 12 \[observed\]\./);
    // newest told first, each with its speaker and day, flagged against what the bot saw
    assert.match(text, /B said \(1200,900\) \[told, day 5, ~\d+ off\]; A said \(1000,1000\) \[told, day 3, ~44 off\]/);
    assert.ok(text.indexOf('[observed]') < text.indexOf('B said'));
    // raw claims remain
    assert.equal(store.getClaims('place', told, { includeSuperseded: true }).length, 4); // 2 location + 2 name claims, none erased
    assert.ok(visitInfo(store, told).visited, 'merged group is visited');
});

test('a later observation that clearly contains the told point auto-confirms the link', () => {
    const store = openStore(':memory:', { backend: 'jsonl' });
    const { obs, told } = gorff(store, { x1: 990, z1: 990, x2: 1090, z2: 1040 }); // contains (1000,1000)
    assert.equal(store.resolvePlace(told), obs);
    const text = renderPlace(store, obs);
    assert.match(text, /^Gorff: I saw it around \(1043,1010\)/);
    assert.match(text, /A said \(1000,1000\) \[told, day 3, consistent\]/);
});

test('told-only place is flagged as heard-only until visited', () => {
    const store = openStore(':memory:', { backend: 'jsonl' });
    recordPlaceClaim(store, { name: 'Elmsworth', x: 300, z: -40, source: { kind: 'told', name: 'Cy' }, day: 1 });
    const id = store.findPlacesByName('Elmsworth')[0].id;
    assert.equal(visitInfo(store, id).visited, false);
    recordPlaceClaim(store, { name: 'Elmsworth', x: 305, z: -42, source: { kind: 'observed', name: 'self' }, day: 4 });
    assert.equal(visitInfo(store, id).visited, true);
    assert.match(renderPlace(store, id), /^Elmsworth: I saw it around \(305,-42\) on day 4 \[observed\]\. Cy said \(300,-40\) \[told, day 1, consistent\]\./);
});

test('a repeat from the same source supersedes (not deletes) the older claim', () => {
    const store = openStore(':memory:', { backend: 'jsonl' });
    recordPlaceClaim(store, { name: 'Gorff', x: 1, z: 1, source: { kind: 'told', name: 'A' }, ts: 10, day: 1 });
    recordPlaceClaim(store, { name: 'Gorff', x: 5, z: 5, source: { kind: 'told', name: 'A' }, ts: 20, day: 2 });
    recordPlaceClaim(store, { name: 'Gorff', x: 5, z: 5, source: { kind: 'told', name: 'A' }, ts: 30, day: 3 }); // identical: no new row
    const id = store.findPlacesByName('Gorff')[0].id;
    assert.equal(store.getClaims('place', id, { predicate: 'location' }).length, 1);
    assert.equal(store.getClaims('place', id, { predicate: 'location', includeSuperseded: true }).length, 2);
    refreshPlace(store, id);
    assert.equal(store.getPlace(id).cx, 5);
    relink(store, id);
});
