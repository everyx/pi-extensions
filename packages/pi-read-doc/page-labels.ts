/**
 * How a set of page numbers becomes human-readable text: the compact list a
 * block or a note carries ("3, 7", "21-137"), and the sentence telling the USER
 * what the hosted service did with those pages. Pure, and deliberately not part
 * of the chain: the chain and the model payload (`blocks.ts`) both need the list
 * formatter, and neither should have to reach into the other for a string
 * formatter.
 */

// ── Page lists ────────────────────────────────────────────────

/**
 * Compact page list: "3", "1-2", "3, 7", "21-137". Consecutive runs collapse —
 * a "not read" block can cover a hundred pages, and a hundred numbers is a
 * hundred tokens of nothing.
 */
export function formatPages(pages: readonly number[]): string {
	const sorted = [...new Set(pages)].sort((a, b) => a - b);
	const parts: string[] = [];
	let start: number | undefined;
	let prev: number | undefined;
	const flush = () => {
		if (start === undefined || prev === undefined) return;
		parts.push(start === prev ? `${start}` : `${start}-${prev}`);
	};
	for (const page of sorted) {
		if (prev !== undefined && page === prev + 1) {
			prev = page;
			continue;
		}
		flush();
		start = page;
		prev = page;
	}
	flush();
	return parts.join(", ");
}

/** What the reader should know about a hosted conversion: the service converts
 *  the whole document and returns one blob, so the pages cannot be split out —
 *  but which pages it had to read as images we know exactly. This rides the
 *  card's hint, NOT the model's payload: where the text came from is nothing the
 *  model can act on, and the caveat this used to carry ("may misread") is the
 *  model's own prior. */
export function hostedNote(flagged: readonly number[], pageCount: number): string {
	const listed =
		flagged.length >= pageCount
			? "every page was"
			: flagged.length > 8
				? `${flagged.length} pages were`
				: `pages ${formatPages(flagged)} were`;
	return `${listed} read by hosted OCR`;
}
