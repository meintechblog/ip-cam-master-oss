import { describe, it, expect, vi } from 'vitest';
// Keep the real SQLite out of the import chain (settings → db/client).
vi.mock('$lib/server/services/settings', () => ({ getSettings: vi.fn(async () => ({})) }));
import { GET } from './+server';

describe('GET /api/detections/status — graceful no-creds path', () => {
  it('returns 200 + disconnected + empty buffer, never throws', async () => {
    const res = await (GET as unknown as (e: unknown) => Promise<Response>)({});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connectionState).toBe('disconnected');
    expect(body.recent).toEqual([]);
    expect(body.lastEventAt).toBeNull();
    expect(body.started).toBe(false);
  });
});
