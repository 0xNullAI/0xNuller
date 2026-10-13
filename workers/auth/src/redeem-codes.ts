import {
  CREDIT_PRICE_VERSION,
  REDEEM_CODE_ALPHABET,
  REDEEM_CODE_LENGTH,
  creditTierForCny,
  normalizeRedeemCode,
} from '@0xnullai/auth/credit-tiers';
import { err, json, readJson } from './http';
import { currentUser, sha256Hex, type SessionEnv } from './session-domain';

/**
 * Redeem keys: the only way Credit is sold. An admin mints a batch of single-use 64-character
 * keys for one tier and hands them out; a user types one in and the tier's Credit lands in the
 * ledger. Only each key's SHA-256 and last four characters are stored, so the database never
 * holds a usable key and the plaintext is seen once, by the admin who minted it.
 */

const REDEEM_PATH = '/api/auth/credits/redeem';
const ADMIN = '/api/auth/admin/redeem-codes';

/** Failures within this window count toward a lockout; the lock lifts as they age out. */
export const REDEEM_FAILURE_WINDOW_MS = 30 * 60 * 1000;
export const MAX_REDEEM_FAILURES_PER_ACCOUNT = 5;
export const MAX_REDEEM_FAILURES_PER_IP = 20;
export const MAX_CODES_PER_BATCH = 100;
const PAGE = 30;

export async function handleRedeemCodes(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
  ipHash: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== REDEEM_PATH && path !== ADMIN && !path.startsWith(`${ADMIN}/`)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at !== null || request.headers.get('X-Account-Id') !== user.id)
    return err('账号不可用或已切换', 403, headers);

  if (path === REDEEM_PATH) {
    if (request.method !== 'POST') return err('不支持此操作', 405, headers);
    return redeem(request, env, user.id, ipHash, headers);
  }

  if (user.role !== 'admin') return err('无管理权限', 403, headers);
  if (path === ADMIN && request.method === 'POST') return mint(request, env, user.id, headers);
  if (path === `${ADMIN}/batches` && request.method === 'GET')
    return listBatches(env, new URL(request.url), headers);
  const batch = path.match(/^\/api\/auth\/admin\/redeem-codes\/batches\/([^/]+)$/);
  if (batch && request.method === 'GET')
    return listBatchCodes(env, decodeURIComponent(batch[1]!), headers);
  if (path === `${ADMIN}/redemptions` && request.method === 'GET')
    return listRedemptions(env, new URL(request.url), headers);
  return err('不支持此操作', 405, headers);
}

