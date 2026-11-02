import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from '$lib/server/db/client';
import { users, settings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// --- Password hashing (scryptSync with salt) ---

export function hashPassword(password: string): string {
	const salt = randomBytes(16).toString('hex');
	const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
	return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
	const [salt, hash] = storedHash.split(':');
	if (!salt || !hash) return false;
	const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
	const storedBuffer = Buffer.from(hash, 'hex');
	if (derived.length !== storedBuffer.length) return false;
	return timingSafeEqual(derived, storedBuffer);
}

// --- In-memory session management ---

interface SessionData {
	userId: number;
	username: string;
	expiresAt: Date;
}

const sessions = new Map<string, SessionData>();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createSession(username: string): string {
	const sessionId = randomBytes(32).toString('hex');
	sessions.set(sessionId, {
		userId: 0,
		username,
		expiresAt: new Date(Date.now() + SESSION_TTL_MS)
	});
	return sessionId;
}

export function validateSession(sessionId: string): SessionData | null {
	const session = sessions.get(sessionId);
	if (!session) return null;
	if (session.expiresAt < new Date()) {
		sessions.delete(sessionId);
		return null;
	}
	return session;
}

export function deleteSession(sessionId: string): void {
	sessions.delete(sessionId);
}

// --- YOLO mode ---

export function isYoloMode(): boolean {
	const row = db.select().from(settings).where(eq(settings.key, 'auth_yolo')).get();
	return row?.value === 'true';
}

// --- User management ---

export function getUser(): { id: number; username: string; passwordHash: string } | null {
	return db.select().from(users).get() ?? null;
}

// --- Session cleanup (call from scheduler) ---

export function cleanupExpiredSessions(): void {
	const now = new Date();
	for (const [id, session] of sessions.entries()) {
		if (session.expiresAt < now) sessions.delete(id);
	}
}

export function createUser(username: string, password: string): void {
	const passwordHash = hashPassword(password);
	// Single user only (D-27): delete existing, then insert
	db.delete(users).run();
	db.insert(users).values({ username, passwordHash }).run();
}

export function deleteUser(): void {
	db.delete(users).run();
}

// --- Cookie helpers ---

export function setSessionCookie(cookies: { set: (name: string, value: string, opts: any) => void }, sessionId: string): void {
	cookies.set('session', sessionId, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: SESSION_TTL_MS / 1000
	});
}
