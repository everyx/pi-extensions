/**
 * Env-var helpers for tests.
 *
 * Test isolation is not just "other tests don't see my values" — it is also
 * "the values that were already there survive me". A developer shell may well
 * export `TINYFISH_API_KEY`, and a test that blindly deletes it in cleanup
 * breaks whatever runs after it in the same process.
 */

/** Set (or remove, when undefined) the named variables for the duration of fn. */
export async function withEnvVars(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const before = new Map(Object.keys(vars).map((name) => [name, process.env[name]] as const));
	for (const [name, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		await fn();
	} finally {
		for (const [name, value] of before) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** Run fn with the named variables absent, restoring whatever was there. */
export function withoutEnvVars(names: string[], fn: () => Promise<void>): Promise<void> {
	return withEnvVars(Object.fromEntries(names.map((name) => [name, undefined])), fn);
}