async function redeem(
  request: Request,
  env: SessionEnv,
  userId: string,
  ipHash: string,
  headers: Record<string, string>,
): Promise<Response> {
  const now = Date.now();
  const since = now - REDEEM_FAILURE_WINDOW_MS;
  const [byAccount, byIp] = await Promise.all([
    env.DB.prepare(
      'SELECT COUNT(*) AS n FROM redeem_attempts WHERE user_id = ? AND ok = 0 AND created_at >= ?',
    )
      .bind(userId, since)
      .first<{ n: number }>(),
    env.DB.prepare(
      'SELECT COUNT(*) AS n FROM redeem_attempts WHERE ip_hash = ? AND ok = 0 AND created_at >= ?',
    )
      .bind(ipHash, since)
      .first<{ n: number }>(),
  ]);
  if (
    Number(byAccount?.n ?? 0) >= MAX_REDEEM_FAILURES_PER_ACCOUNT ||
    Number(byIp?.n ?? 0) >= MAX_REDEEM_FAILURES_PER_IP
  ) {
    return err('卡密输错次数过多，请 30 分钟后再试', 429, headers);
  }

  const record = (ok: boolean) =>
    env.DB.prepare(
      'INSERT INTO redeem_attempts (user_id, ip_hash, ok, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(userId, ipHash, ok ? 1 : 0, now)
      .run();
  const body = await readJson(request, { lenient: true });
  const code = typeof body.code === 'string' ? normalizeRedeemCode(body.code) : null;
  if (!code) {
    await record(false);
    return err('卡密无效，请检查后重新输入', 400, headers);
  }
  const hash = await sha256Hex(code);
  const row = await env.DB.prepare(
    'SELECT id, batch_id, amount_credits, redeemed_at FROM redeem_codes WHERE code_hash = ?',
  )
    .bind(hash)
    .first<{ id: string; batch_id: string; amount_credits: number; redeemed_at: number | null }>();
  if (!row) {
    await record(false);
    return err('卡密无效，请检查后重新输入', 400, headers);
  }
  if (row.redeemed_at !== null) {
    await record(false);
    return err('这个卡密已经被使用', 409, headers);
  }

  const referenceId = `redeem:${row.id}`;
  // One batch, so the key is marked used and the Credit lands together or not at all. The
  // ledger insert only takes effect for the request whose UPDATE claimed the key.
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        'UPDATE redeem_codes SET redeemed_by = ?, redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL',
      ).bind(userId, now, row.id),
      env.DB.prepare(
        `INSERT INTO credit_ledger
          (user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at)
         SELECT ?, amount_credits, 'manual_purchase', ?, ?, ?, ?
           FROM redeem_codes WHERE id = ? AND redeemed_by = ? AND redeemed_at = ?`,
      ).bind(
        userId,
        referenceId,
        CREDIT_PRICE_VERSION,
        JSON.stringify({ source: 'redeem_code', batchId: row.batch_id }),
        now,
        row.id,
        userId,
        now,
      ),
      env.DB.prepare(
        'INSERT INTO redeem_attempts (user_id, ip_hash, ok, created_at) VALUES (?, ?, 1, ?)',
      ).bind(userId, ipHash, now),
    ]);
  } catch (cause) {
    if (String(cause).includes('UNIQUE')) return err('这个卡密已经被使用', 409, headers);
    throw cause;
  }
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    await record(false);
    return err('这个卡密已经被使用', 409, headers);
  }
  return json(
    { ok: true, amountCredits: Number(row.amount_credits), referenceId, redeemedAt: now },
    201,
    headers,
  );
}

