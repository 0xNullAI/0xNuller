function validCursor(value) {
  return (
    value &&
    Number.isSafeInteger(value.ts) &&
    value.ts >= 0 &&
    typeof value.id === 'string' &&
    value.id.length > 0
  );
}

function olderThan(left, right) {
  return left.ts < right.ts || (left.ts === right.ts && left.id < right.id);
}

async function readRoom(room, fetchPage) {
  const messages = [];
  const ids = new Set();
  const cursors = new Set();
  let before;
  let previous;
  let totalMessages;
  do {
    const page = await fetchPage(room, before);
    if (
      page?.room !== room ||
      page.exists !== true ||
      !Array.isArray(page.messages) ||
      page.messages.length > 100 ||
      !Number.isSafeInteger(page.totalMessages) ||
      page.totalMessages < 0 ||
      (totalMessages !== undefined && page.totalMessages !== totalMessages) ||
      (page.before !== null && !validCursor(page.before)) ||
      (page.before && page.messages.length === 0)
    )
      throw new Error('Invalid room export page');
    totalMessages = page.totalMessages;
    for (const row of page.messages) {
      if (
        !validCursor(row) ||
        ids.has(row.id) ||
        (previous && !olderThan(row, previous)) ||
        (before && !olderThan(row, before))
      )
        throw new Error('Invalid room export message order');
      ids.add(row.id);
      messages.push(row);
      previous = row;
    }
    before = page.before ?? undefined;
    if (before) {
      const cursor = JSON.stringify(before);
      if (
        cursors.has(cursor) ||
        !previous ||
        cursor !== JSON.stringify({ ts: previous.ts, id: previous.id })
      )
        throw new Error('Invalid room export cursor');
      cursors.add(cursor);
    }
  } while (before);
  if (messages.length !== totalMessages)
    throw new Error('Room message count changed or export ended early; retry capture');
  return messages;
}

/** A changed room invalidates this capture instead of producing a mixed-page archive. */
export async function captureConsistentRoomMessages(room, fetchPage) {
  const first = await readRoom(room, fetchPage);
  const firstSignature = JSON.stringify(first);
  const second = await readRoom(room, fetchPage);
  if (firstSignature !== JSON.stringify(second))
    throw new Error('Room messages changed during export; retry capture');
  return JSON.parse(firstSignature);
}

/** Catch messages added, removed or edited while other rooms and media were exported. */
export async function assertRoomMessagesUnchanged(room, captured, fetchPage) {
  const current = await readRoom(room, fetchPage);
  if (JSON.stringify(current) !== JSON.stringify(captured))
    throw new Error('Room messages changed during export; retry capture');
}
