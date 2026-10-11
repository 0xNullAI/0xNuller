const EVENT = '0xnullai:relationship-memory-changed';

export function notifyRelationshipMemoryChanged(relationshipId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: relationshipId }));
}

export function subscribeRelationshipMemoryChanged(
  relationshipId: string,
  listener: () => void,
): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<string>).detail === relationshipId) listener();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
