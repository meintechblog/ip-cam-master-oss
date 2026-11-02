// Routes that don't require auth (hooks.server.ts) and don't show the app shell (layout)
export const STANDALONE_ROUTES = ['/setup', '/login'];

// Routes that bypass auth middleware entirely
export const PUBLIC_PATHS = [...STANDALONE_ROUTES, '/api/auth', '/api/settings'];

export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

export function isStandalonePage(pathname: string): boolean {
	return STANDALONE_ROUTES.some((r) => pathname.startsWith(r));
}
