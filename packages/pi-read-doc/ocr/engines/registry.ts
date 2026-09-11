/**
 * The registry: the one place a configured name becomes a live engine.
 *
 * Engines are process-scoped, not per-read: they hold caches worth keeping (the
 * rapidocr interpreter probe, poppler's tool check, later an ONNX session).
 * Construction is lazy, so a config that never names an engine never pays for
 * it, and synchronous, so two concurrent reads cannot build two.
 *
 * The instance table belongs to the factory table (a WeakMap keyed by it). That
 * is what lets a test hand in its own factories, observe exactly what got built
 * and never touch the production instances.
 */

import type { Engine, EngineId } from "../../convert.js";
import { createFirecrawlEngine } from "./firecrawl/engine.js";
import { createRapidocrEngine } from "./rapidocr/engine.js";

export type EngineFactory = () => Engine;

/** Production factories. `Record<EngineId, …>`: an id without a factory does
 *  not compile, so the config vocabulary and the engines cannot drift apart. */
export const ENGINE_FACTORIES: Record<EngineId, EngineFactory> = {
	firecrawl: createFirecrawlEngine,
	rapidocr: createRapidocrEngine,
};

const registries = new WeakMap<Record<EngineId, EngineFactory>, Map<EngineId, Engine>>();

/** A registry is a (factory table + instance table) pair. */
function registryFor(factories: Record<EngineId, EngineFactory>): Map<EngineId, Engine> {
	let instances = registries.get(factories);
	if (!instances) {
		instances = new Map();
		registries.set(factories, instances);
	}
	return instances;
}

export function engineFor(id: EngineId, factories: Record<EngineId, EngineFactory> = ENGINE_FACTORIES): Engine {
	const built = registryFor(factories);
	let engine = built.get(id);
	if (!engine) {
		engine = factories[id]();
		built.set(id, engine);
	}
	return engine;
}

/** Engines in the order the configuration asked for — that order IS the policy. */
export function enginesFor(
	ids: readonly EngineId[],
	factories: Record<EngineId, EngineFactory> = ENGINE_FACTORIES,
): Engine[] {
	return ids.map((id) => engineFor(id, factories));
}

/** Forget the instances built from these factories: test isolation, and where a
 *  future `dispose` would hang. The page reader's own probe cache is
 *  process-wide and is NOT cleared here — inject your own to reset that. */
export function resetEngines(factories: Record<EngineId, EngineFactory> = ENGINE_FACTORIES): void {
	registryFor(factories).clear();
}
