import { marketBaseUrl } from '@0xnullai/market-client';

/** A reference to already public content. Never serialize account cards, memories or relationships. */
export function publicCharacterShare(id: string, name: string): string {
  if (!/^[\w-]{1,128}$/.test(id)) throw new Error('无效的公开角色 ID');
  return `公开角色卡：${name.replace(/[\r\n]/g, ' ').slice(0, 100)}\n/market?item=${id}`;
}
export function publicCharacterLink(text: string): string | null {
  const match = /^公开角色卡：[^\r\n]{1,100}\n\/market\?item=([\w-]{1,128})$/.exec(text);
  return match ? `${marketBaseUrl()}/market?item=${match[1]}` : null;
}
