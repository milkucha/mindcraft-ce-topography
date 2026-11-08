import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, sqliteAvailable } from '../src/agent/memory/store.js';

const BACKENDS = sqliteAvailable() ? ['sqlite', 'jsonl'] : ['jsonl'];

function scenario(store) {
    const e1 = store.appendEvent({ ts: 1000, day: 1, kind: 'heard', speaker: 'Alice', text: 'The village of Gorff has a big bell tower' });
    const e2 = store.appendEvent({ ts: 2000, day: 2, kind: 'said', speaker: 'self', text: 'Nice, I will visit Gorff soon' });
    const pid = store.createPlace({ name: 'Gorff', cx: 1000, cz: 1000, radius: 32, ts: 1000 });
    const c1 = store.addClaim({ subject_type: 'place', subject_id: pid, predicate: 'location', value: { x: 1000, z: 1000 }, source_kind: 'told', source_name: 'Alice', ts: 1000, event_id: e1 });
    const c2 = store.addClaim({ subject_type: 'place', subject_id: pid, predicate: 'location', value: { x: 1010, z: 1005 }, source_kind: 'told', source_name: 'Alice', ts: 3000, derived_from: e1 });
    store.supersedeClaim(c1, c2, 3000);
    store.addObservation({ place_id: pid, ts: 4000, digest: { n: 1 } });
    store.touchPerson('Alice', 1000);
    return { e1, e2, pid, c1, c2 };
}

for (const backend of BACKENDS) {
    test(`[${backend}] events/claims/observations round-trip, supersede keeps history`, () => {
        const store = openStore(':memory:', { backend });
        const { pid, c1, c2, e1 } = scenario(store);
        assert.equal(store.countEvents(), 2);
        assert.equal(store.getEvent(e1).speaker, 'Alice');
        const live = store.getClaims('place', pid, { predicate: 'location' });
        assert.deepEqual(live.map(c => c.id), [c2]);
        assert.equal(store.getClaims('place', pid, { includeSuperseded: true }).length, 2);
        assert.equal(store.getClaim(c1).superseded_by, c2);
        assert.equal(store.getClaim(c1).value.x, 1000); // content untouched
        assert.equal(store.getClaim(c2).derived_from, e1);
        assert.equal(store.getObservations(pid).length, 1);
        assert.equal(store.getPerson('alice').display, 'Alice');
        assert.ok(store.search('bell tower').some(h => h.kind === 'event'));
        assert.ok(store.search('gorff').some(h => h.kind === 'place'));
        assert.equal(store.eventsBySpeaker('alice', 5).length, 1);
        store.close();
    });
}

test('sqlite: raw records are append-only (triggers refuse UPDATE/DELETE)', { skip: !sqliteAvailable() }, () => {
    const store = openStore(':memory:', { backend: 'sqlite' });
    scenario(store);
    assert.throws(() => store.db.exec("UPDATE events SET text='x'"), /append-only/);
    assert.throws(() => store.db.exec('DELETE FROM events'), /append-only/);
    assert.throws(() => store.db.exec('UPDATE observations SET ts=1'), /append-only/);
    assert.throws(() => store.db.exec('DELETE FROM observations'), /append-only/);
    assert.throws(() => store.db.exec('DELETE FROM claims'), /never deleted/);
    assert.throws(() => store.db.exec("UPDATE claims SET predicate='z'"), /immutable/);
    store.db.exec('UPDATE claims SET valid_to=5'); // supersede columns remain writable
    assert.equal(store.countEvents(), 2);
    store.close();
});