async function mint(
  request: Request,
  env: SessionEnv,
  operatorId: string,
  headers: Record<string, string>,
): Promise<Response> {
  const body = await readJson(request, { lenient: true });
  const tier = creditTierForCny(Math.trunc(Number(body.amountCny)));
  const count = Math.trunc(Number(body.count));
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
  if (!tier) return err('请选择一个固定档位', 400, headers);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CODES_PER_BATCH)
    return err(`每批数量为 1 到 ${MAX_CODES_PER_BATCH}`, 400, headers);

  const now = Date.now();
  const batchId = `rb_${crypto.randomUUID()}`;
  const codes = Array.from({ length: count }, () => randomCode());
  const hashes = await Promise.all(codes.map((code) => sha256Hex(code)));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO redeem_batches
        (id, amount_cny, amount_credits, code_count, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(batchId, tier.amountCny, tier.credits, count, note, operatorId, now),
    ...codes.map((code, index) =>
      env.DB.prepare(
        `INSERT INTO redeem_codes (id, batch_id, code_hash, code_tail, amount_credits, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        `rc_${crypto.randomUUID()}`,
        batchId,
        hashes[index]!,
        code.slice(-4),
        tier.credits,
        now,
      ),
    ),
  ]);
  return json(
    {
      batch: {
        id: batchId,
        amountCny: tier.amountCny,
        amountCredits: tier.credits,
        count,
        note,
        createdAt: now,
      },
      // Shown once: the server keeps only hashes from here on.
      codes,
    },
    201,
    headers,
  );
}

async function listBatches(
  env: SessionEnv,
  url: URL,
  headers: Record<string, string>,
): Promise<Response> {
  const before = cursor(url);
  if (before === undefined) return err('游标无效', 400, headers);
  const rows = await env.DB.prepare(
    `SELECT b.id, b.amount_cny, b.amount_credits, b.code_count, b.note, b.created_at,
            u.username AS operator,
            (SELECT COUNT(*) FROM redeem_codes c WHERE c.batch_id = b.id AND c.redeemed_at IS NOT NULL) AS redeemed
       FROM redeem_batches b LEFT JOIN users u ON u.id = b.created_by
      ${before === null ? '' : 'WHERE b.created_at < ?'}
      ORDER BY b.created_at DESC LIMIT ${PAGE + 1}`,
  )
    .bind(...(before === null ? [] : [before]))
    .all<Record<string, unknown>>();
  const page = rows.results.slice(0, PAGE);
  return json(
    {
      batches: page.map((row) => ({
        id: String(row.id),
        amountCny: Number(row.amount_cny),
        amountCredits: Number(row.amount_credits),
        count: Number(row.code_count),
        redeemed: Number(row.redeemed),
        note: String(row.note ?? ''),
        operator: row.operator == null ? null : String(row.operator),
        createdAt: Number(row.created_at),
      })),
      nextCursor: rows.results.length > PAGE ? Number(page.at(-1)!.created_at) : null,
    },
    200,
    headers,
  );
}

async function listBatchCodes(
  env: SessionEnv,
  batchId: string,
  headers: Record<string, string>,
): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.code_tail, c.redeemed_at, u.username AS redeemed_by
       FROM redeem_codes c LEFT JOIN users u ON u.id = c.redeemed_by
      WHERE c.batch_id = ? ORDER BY c.created_at, c.id LIMIT ${MAX_CODES_PER_BATCH}`,
  )
    .bind(batchId)
    .all<Record<string, unknown>>();
  return json(
    {
      codes: rows.results.map((row) => ({
        id: String(row.id),
        tail: String(row.code_tail),
        redeemedBy: row.redeemed_by == null ? null : String(row.redeemed_by),
        redeemedAt: row.redeemed_at == null ? null : Number(row.redeemed_at),
      })),
    },
    200,
    headers,
  );
}

async function listRedemptions(
  env: SessionEnv,
  url: URL,
  headers: Record<string, string>,
): Promise<Response> {
  const before = cursor(url);
  if (before === undefined) return err('游标无效', 400, headers);
  const rows = await env.DB.prepare(
    `SELECT c.id, c.code_tail, c.amount_credits, c.redeemed_at, b.amount_cny, b.note,
            u.username AS redeemed_by
       FROM redeem_codes c
       JOIN redeem_batches b ON b.id = c.batch_id
       LEFT JOIN users u ON u.id = c.redeemed_by
      WHERE c.redeemed_at IS NOT NULL ${before === null ? '' : 'AND c.redeemed_at < ?'}
      ORDER BY c.redeemed_at DESC LIMIT ${PAGE + 1}`,
  )
    .bind(...(before === null ? [] : [before]))
    .all<Record<string, unknown>>();
  const page = rows.results.slice(0, PAGE);
  return json(
    {
      redemptions: page.map((row) => ({
        id: String(row.id),
        tail: String(row.code_tail),
        amountCny: Number(row.amount_cny),
        amountCredits: Number(row.amount_credits),
        note: String(row.note ?? ''),
        redeemedBy: row.redeemed_by == null ? null : String(row.redeemed_by),
        redeemedAt: Number(row.redeemed_at),
      })),
      nextCursor: rows.results.length > PAGE ? Number(page.at(-1)!.redeemed_at) : null,
    },
    200,
    headers,
  );
}

/** Null for the first page, undefined for a malformed cursor. */
function cursor(url: URL): number | null | undefined {
  const raw = url.searchParams.get('before');
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 64 characters from a 32-symbol alphabet: 320 bits, uniformly (256 is a multiple of 32). */
function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(REDEEM_CODE_LENGTH));
  let code = '';
  for (const byte of bytes) code += REDEEM_CODE_ALPHABET[byte % REDEEM_CODE_ALPHABET.length];
  return code;
}

/** Old attempts are only needed for the lockout window. */
export function redeemRetentionStatement(env: SessionEnv, now: number): D1PreparedStatement {
  return env.DB.prepare('DELETE FROM redeem_attempts WHERE created_at < ?').bind(
    now - 24 * 60 * 60 * 1000,
  );
}
