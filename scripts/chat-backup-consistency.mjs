/** Reject changed, inserted, deleted or duplicated objects without printing private keys. */
export function assertStableObjectListing(before, after, fields, label) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length)
    throw new Error(`${label} changed during export`);
  const original = new Map();
  for (const item of before) {
    if (!item || typeof item.key !== 'string' || original.has(item.key))
      throw new Error(`Invalid ${label} listing`);
    original.set(item.key, item);
  }
  const seen = new Set();
  for (const item of after) {
    if (!item || typeof item.key !== 'string' || seen.has(item.key))
      throw new Error(`Invalid ${label} listing`);
    seen.add(item.key);
    const prior = original.get(item.key);
    if (!prior || fields.some((field) => prior[field] !== item[field]))
      throw new Error(`${label} changed during export`);
  }
}
