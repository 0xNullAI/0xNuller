/** Market listing tag limits, matching the upload and draft schemas. */
const MAX_LISTING_TAGS = 20;
const MAX_LISTING_TAG_LENGTH = 20;

/**
 * The editor's one tag field shows the listing tags plus legacy character-card tags.
 *
 * Older cards kept their own 角色标签, edited in a second field. That field is gone, so those
 * tags appear here instead. A card tag joins only when it is a valid listing tag: it fits the
 * length rule and has no separator, which the text field would split into several tags. The
 * card itself is not changed, so saved cards stay compatible.
 */
export function listingTagsText(
  listingTags: readonly string[],
  cardTags: readonly string[] = [],
): string {
  const tags: string[] = [];
  const add = (tag: string, fromCard: boolean) => {
    const value = tag.trim();
    if (!value || tags.includes(value) || tags.length >= MAX_LISTING_TAGS) return;
    if (fromCard && (value.length > MAX_LISTING_TAG_LENGTH || /[,，、\s]/.test(value))) return;
    tags.push(value);
  };
  for (const tag of listingTags) add(tag, false);
  for (const tag of cardTags) add(tag, true);
  return tags.join('、');
}
