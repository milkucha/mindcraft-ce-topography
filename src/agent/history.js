import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import { parseMemoryResponse } from './memory/extract.js';

const TRANSIENT_TERRAIN_PATTERN = /^(?:SYSTEM:\s*)?(TOPOGRAPHY|SHORELINE|AREA_COMPOSITION|RECALL|CHUNK)\b/;

function isTransientTerrain(turn) {
    return turn?.role === 'system'
        && TRANSIENT_TERRAIN_PATTERN.test((turn.content || '').trim());
}


// Live (not yet saved/summarized) terrain results go stale quickly. Each one is stubbed
// once the model has had its next turn, or once the bot has moved this far from where
// the result was produced.
const STALE_DISTANCE = 16;
const terrainMeta = new WeakMap(); // turn object -> { x, z } where it was produced

function terrainStub(turn) {
    const match = (turn.content || '').trim().match(TRANSIENT_TERRAIN_PATTERN);
    const kind = match ? match[1] : 'terrain';
    return `[earlier ${kind} result omitted — re-run the command if needed]`;
}

/**
 * Replace transient terrain system turns in `turns` (in place) with one-line stubs.
 * `opts.all` stubs every one; otherwise only those produced more than STALE_DISTANCE
 * blocks from `opts.position`. Returns the number replaced.
 */
export function compactStaleTerrain(turns, opts = {}) {
    let replaced = 0;
    for (const turn of turns) {
        if (!isTransientTerrain(turn))
            continue;
        let stale = opts.all === true;
        if (!stale && opts.position) {
            const origin = terrainMeta.get(turn);
            if (origin) {
                const dx = opts.position.x - origin.x;
                const dz = opts.position.z - origin.z;
                stale = Math.hypot(dx, dz) > STALE_DISTANCE;
            }
        }
        if (!stale)
            continue;
        turn.content = terrainStub(turn);
        terrainMeta.delete(turn);
        replaced++;
    }
    return replaced;
}

function botPosition(agent) {
    const p = agent?.bot?.entity?.position;
    return Number.isFinite(p?.x) && Number.isFinite(p?.z) ? { x: p.x, z: p.z } : null;
}

export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 20; 
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        const memoryTurns = turns.filter(turn => !isTransientTerrain(turn));
        // Raw record first: the turns are appended to the event log before any LLM call can fail.
        const archive = this.agent.memory;
        const eventIds = archive?.logTurns?.(memoryTurns) ?? [];
        const raw = await this.agent.prompter.promptMemSaving(memoryTurns);
        const parsed = parseMemoryResponse(raw);
        // core text: target is settings.core_memory_chars; hard cap leaves 25% slack before truncating
        const target = Number(settings.core_memory_chars ?? 800);
        const cap = Math.round(target * 1.25);
        this.memory = parsed.memory ?? this.memory;

        if (this.memory.length > cap) {
            this.memory = this.memory.slice(0, cap);
            this.memory += `...(Memory truncated to ${cap} chars. Compress it more next time)`;
        }
        if (parsed.facts.length)
            archive?.ingestSummary?.(memoryTurns, eventIds, parsed.facts);

        console.log("Memory updated to: ", this.memory);
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
        }
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        const turn = {role, content};
        // A new assistant turn means the model has already seen earlier terrain results.
        if (role === 'assistant')
            compactStaleTerrain(this.turns, { all: true });
        const position = botPosition(this.agent);
        if (position) {
            if (isTransientTerrain(turn))
                terrainMeta.set(turn, position);
            else
                compactStaleTerrain(this.turns, { position });
        }
        this.turns.push(turn);
        this.agent.memory?.recordTurn(turn); // raw event log (no LLM)

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            await this.summarizeMemories(chunk);
            await this.appendFullHistory(chunk);
        }
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns.filter(turn => !isTransientTerrain(turn)),
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = (data.turns || []).filter(turn => !isTransientTerrain(turn));
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}