// Fake pi rpc-mode child for RpcClient tests (spawned via `command: "node"`).
// Protocol: echo each command back with a per-type delay — responses may
// arrive out of order relative to requests, exactly like the real child.
//
// Special command type "split_utf8" writes one response whose UTF-8 bytes are
// split mid-multibyte-character across two stdout chunks (the regression test
// for the StringDecoder double-decode bug).
import readline from "node:readline";

const DELAYS = { get_state: 60, steer: 10, abort: 40 };

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const cmd = JSON.parse(line);

	if (cmd.type === "split_utf8") {
		// Cut after the first byte of "文" (3-byte char): first chunk ends with
		// an incomplete multibyte sequence, second chunk completes it.
		const payload = JSON.stringify({
			id: cmd.id,
			type: "response",
			command: "split_utf8",
			success: true,
			data: { file: "路径/文件😀" },
		});
		const buf = Buffer.from(`${payload}\n`);
		const cut = Buffer.byteLength("路径/") + 1;
		process.stdout.write(buf.subarray(0, cut));
		setTimeout(() => process.stdout.write(buf.subarray(cut)), 20);
		return;
	}

	const delay = DELAYS[cmd.type] ?? 10;
	setTimeout(() => {
		const response = {
			id: cmd.id,
			type: "response",
			command: cmd.type,
			success: true,
			data: { echo: cmd.type },
		};
		process.stdout.write(`${JSON.stringify(response)}\n`);
	}, delay);
});
rl.on("close", () => process.exit(0));