test('sqlite: migration v1 -> v2 keeps data and builds the search index', { skip: !sqliteAvailable() }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    try {
        const path = join(dir, 'memory.db');
        const old = openStore(path, { backend: 'sqlite', targetVersion: 1 });
        assert.equal(old.version, 1);
        old.appendEvent({ kind: 'heard', speaker: 'Bob', text: 'There is a lighthouse at the north coast' });
        const pid = old.createPlace({ name: 'Lighthouse', cx: 5, cz: -300 });
        old.addClaim({ subject_type: 'place', subject_id: pid, predicate: 'name', value: 'Lighthouse', source_kind: 'told', source_name: 'Bob' });
        assert.deepEqual(old.search('lighthouse'), []); // no FTS yet at v1
        old.close();
        const now = openStore(path, { backend: 'sqlite' });
        assert.equal(now.version, 2);
        assert.equal(now.countEvents(), 1);
        assert.equal(now.listPlaces()[0].name, 'Lighthouse');
        assert.ok(now.search('lighthouse north').length >= 1);
        now.appendEvent({ kind: 'heard', speaker: 'Bob', text: 'another lighthouse remark' });
        assert.equal(now.search('remark').length, 1);
        now.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('jsonl backend persists and replays identically (and tolerates a torn last line)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    try {
        const path = join(dir, 'memory.jsonl');
        const a = openStore(path, { backend: 'jsonl' });
        const { pid, c2 } = scenario(a);
        a.close();
        appendFileSync(path, '{"t":"ev","row":{"id":9');
        const b = openStore(path, { backend: 'jsonl' });
        assert.equal(b.countEvents(), 2);
        assert.equal(b.getPlace(pid).name, 'Gorff');
        assert.deepEqual(b.getClaims('place', pid, { predicate: 'location' }).map(c => c.id), [c2]);
        assert.equal(b.getObservations(pid).length, 1);
        assert.ok(b.search('bell').length >= 1);
        assert.ok(b.createPlace({ name: 'X' }) > pid); // ids continue after replay
        b.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backend parity: same scenario gives same observable results', { skip: !sqliteAvailable() }, () => {
    const out = [];
    for (const backend of ['sqlite', 'jsonl']) {
        const s = openStore(':memory:', { backend });
        const ids = scenario(s);
        out.push(JSON.stringify({
            n: s.countEvents(),
            live: s.getClaims('place', ids.pid).map(c => [c.id, c.value]),
            all: s.getClaims('place', ids.pid, { includeSuperseded: true }).length,
            names: s.placeNames(),
            hits: s.search('visit gorff').map(h => [h.kind, h.ref]).sort(),
            recent: s.recentEvents(5).map(e => e.id),
            found: s.findPlacesByName('gor').map(p => p.name),
        }));
        s.close();
    }
    assert.equal(out[0], out[1]);
});

for (const backend of BACKENDS) {
    test(`[${backend}] scale: 50k events insert, retrieval stays fast`, async () => {
        const { retrieve } = await import('../src/agent/memory/retrieve.js');
        const store = openStore(':memory:', { backend });
        const words = ['stone', 'wood', 'iron', 'creeper', 'village', 'diamond', 'cave', 'river', 'farm', 'sheep', 'zombie', 'house', 'bridge', 'mine'];
        const batch = [];
        for (let i = 0; i < 50000; i++) {
            batch.push({ ts: i, day: i % 300, kind: 'heard', speaker: `P${i % 40}`,
                text: `${words[i % 14]} ${words[(i * 7) % 14]} number${i} near ${words[(i * 3) % 14]}` });
        }
        batch.push({ ts: 99999, kind: 'heard', speaker: 'Alice', text: 'the haven of Oakridge has a lovely mill' });
        store.appendEvents(batch);
        const pid = store.createPlace({ name: 'Oakridge', cx: 100, cz: 100, radius: 32 });
        store.addClaim({ subject_type: 'place', subject_id: pid, predicate: 'location', value: { x: 100, z: 100 }, source_kind: 'told', source_name: 'Alice' });
        assert.equal(store.countEvents(), 50001);
        const turns = [{ role: 'user', content: 'Bob: where is Oakridge and its mill?' }];
        await retrieve({ store, turns, position: { x: 0, z: 0 } }); // warm
        const t0 = performance.now();
        const r = await retrieve({ store, turns, position: { x: 0, z: 0 } });
        const ms = performance.now() - t0;
        assert.ok(r.text.includes('Oakridge'));
        assert.ok(ms < 50, `retrieval took ${ms.toFixed(1)}ms`);
        store.close();
    });
}
