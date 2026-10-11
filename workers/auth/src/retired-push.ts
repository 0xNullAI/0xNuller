import { err } from './http';

const PATH = '/api/auth/push/registrations';

/**
 * System push (FCM) was removed: most users' phones have no Google services, so unread counts
 * stay in-app only. Android builds released before the removal may still call these routes.
 * They get a quiet, final answer instead of an error: registration is gone (410), and a
 * revocation answers 404, which those clients already treat as "nothing left to revoke" so
 * they stop retrying.
 */
export function handleRetiredPushRegistrations(
  request: Request,
  cors: Record<string, string>,
): Response | null {
  const path = new URL(request.url).pathname;
  if (path !== PATH && !path.startsWith(`${PATH}/`)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  if (path === PATH && request.method === 'PUT') return err('系统推送已停用', 410, headers);
  return err('接口不存在', 404, headers);
}
