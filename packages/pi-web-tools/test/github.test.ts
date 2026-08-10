/**
 * Tests for GitHub site adapter (fetch/sites/github.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { githubRawUrl } from "../fetch/sites/github.js";
import { adaptUrl } from "../fetch/sites/index.js";

describe("githubRawUrl", () => {
	it("rewrites blob URLs to raw.githubusercontent.com", () => {
		assert.equal(
			githubRawUrl("https://github.com/everyx/pi-extensions/blob/main/package.json"),
			"https://raw.githubusercontent.com/everyx/pi-extensions/main/package.json",
		);
	});

	it("preserves the file path including subdirectories", () => {
		assert.equal(
			githubRawUrl("https://github.com/a/b/blob/main/src/deep/nested.ts"),
			"https://raw.githubusercontent.com/a/b/main/src/deep/nested.ts",
		);
	});

	it("handles non-main refs (branches, tags, commits)", () => {
		assert.equal(
			githubRawUrl("https://github.com/a/b/blob/v1.2.3/file.txt"),
			"https://raw.githubusercontent.com/a/b/v1.2.3/file.txt",
		);
	});

	it("returns null for non-blob GitHub URLs", () => {
		assert.equal(githubRawUrl("https://github.com/a/b/issues/1"), null);
		assert.equal(githubRawUrl("https://github.com/a/b/tree/main"), null);
		assert.equal(githubRawUrl("https://github.com/a/b/raw/main/file.txt"), null);
	});

	it("returns null for non-GitHub URLs", () => {
		assert.equal(githubRawUrl("https://example.com/a/b/blob/main/f.ts"), null);
		assert.equal(githubRawUrl("https://gitlab.com/a/b/blob/main/f.ts"), null);
	});
});

describe("adaptUrl", () => {
	it("applies the registry to a GitHub blob URL", () => {
		assert.equal(
			adaptUrl("https://github.com/a/b/blob/main/file.ts"),
			"https://raw.githubusercontent.com/a/b/main/file.ts",
		);
	});

	it("returns null when no adapter applies", () => {
		assert.equal(adaptUrl("https://example.com/page"), null);
	});
});
