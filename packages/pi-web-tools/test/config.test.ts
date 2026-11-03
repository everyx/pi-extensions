/**
 * Tests for key resolution (config.ts): environment first, then the user's
 * `web-tools.json`. The file is the reason someone without shell-config skills
 * can use a key at all, so "it silently contributes nothing" is the behaviour
 * that matters most — a missing or broken file must behave exactly like an
 * unset variable, never like an error.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { apiKey, readKeys, resetKeysCache } from "../config.js";

const dir = mkdtempSync(join(tmpdir(), "pi-web-tools-keys-"));
const write = (name: string, body: string): string => {
	const file = join(dir, name);
	writeFileSync(file, body);
	return file;
};

afterEach(() => {
	resetKeysCache();
	delete process.env.TINYFISH_API_KEY;
	delete process.env.EXA_API_KEY;
	delete process.env.TAVILY_API_KEY;
	delete process.env.FIRECRAWL_API_KEY;
});

describe("readKeys — a broken file contributes nothing", () => {
	it("reads a flat provider → key object", () => {
		const file = write("ok.json", JSON.stringify({ tinyfish: "t", exa: " e " }));
		assert.deepEqual(readKeys(file), { tinyfish: "t", exa: "e" }, "values are trimmed");
	});

	it("treats a missing file as empty", () => {
		assert.deepEqual(readKeys(join(dir, "nope.json")), {});
	});

	it("treats malformed JSON, arrays and scalars as empty", () => {
		assert.deepEqual(readKeys(write("bad.json", "{oops")), {});
		assert.deepEqual(readKeys(write("arr.json", "[1,2]")), {});
		assert.deepEqual(readKeys(write("scalar.json", '"x"')), {});
	});

	it("ignores entries that are not usable strings", () => {
		const file = write(
			"mixed.json",
			JSON.stringify({ tinyfish: "t", empty: "   ", num: 3, nested: { a: 1 }, nul: null }),
		);
		assert.deepEqual(readKeys(file), { tinyfish: "t" }, "unknown or unusable keys are dropped, not fatal");
	});
});

describe("apiKey — environment wins, file fills the gaps", () => {
	const file = join(dir, "keys.json");
	writeFileSync(file, JSON.stringify({ tinyfish: "from-file", exa: "exa-file" }));

	it("prefers the environment over the file", () => {
		process.env.TINYFISH_API_KEY = "from-env";
		assert.equal(apiKey("tinyfish", file), "from-env");
	});

	it("falls back to the file when the variable is absent", () => {
		assert.equal(apiKey("tinyfish", file), "from-file");
	});

	it("treats a blank variable as unset, not as an override", () => {
		process.env.EXA_API_KEY = "   ";
		assert.equal(apiKey("exa", file), "exa-file");
	});

	it("returns null when neither source has the provider", () => {
		assert.equal(apiKey("tavily", file), null);
		assert.equal(apiKey("firecrawl", join(dir, "missing.json")), null);
	});
});

describe("apiKey — the file is read once, the environment is not", () => {
	it("caches per file until the cache is cleared", () => {
		const file = join(dir, "cached.json");
		writeFileSync(file, JSON.stringify({ tinyfish: "key-A" }));
		assert.equal(apiKey("tinyfish", file), "key-A");

		// Rewriting the file mid-session must not change what the session sees:
		// one read per process is the documented behaviour.
		writeFileSync(file, JSON.stringify({ tinyfish: "key-B" }));
		assert.equal(apiKey("tinyfish", file), "key-A", "still the first read");

		resetKeysCache();
		assert.equal(apiKey("tinyfish", file), "key-B", "a reset re-reads");
	});

	it("re-reads the environment every time, so an override applies immediately", () => {
		const file = join(dir, "cached2.json");
		writeFileSync(file, JSON.stringify({ exa: "file-exa" }));
		assert.equal(apiKey("exa", file), "file-exa");
		process.env.EXA_API_KEY = "env-now";
		assert.equal(apiKey("exa", file), "env-now");
	});
});
