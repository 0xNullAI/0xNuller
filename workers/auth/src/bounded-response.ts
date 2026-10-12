/** Read a provider response body without trusting its declared or actual size. */
export async function boundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('媒体结果过大');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('媒体结果为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('媒体结果过大');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
