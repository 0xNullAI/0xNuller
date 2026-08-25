const STALE_PHOTO_UPLOAD_MS = 60 * 60 * 1000;
const MAINTENANCE_BATCH_SIZE = 100;
const ACCOUNT_DELETION_BATCH_SIZE = 25;

export interface PhotoLifecycleEnv {
  DB: D1Database;
  PHOTOS: R2Bucket;
}

export interface PendingPhotoRow {
  id: string;
  object_key: string;
}

/** Delete every object under a prefix without reusing a cursor after mutating the listing. */
async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  while (true) {
    const listed = await bucket.list({ prefix, limit: 1000 });
    if (listed.objects.length === 0) return;
    await bucket.delete(listed.objects.map((object) => object.key));
  }
}

/** R2 first, row second: a failed delete always leaves a durable retry record. */
export async function cleanupPendingPhoto(
  env: PhotoLifecycleEnv,
  row: PendingPhotoRow,
): Promise<void> {
  await env.PHOTOS.delete(row.object_key);
  await env.DB.prepare("DELETE FROM user_photos WHERE id = ? AND status = 'uploading'")
    .bind(row.id)
    .run();
}

export async function reservePhotoSlot(
  env: PhotoLifecycleEnv,
  params: {
    id: string;
    userId: string;
    objectKey: string;
    caption: string | null;
    visibility: 'public' | 'private';
    purpose: 'album' | 'avatar';
    createdAt: number;
  },
): Promise<boolean> {
  await env.DB.prepare(
    `WITH RECURSIVE slots(slot) AS (
       VALUES(0) UNION ALL SELECT slot + 1 FROM slots WHERE slot < 59
     )
     INSERT INTO user_photos
       (id, user_id, object_key, caption, visibility, purpose, created_at, slot, status)
     SELECT ?, ?, ?, ?, ?, ?, ?, slots.slot, 'uploading'
       FROM slots
      WHERE NOT EXISTS (
              SELECT 1 FROM user_photos p WHERE p.user_id = ? AND p.slot = slots.slot
            )
        AND NOT EXISTS (
              SELECT 1 FROM account_deletions d WHERE d.user_id = ?
            )
      ORDER BY slots.slot
      LIMIT 1`,
  )
    .bind(
      params.id,
      params.userId,
      params.objectKey,
      params.caption,
      params.visibility,
      params.purpose,
      params.createdAt,
      params.userId,
      params.userId,
    )
    .run();
  return (
    (await env.DB.prepare("SELECT 1 FROM user_photos WHERE id = ? AND status = 'uploading'")
      .bind(params.id)
      .first()) != null
  );
}

export async function finishPhotoUpload(
  env: PhotoLifecycleEnv,
  id: string,
  userId: string,
): Promise<boolean> {
  await env.DB.prepare(
    `UPDATE user_photos SET status = 'ready'
      WHERE id = ? AND user_id = ? AND status = 'uploading'
        AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.user_id = ?)`,
  )
    .bind(id, userId, userId)
    .run();
  return (
    (await env.DB.prepare("SELECT 1 FROM user_photos WHERE id = ? AND status = 'ready'")
      .bind(id)
      .first()) != null
  );
}

export async function finalizeAccountDeletion(
  env: PhotoLifecycleEnv,
  userId: string,
): Promise<void> {
  await deleteR2Prefix(env.PHOTOS, `users/${userId}/photos/`);
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
}

export async function recordDeletionFailure(env: PhotoLifecycleEnv, userId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE account_deletions
        SET attempts = attempts + 1, last_error_at = ?
      WHERE user_id = ?`,
  )
    .bind(Date.now(), userId)
    .run();
}

/** Exported for deterministic local tests; production calls it from the daily cron. */
export async function runAuthMaintenance(env: PhotoLifecycleEnv, now = Date.now()): Promise<void> {
  const stale = await env.DB.prepare(
    `SELECT id, object_key FROM user_photos
      WHERE status = 'uploading' AND created_at < ?
      ORDER BY created_at, id LIMIT ?`,
  )
    .bind(now - STALE_PHOTO_UPLOAD_MS, MAINTENANCE_BATCH_SIZE)
    .all<PendingPhotoRow>();
  for (const row of stale.results ?? []) {
    try {
      await cleanupPendingPhoto(env, row);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'photo_cleanup_retry_failed',
          photoId: row.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const deletions = await env.DB.prepare(
    `SELECT user_id FROM account_deletions
      ORDER BY requested_at, user_id LIMIT ?`,
  )
    .bind(ACCOUNT_DELETION_BATCH_SIZE)
    .all<{ user_id: string }>();
  for (const row of deletions.results ?? []) {
    try {
      await finalizeAccountDeletion(env, row.user_id);
    } catch (error) {
      await recordDeletionFailure(env, row.user_id);
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'account_deletion_retry_failed',
          userId: row.user_id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
