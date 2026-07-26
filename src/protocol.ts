/**
 * pi-subagent — child→parent result transport.
 *
 * Length‑prefixed framing over a Unix socket.
 * Protocol: `[4B big‑endian payload length][payload]`.
 * Payload is `sessionName\0text` (sessionName may be empty → no NUL separator).
 */

import type * as net from "node:net";

export interface PrefixedMessage {
	sessionName: string;
	text: string;
}

/**
 * Read one length‑prefixed message from a connected socket.
 * Resolves with the parsed payload, or rejects on error/timeout/abort/connection close.
 */
export function readLengthPrefixed(socket: net.Socket, signal?: AbortSignal): Promise<PrefixedMessage> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0);

		const onAbort = () => done(new Error("Aborted"));
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });

		const timer = setTimeout(() => done(new Error("Timeout reading from socket")), 10_000);

		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length < 4) return;
			const len = buf.readUInt32BE(0);
			if (buf.length < 4 + len) return;
			const payload = buf.subarray(4, 4 + len);
			done(undefined, payload);
		};
		const onError = (err: Error) => done(err);
		const onClose = () => done(new Error("Socket closed before full message"));

		function done(err?: Error, payload?: Buffer) {
			cleanup();
			signal?.removeEventListener("abort", onAbort);
			if (err) return reject(err);
			// At this point `payload` was set by `onData` before calling `done(undefined, payload)`.
			const [sessionName, text] = splitPayload(payload as Buffer);
			resolve({ sessionName, text });
		}
		function cleanup() {
			clearTimeout(timer);
			socket.removeListener("data", onData);
			socket.removeListener("error", onError);
			socket.removeListener("close", onClose);
			socket.removeListener("end", onClose);
		}

		socket.on("data", onData);
		socket.on("error", onError);
		socket.on("close", onClose);
		socket.on("end", onClose);
	});
}

/** Parse `sessionName\0text` (or plain text when no NUL present). */
export function splitPayload(payload: Buffer): [string, string] {
	const nullIdx = payload.indexOf(0);
	if (nullIdx < 0) return ["", payload.toString("utf8")];
	const sessionName = payload.subarray(0, nullIdx).toString("utf8");
	const text = payload.subarray(nullIdx + 1).toString("utf8");
	return [sessionName, text];
}

/** Encode `sessionName\0text` (or just text when sessionName is empty). */
export function encodePayload(sessionName: string, text: string): Buffer {
	return sessionName ? Buffer.from(`${sessionName}\0${text}`, "utf8") : Buffer.from(text, "utf8");
}

/**
 * Write one length‑prefixed message to a connected socket.
 * Resolves once the framed buffer is flushed.
 */
export function writeLengthPrefixed(socket: net.Socket, sessionName: string, text: string): Promise<void> {
	const payload = encodePayload(sessionName, text);
	const hdr = Buffer.alloc(4);
	hdr.writeUInt32BE(payload.length);
	const frame = Buffer.concat([hdr, payload]);

	return new Promise<void>((resolve, reject) => {
		socket.write(frame, (err) => (err ? reject(err) : resolve()));
	});
}
