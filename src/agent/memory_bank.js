export class MemoryBank {
	constructor() {
		this.memory = {};
		this.archive = null; // MemoryManager: the persistent copy (bots/<name>/memory.db)
	}

	attach(archive) {
		this.archive = archive?.enabled ? archive : null;
	}

	rememberPlace(name, x, y, z) {
		this.memory[name] = [x, y, z];
		this.archive?.rememberHere(name, x, y, z);
	}

	recallPlace(name) {
		const local = this.memory[name];
		if (local) return local;
		const found = this.archive?.lookup(name);
		return found ? [found.x, found.y, found.z] : undefined;
	}

	getJson() {
		return this.memory
	}

	loadJson(json) {
		this.memory = json;
	}

	getKeys() {
		const names = new Set(Object.keys(this.memory));
		for (const n of this.archive?.placeNames() ?? []) names.add(n);
		return [...names].join(', ')
	}
}
