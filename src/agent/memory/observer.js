/**
 * Terrain-service driven observations: when the bot is inside a detected settlement and has no recent
 * observation of it, survey it and record place + observation + observed claims. Never throws.
 */
import settings from '../settings.js';
import { getServiceUrl, isOverworld, getDimension, terrainAgentName } from '../topography_service.js';
import { findObservedPlace, recordObservation } from './ops.js';

const REQUEST_TIMEOUT_MS = 5000;

export function cfg(agent, key, fallback) {
    return agent?.prompter?.profile?.[key] ?? settings[key] ?? fallback;
}

export class ObservationWatcher {
    constructor(manager, { intervalMs = 10000 } = {}) {
        this.manager = manager;
        this.intervalMs = intervalMs;
        this.last = 0;
        this.busy = false;
        this.disabled = false;
    }

    enabled(agent) {
        if (this.disabled) return false;
        if (cfg(agent, 'topography_enabled', true) === false) return false;
        return cfg(agent, 'memory_auto_observe', true) !== false;
    }

    async _get(path, params) {
        const search = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) search.set(k, String(v));
        const response = await fetch(`${getServiceUrl()}${path}?${search}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) { const e = new Error(`HTTP ${response.status}`); e.status = response.status; throw e; }
        return response.json();
    }

    /** @returns {Promise<string|null>} what happened, for tests/logs */
    async tick(agent, now = Date.now()) {
        let started = false;
        try {
            if (!this.enabled(agent) || this.busy || now - this.last < this.intervalMs) return null;
            const pos = agent?.bot?.entity?.position;
            if (!pos || !Number.isFinite(pos.x) || !isOverworld(agent)) return null;
            const store = this.manager.store;
            if (!store) return null;
            this.last = now;
            this.busy = true;
            started = true;
            const x = Math.floor(pos.x), z = Math.floor(pos.z);
            const agentName = terrainAgentName(agent);
            const dimension = getDimension(agent);
            let data;
            try {
                data = await this._get('/settlements', { x, z, radius: 64, agent: agentName, dimension });
            } catch (e) {
                if (e.status === 404) {
                    this.disabled = true;
                    console.log('[memory] terrain service has no /settlements; auto-observation disabled for this session');
                    return 'disabled';
                }
                return null;
            }
            const resurveyMs = Number(cfg(agent, 'memory_resurvey_minutes', 30)) * 60000;
            const inside = (data?.settlements ?? []).filter(s => s?.inside && s.bbox).sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
            for (const s of inside) {
                const existing = findObservedPlace(store, s.bbox);
                if (existing) {
                    const last = store.getObservations(store.placeGroup(existing.id), 50).find(o => o.digest?.via !== 'visit'); // surveys only
                    if (last && last.ts > now - resurveyMs) continue;
                }
                let survey = null;
                try {
                    survey = await this._get('/survey', { x1: s.bbox.x1, z1: s.bbox.z1, x2: s.bbox.x2, z2: s.bbox.z2, agent: agentName, dimension });
                } catch (e) { if (e.status !== 404) return null; }
                const day = this.manager.day();
                const id = recordObservation(store, { settlement: s, survey, botPos: { x, z }, ts: now, day, self: 'self' });
                store.appendEvent({ ts: now, day, kind: 'observed', speaker: 'self', pos: { x, z },
                    text: `surveyed ${s.id ?? 'a settlement'} near (${Math.round(s.center?.x ?? x)},${Math.round(s.center?.z ?? z)})${survey?.summary ? ': ' + String(survey.summary).slice(0, 200) : ''}` });
                return `observed:${id}`;
            }
            return 'none';
        } catch (e) {
            console.warn('[memory] observation watcher error:', e?.message || e);
            return null;
        } finally {
            if (started) this.busy = false;
        }
    }
}
