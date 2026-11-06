/**
 * Reports chunks the bot has actually loaded ("seen") to the terrain service so queries can treat
 * unseen chunks as unexplored. Batched (<= 1 POST per interval), fire-and-forget, never throws.
 */
import { getServiceUrl, normalizeDimension, terrainAgentName } from '../topography_service.js';
import { cfg } from './observer.js';

const MAX_PER_POST = 2000;

export class SeenReporter {
    constructor(agent, { intervalMs = 2000, fetchImpl = null } = {}) {
        this.agent = agent;
        this.intervalMs = intervalMs;
        this.fetchImpl = fetchImpl;
        this.pending = new Map(); // dimension -> Set("cx,cz")
        this.sent = new Map();
        this.lastFlush = 0;
        this.timer = null;
        this.blockedUntil = 0;
        this.posts = 0;
    }

    enabled() {
        return cfg(this.agent, 'topography_enabled', true) !== false && cfg(this.agent, 'topography_seen_only', true) !== false;
    }

    dimension() {
        return normalizeDimension(this.agent?.bot?.game?.dimension) ?? 'minecraft:overworld';
    }

    addChunk(cx, cz, dimension = this.dimension()) {
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
        const key = `${cx},${cz}`;
        if (this.sent.get(dimension)?.has(key)) return;
        let set = this.pending.get(dimension);
        if (!set) this.pending.set(dimension, set = new Set());
        set.add(key);
        this._schedule();
    }

    _schedule() {
        if (this.timer) return;
        const now = Date.now();
        const delay = Math.max(0, this.lastFlush + this.intervalMs - now, this.blockedUntil - now);
        this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, delay);
        this.timer.unref?.();
    }

    attach(bot) {
        bot.on('chunkColumnLoad', (point) => {
            try { this.addChunk(Math.floor(point.x / 16), Math.floor(point.z / 16)); } catch { /* never throw */ }
        });
        // chunks already loaded before we attached
        Promise.resolve().then(async () => {
            const columns = await Promise.resolve(bot.world?.getColumns?.());
            for (const c of columns ?? []) this.addChunk(c.chunkX, c.chunkZ);
        }).catch(() => {});
    }

    async flush() {
        this.lastFlush = Date.now();
        if (!this.enabled()) { this.pending.clear(); return 0; }
        let total = 0;
        for (const [dimension, set] of [...this.pending.entries()]) {
            const keys = [...set].slice(0, MAX_PER_POST);
            if (!keys.length) continue;
            const chunks = keys.map(k => k.split(',').map(Number));
            for (const k of keys) set.delete(k);
            if (!set.size) this.pending.delete(dimension);
            try {
                const doFetch = this.fetchImpl ?? fetch;
                const res = await doFetch(`${getServiceUrl()}/seen`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agent: terrainAgentName(this.agent) ?? this.agent.name, dimension, chunks }),
                    signal: AbortSignal.timeout(3000),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                this.posts++;
                total += chunks.length;
                let sent = this.sent.get(dimension); if (!sent) this.sent.set(dimension, sent = new Set());
                for (const k of keys) sent.add(k);
            } catch {
                // service down or older: requeue and back off so we never spam
                let back = this.pending.get(dimension); if (!back) this.pending.set(dimension, back = new Set());
                for (const k of keys) back.add(k);
                this.blockedUntil = Date.now() + 15000;
            }
        }
        if (this.pending.size) this._schedule();
        return total;
    }
}
