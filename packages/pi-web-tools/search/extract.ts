/**
 * pi-web-tools — bsk result-extraction rules, single-sourced.
 *
 * The DOM side (EXTRACT_SCRIPT / STATE_PROBE_SCRIPT) runs inside the real
 * browser page and reduces it to JSON; the Node side (parseExtraction /
 * isCaptchaState / parsePageState) interprets that JSON. Both halves live
 * here so fixture tests hit the same rules the fuse engines exercise —
 * changing a selector heuristic no longer requires a live-browser smoke run
 * to know what its output means.
 */

import type { SearchResultItem } from "../types.js";

/** Runs inside the page: collect organic results (ad/AI-panel filtered,
 *  redirect-decoded, deduped) as a JSON array string. */
export const EXTRACT_SCRIPT = String.raw`
(() => {
	const out = [];
	const seen = new Set();
	const isAdOrAi = (titleEl, a) => {
		if (a && /adurl|aclk/.test(a.href)) return true;
		for (let n = titleEl.parentElement; n && n !== document.body; n = n.parentElement) {
			const cls = (typeof n.className === 'string' ? n.className : '') + ' ' + (n.getAttribute('data-text-ad') || '') + ' ' + (n.getAttribute('data-ad-text') || '') + ' ' + (n.getAttribute('data-ai-tracking-id') || '');
			const role = n.getAttribute('role') || '';
			const id = (n.id || '') + ' ' + (n.getAttribute('data-testid') || '');
			if (/\b(ad|ads|advertisement|sponsored|b_ad)\b/i.test(cls + role)) return true;
			if (/(^|[\s_-])(ai-pin|ai-overview|ai-answer|ai-summary|ai-search|b_ai|ai-container)([\s_-]|$)|^b_ai_|data-ai-tracking/i.test(cls + id)) return true;
		}
		return false;
	};
	const push = (titleEl) => {
		const a = titleEl.closest('a') || titleEl.querySelector('a');
		if (!a) return;
		let href = a.href || '';
		// Google may wrap result links in /url?q=<real-url> (cookie-less/flagged
		// traffic); normal logged-in traffic gets direct links — handle both.
		if (/google\.com\/url\?/.test(href)) {
			const m = href.match(/[?&](?:q|url)=([^&]+)/);
			if (m) {
				try {
					const decoded = decodeURIComponent(m[1]);
					if (decoded.startsWith("http")) href = decoded;
				} catch {
					// keep the redirect URL
				}
			}
		}
		const title = (titleEl.textContent || '').trim();
		if (!title || !href.startsWith('http') || seen.has(href) || isAdOrAi(titleEl, a)) return;
		// Skip the engine's own pages (local packs / "more results").
		if (/google\.com\/search|baidu\.com\/s/.test(href)) return;
		seen.add(href);
		let snippet = '';
		let n = titleEl;
		for (let i = 0; i < 4 && n; i++) {
			n = n.parentElement;
			if (!n) break;
			const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
			if (t.length > title.length) { snippet = t.slice(0, 300); break; }
		}
		out.push({ title, url: href, snippet });
	};
	document.querySelectorAll('h3, h2').forEach(push);
	return JSON.stringify(out);
})()
`;

/** Runs inside the page when extraction came back empty: enough state to
 *  tell an anti-bot wall from genuinely zero results. */
export const STATE_PROBE_SCRIPT = `JSON.stringify({ url: location.href, text: document.body ? document.body.innerText.slice(0, 200) : "" })`;

export interface PageState {
	url: string;
	text: string;
}

/** Node side of the probe: tolerate malformed payloads (keep defaults). */
export function parsePageState(raw: string): PageState {
	try {
		return JSON.parse(raw) as PageState;
	} catch {
		return { url: "", text: "" };
	}
}

/** Empty extraction + these markers = anti-bot wall, not zero results. */
export function isCaptchaState(state: PageState): boolean {
	return /captcha|not a robot|automated requests/i.test(`${state.url} ${state.text}`);
}

/** Node side of extraction: keep only entries with both url and title. */
export function parseExtraction(raw: string): SearchResultItem[] {
	try {
		const parsed = JSON.parse(raw) as SearchResultItem[];
		return parsed.filter((r) => r.url && r.title);
	} catch {
		throw new Error("real-browser channel: could not parse search results from page");
	}
}
