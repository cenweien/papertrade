// Mock auth helpers — used when VITE_AUTH_MODE=mock.
//
// We don't actually authenticate anywhere; we synthesise a session-like
// object that satisfies the shape App.tsx and db.ts consume. Supabase's
// Row Level Security keys the user table by `auth.uid()`, so any rows
// inserted in mock mode land under this fake user id. If/when you point
// the env back at a real Supabase project, the same code path stops
// using these helpers and falls back to the normal auth flow.

import type { Session, User } from '@supabase/supabase-js';

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001';

export const isMockAuth = (): boolean =>
  (import.meta.env.VITE_AUTH_MODE ?? '') === 'mock';

export function mockUser(): User {
  return {
    id: MOCK_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'mock@local',
    phone: '',
    app_metadata: { provider: 'mock' },
    user_metadata: {},
    identities: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    is_anonymous: true,
    email_confirmed_at: '2024-01-01T00:00:00Z',
    phone_confirmed_at: undefined,
    last_sign_in_at: '2024-01-01T00:00:00Z',
    factor_instances: undefined,
  } as unknown as User;
}

export function mockSession(): Session {
  return {
    access_token: 'mock-token',
    refresh_token: 'mock-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: mockUser(),
  } as unknown as Session;
}
