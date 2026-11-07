// Memory commands: deterministic reads/writes against the per-agent memory archive (src/agent/memory/).
const unavailable = 'Memory is unavailable.';
const mem = (agent) => (agent?.memory?.enabled ? agent.memory : null);

export const memoryList = [
    {
        name: '!rememberPlace',
        description: 'Record a named place (area, ~32 block radius) at x,z that someone told you about or you are at. Source is kept.',
        params: {
            'name': { type: 'string', description: 'Place name.' },
            'x': { type: 'int', description: 'x coordinate.' },
            'z': { type: 'int', description: 'z coordinate.' }
        },
        perform: function (agent, name, x, z) {
            const m = mem(agent);
            return m ? m.rememberPlace(name, x, z) : unavailable;
        }
    },
    {
        name: '!updatePlace',
        description: 'Correct a known place: gone, exists, or no_location (has no coordinates). Use for corrections, not !rememberPlace.',
        params: {
            'name': { type: 'string', description: 'Place name.' },
            'change': { type: 'string', description: 'gone, exists or no_location.' }
        },
        perform: function (agent, name, change) {
            const m = mem(agent);
            return m ? m.updatePlace(name, change) : unavailable;
        }
    },
    {
        name: '!recallPlace',
        description: 'What you know about a place: where, who said it, whether you visited.',
        params: { 'name': { type: 'string', description: 'Place name.' } },
        perform: function (agent, name) {
            const m = mem(agent);
            return m ? m.recallPlace(name) : unavailable;
        }
    },
    {
        name: '!knownPlaces',
        description: 'List known places with coordinates, nearest first.',
        perform: function (agent) {
            const m = mem(agent);
            return m ? m.knownPlaces() : unavailable;
        }
    },
    {
        name: '!whoIs',
        description: 'What you know about a player, with sources.',
        params: { 'name': { type: 'string', description: 'Player name.' } },
        perform: function (agent, name) {
            const m = mem(agent);
            return m ? m.whoIs(name) : unavailable;
        }
    },
    {
        name: '!searchMemory',
        description: 'Search your memory records (what was said, seen, told) by keywords.',
        params: { 'query': { type: 'string', description: 'Keywords.' } },
        perform: function (agent, query) {
            const m = mem(agent);
            return m ? m.searchMemory(query) : unavailable;
        }
    },
    {
        name: '!confirmPlace',
        description: 'Confirm that a place you were told about is the one you saw (links the two records).',
        params: { 'name': { type: 'string', description: 'Told place name.' } },
        perform: function (agent, name) {
            const m = mem(agent);
            return m ? m.confirmPlace(name) : unavailable;
        }
    }
];
