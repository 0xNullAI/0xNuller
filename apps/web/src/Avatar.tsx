/**
 * 头像。由用户名确定性生成——零存储、零上传。
 *
 * 成人向产品里让用户上传头像意味着要处理违规图片：审核流程、举报通道、误判申诉。
 * 那是一整条产品线，不是一个字段。生成式头像回避了整件事，同一个用户名永远得到
 * 同一个图案，识别度足够。`avatar_url` 字段在 auth 的表里预留着，将来真要开上传
 * 时不用改 schema。
 */

/** FNV-1a：短字符串上分布够好，且不依赖任何库。 */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function Avatar({ name, size = 28 }: { name: string | null; size?: number }) {
  if (!name) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-soft)] text-[var(--text-faint)]"
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        aria-hidden
      >
        ?
      </span>
    );
  }

  const h = hash(name);
  // 色相取自哈希，饱和度与亮度固定——避免生成出与背景或强调色撞车的颜色。
  const hue = h % 360;
  const initial = [...name][0]?.toUpperCase() ?? '?';

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(135deg, hsl(${hue} 62% 48%), hsl(${(hue + 40) % 360} 62% 38%))`,
      }}
      aria-label={name}
      title={name}
    >
      {initial}
    </span>
  );
}
