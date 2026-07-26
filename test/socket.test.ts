import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readLengthPrefixed, writeLengthPrefixed } from "../src/protocol.ts";

/** Create a temporary socket path. */
function tmpSocket(): string {
	return join(tmpdir(), `socket-test-${randomBytes(4).toString("hex")}.sock`);
}

/**
 * Set up a server that reads one length‑prefixed message then closes.
 * Returns `{ server, ready }` – await `ready` before connecting clients.
 */
function serveOnce(path: string, fn: (msg: { sessionName: string; text: string }) => void): { ready: Promise<void> } {
	const server = createServer(async (socket) => {
		try {
			const msg = await readLengthPrefixed(socket);
			socket.end();
			fn(msg);
		} finally {
			server.close();
		}
	});
	const ready = new Promise<void>((resolve) => server.listen(path, resolve));
	return { ready };
}

/** Connect a client and send one length‑prefixed message. */
async function sendAndEnd(path: string, sessionName: string, text: string): Promise<void> {
	const socket = connect(path);
	await new Promise<void>((resolve, reject) => {
		socket.on("connect", resolve);
		socket.on("error", reject);
	});
	await writeLengthPrefixed(socket, sessionName, text);
	socket.end();
}

// ─── Tests ───────────────────────────────────────────────────────

describe("length‑prefixed socket protocol", () => {
	it("normal message round‑trip", async () => {
		const path = tmpSocket();
		try {
			const msg = await new Promise<{ sessionName: string; text: string }>((resolve) => {
				const { ready } = serveOnce(path, resolve);
				ready.then(() => sendAndEnd(path, "test-session", "hello world"));
			});
			assert.equal(msg.sessionName, "test-session");
			assert.equal(msg.text, "hello world");
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ok */
			}
		}
	});

	it("empty session name", async () => {
		const path = tmpSocket();
		try {
			const msg = await new Promise<{ sessionName: string; text: string }>((resolve) => {
				const { ready } = serveOnce(path, resolve);
				ready.then(() => sendAndEnd(path, "", "just text"));
			});
			assert.equal(msg.sessionName, "");
			assert.equal(msg.text, "just text");
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ok */
			}
		}
	});

	it("empty text", async () => {
		const path = tmpSocket();
		try {
			const msg = await new Promise<{ sessionName: string; text: string }>((resolve) => {
				const { ready } = serveOnce(path, resolve);
				ready.then(() => sendAndEnd(path, "s", ""));
			});
			assert.equal(msg.sessionName, "s");
			assert.equal(msg.text, "");
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ok */
			}
		}
	});

	it("multi‑byte UTF‑8 characters", async () => {
		const path = tmpSocket();
		const text = "中文 émoticônes 👍 🎉 你好世界";
		try {
			const msg = await new Promise<{ sessionName: string; text: string }>((resolve) => {
				const { ready } = serveOnce(path, resolve);
				ready.then(() => sendAndEnd(path, "ses", text));
			});
			assert.equal(msg.sessionName, "ses");
			assert.equal(msg.text, text);
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ok */
			}
		}
	});

	it("large message (~100KB)", async () => {
		const path = tmpSocket();
		const largeText = "x".repeat(100_000);
		try {
			const msg = await new Promise<{ sessionName: string; text: string }>((resolve) => {
				const { ready } = serveOnce(path, resolve);
				ready.then(() => sendAndEnd(path, "big-session", largeText));
			});
			assert.equal(msg.sessionName, "big-session");
			assert.equal(msg.text.length, 100_000);
			assert.equal(msg.text, largeText);
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ok */
			}
		}
	});

	it("AbortSignal cancels reading before any data arrives", async () => {
		const path = tmpSocket();
		try {
			// Start server but don't send data — just hold the connection
			const server = createServer(() => {
				/* accept but stay silent */
			});
			await new Promise<void>((resolve) => server.listen(path, resolve));

			const ac = new AbortController();
			const socket = connect(path);
			await new Promise<void>((resolve, reject) => {
				socket.on("connect", resolve);
				socket.on("error", reject);
			});

			const readPromise = readLengthPrefixed(socket, ac.signal);
			ac.abort();

			await assert.rejects(readPromise, { message: "Aborted" });

			socket.end();
			server.close();
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ok */
			}
		}
	});

	it("client disconnects before sending full header", async () => {
		const path = tmpSocket();
		try {
			const server = createServer(async (socket) => {
				await assert.rejects(readLengthPrefixed(socket), /Socket closed before full message/);
				server.close();
			});
			await new Promise<void>((resolve) => server.listen(path, resolve));

			const socket = connect(path);
			await new Promise<void>((resolve, reject) => {
				socket.on("connect", resolve);
				socket.on("error", reject);
			});
			// Write only 2 bytes of the 4-byte header, then disconnect
			socket.write(Buffer.from([0, 0]));
			socket.end();

			await new Promise<void>((resolve) => server.on("close", resolve));
		} finally {
			try {
				unlinkSync(path);
			} catch {
				/* ok */
			}
		}
	});
});
