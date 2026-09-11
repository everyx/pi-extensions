/**
 * The model payload for a page-block read: `RecoveredBlock[]` → the JSON the
 * model receives, under pi's own truncation envelope. Kept apart from the tool
 * wiring (index.ts) because it is a serializer with a budget, not plumbing —
 * and the card's human rendering of the same blocks sits beside it.
 */

import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { RecoveredBlock } from "./ocr/recovered-block.js";
import { formatPages } from "./page-labels.js";

/** The block form's budget, in bytes — pi's own truncation envelope, imported
 *  rather than copied, so the two cannot drift apart. */
export const LLM_BUDGET_BYTES = DEFAULT_MAX_BYTES;

/** First guess at the room the omission stubs need; the loop below shrinks the
 *  content allowance until the WHOLE array fits, so a page never vanishes from
 *  the reply because the note explaining it had no room. */
const OMISSION_RESERVE = 512;
/** Page numbers the summary stub lists before it just counts the rest. */
const MAX_SUMMARY_PAGES = 8;

/** Worst-case size of the summary stub, so the reserve can actually hold it —
 *  the summary is the one block that must always fit (it is the only thing
 *  that says pages were left out). */
function summaryStubBytes(): number {
	const worst = {
		// Scattered, not consecutive: `formatPages` collapses a run into "a-b",
		// so only non-adjacent pages show the summary's real size.
		pages: Array.from({ length: MAX_SUMMARY_PAGES }, (_, i) => 100000 + i * 2),
		text: "",
		note: "also omitted: output budget (+999999 more pages)",
	};
	return Buffer.byteLength(serializeBlock(worst), "utf-8") + 1;
}

/** One block as it goes on the wire: `pages` collapses to "21-137" (a hundred
 *  numbers is a hundred tokens of nothing) and empty fields are omitted rather
 *  than sent blank. Also what the budget measures. */
function serializeBlock(b: RecoveredBlock): string {
	return JSON.stringify({
		pages: formatPages(b.pages),
		...(b.text ? { text: b.text } : {}),
		...(b.image ? { image: b.image } : {}),
		...(b.note ? { note: b.note } : {}),
	});
}

/**
 * Serialize recovered blocks for the LLM, budgeting BEFORE serializing: a
 * truncated JSON string is unparseable, so blocks are measured as they are
 * kept and the shortfall becomes a labelled block of its own. An oversized
 * block is skipped rather than fatal, so one big text run cannot starve the
 * small OCR pages behind it.
 */
export function blocksForLlm(blocks: RecoveredBlock[], maxBytes = LLM_BUDGET_BYTES): { json: string } {
	// Content first: the reserve only ever pays for the notes about what did not
	// fit, never the other way round (dropping content to fit a note about
	// dropped content is the tail wagging the dog).
	const reserve = Math.min(OMISSION_RESERVE, Math.floor(maxBytes / 4));
	const kept: RecoveredBlock[] = [];
	const dropped: RecoveredBlock[] = [];
	let used = 0;
	for (const block of blocks) {
		// Measured as it will be sent — the block plus its separator: paths and
		// notes are part of the payload, and the commas between entries add up
		// (a hundred entries is a hundred bytes nobody counted before).
		const size = Buffer.byteLength(serializeBlock(block), "utf-8") + 1;
		if (used + size > maxBytes - reserve - 2) {
			dropped.push(block);
			continue;
		}
		used += size;
		kept.push(block);
	}
	// Grouped by what each dropped block already said: a page that was READ and
	// merely did not fit is reported as such, while a block that was already a
	// gap keeps its own note — that note is still the truth. Distinct notes are
	// bounded by the reserve; anything past it is summarised (the reasons are
	// per-page engine errors, which can differ page by page).
	// One stub per run of CONSECUTIVE dropped blocks that share a note, so the
	// array stays in page order: a stub sits where the pages it describes sit,
	// and its own pages are contiguous.
	const runs: { pages: number[]; note: string }[] = [];
	for (const block of dropped) {
		const note = block.text ? "read but omitted: output budget" : (block.note ?? "not read: output budget");
		const last = runs[runs.length - 1];
		const previous = last?.pages[last.pages.length - 1];
		if (last?.note === note && previous !== undefined && block.pages[0] === previous + 1) {
			last.pages = [...last.pages, ...block.pages];
			continue;
		}
		runs.push({ pages: [...block.pages], note });
	}
	const stubs: RecoveredBlock[] = [];
	let stubBytes = 0;
	let overflow: number[] = [];
	for (const { pages, note } of runs) {
		const stub: RecoveredBlock = { pages, text: "", note };
		const size = Buffer.byteLength(serializeBlock(stub), "utf-8") + 1;
		// Keep a slot free for the summary stub: it must fit the same reserve.
		if (stubBytes + size <= reserve - summaryStubBytes()) {
			stubs.push(stub);
			stubBytes += size;
			continue;
		}
		overflow = [...overflow, ...pages];
	}
	if (overflow.length > 0) {
		// Bounded like everything else: a scattered page list is capped and the
		// remainder is counted, so no stub can outgrow the budget it obeys.
		const shown = overflow.slice(0, MAX_SUMMARY_PAGES);
		const rest = overflow.length - shown.length;
		stubs.push({
			pages: shown,
			text: "",
			note: rest > 0 ? `also omitted: output budget (+${rest} more pages)` : "also omitted: output budget",
		});
	}
	// Page order is the array's contract; omission stubs belong where the pages
	// they describe belong, not at the tail.
	const all = [...kept, ...stubs].sort((a, b) => (a.pages[0] ?? 0) - (b.pages[0] ?? 0));
	return { json: `[${all.map(serializeBlock).join(",")}]` };
}

/**
 * The card's rendering of recovered blocks. The LLM gets JSON (structure it can
 * act on); a human expanding the card gets this — page headers, the text, and
 * where the original page image is. Two audiences, two renderings: raw JSON in
 * a card is a debugging aid, not a document.
 */
export function blocksToText(blocks: RecoveredBlock[]): string {
	return blocks
		.map((b) => {
			const header = `## Page ${formatPages(b.pages)}`;
			const body = [b.text, b.note ? `(${b.note})` : ""].filter(Boolean).join("\n");
			const image = b.image ? `[source page image: ${b.image}]` : "";
			return [header, body, image].filter(Boolean).join("\n");
		})
		.join("\n\n");
}
