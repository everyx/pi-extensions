/**
 * One slice of a converted document, in page order.
 *
 * A leaf: the OCR engines produce these, the walk passes them through, and
 * `blocks.ts` serializes them for the model. Nothing here depends on anything.
 */
export interface RecoveredBlock {
	/** Pages this block covers (1-based, ascending). */
	pages: number[];
	text: string;
	/** Source page image — only on pages whose text came from OCR. */
	image?: string;
	/** Anything the reader should know that it cannot see for itself: that the
	 *  page held no text, why a page is missing. Natural language, and it
	 *  accompanies text rather than replacing it. */
	note?: string;
}
