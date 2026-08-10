/**
 * pi-web-tools — site-specific adapters (SPEC: web_fetch 行为规格).
 *
 * One file per site. These rewrite/transform URLs so web_fetch returns the
 * content the LLM actually wants instead of a site's UI chrome.
 */

/**
 * github.com blob URLs → raw.githubusercontent.com: fetch the file content
 * instead of the HTML UI. Branch is taken as a single path segment; raw/
 * links already redirect.
 */
export function githubRawUrl(url: string): string | null {
	const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
	if (!m) return null;
	return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
}
