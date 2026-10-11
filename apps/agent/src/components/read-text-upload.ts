export async function readTextUpload(
  file: Pick<File, 'name' | 'size' | 'type' | 'arrayBuffer'>,
): Promise<{ name: string; mime: string; content: string }> {
  if (
    !/^.+\.(txt|md|markdown)$/i.test(file.name) ||
    /[\\/]/.test(file.name) ||
    file.name.length > 120
  )
    throw new Error('请选择 .txt 或 Markdown 文件');
  if (file.size > 64 * 1024) throw new Error('文本文件最多 64 KiB');
  if (file.type && !['text/plain', 'text/markdown'].includes(file.type))
    throw new Error('文件类型不是纯文本或 Markdown');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > 64 * 1024) throw new Error('文本文件最多 64 KiB');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('文件必须使用 UTF-8 编码');
  }
  if (content.includes('\0')) throw new Error('文件包含二进制内容，无法作为文本读取');
  return {
    name: file.name,
    mime: /\.txt$/i.test(file.name) ? 'text/plain' : 'text/markdown',
    content,
  };
}
