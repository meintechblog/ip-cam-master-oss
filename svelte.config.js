import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter()
		// v1.3 Phase 22 CR-02 fix — removed `csrf: { trustedOrigins: ['*'] }`.
		// The wildcard disabled SvelteKit's built-in Origin check for every
		// POST endpoint, which exposes mutating wizard/output endpoints
		// (/api/protect-hub/wizard/*, /api/cameras/*/outputs) to cross-origin
		// requests from any site the user is logged in to. The default
		// behaviour (Origin must match the request host) is correct for a
		// LAN-only self-hosted tool — same-origin requests from the app's
		// own UI continue to work, and the in-app installer/Bambu/Hub flows
		// have no cross-origin senders.
	}
};

export default config;
