/**
 * Copy a string to the clipboard with a legacy fallback for insecure
 * contexts (HTTP over LAN, where `navigator.clipboard` is silently blocked
 * by browsers).
 *
 * Strategy:
 *  1. Try `navigator.clipboard.writeText` — works on HTTPS / localhost
 *  2. Fall back to a hidden textarea + `document.execCommand('copy')`
 *     — works everywhere including plain HTTP
 *
 * Returns true on success, false if every path failed.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	if (typeof window === 'undefined') return false;
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to legacy path
	}
	try {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.top = '-1000px';
		ta.style.left = '-1000px';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}
