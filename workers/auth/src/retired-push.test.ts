import { expect, it } from 'vitest';
import { handleRetiredPushRegistrations } from './retired-push';

const call = (method: string, path = '/api/auth/push/registrations') =>
  handleRetiredPushRegistrations(new Request(`https://test${path}`, { method }), {});

it('tells old Android builds that push registration is gone', () => {
  const response = call('PUT');
  expect(response?.status).toBe(410);
  expect(response?.headers.get('Cache-Control')).toBe('no-store');
});

it('answers a revocation with the 404 old clients treat as already revoked', () => {
  expect(call('DELETE', '/api/auth/push/registrations/firebase-installation-01')?.status).toBe(404);
});

it('leaves every other route to the main router', () => {
  expect(call('GET', '/api/auth/me')).toBeNull();
  expect(call('PUT', '/api/auth/pushy')).toBeNull();
});
