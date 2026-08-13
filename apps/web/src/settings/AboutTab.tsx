import { Download, ExternalLink } from 'lucide-react';
import {
  ANDROID_DOWNLOAD_URL,
  PRODUCT_BUILD_ID,
  PRODUCT_RELEASE_URL,
  PRODUCT_VERSION,
} from '../product';

export function AboutTab() {
  const buildLabel =
    PRODUCT_BUILD_ID.length === 40 ? PRODUCT_BUILD_ID.slice(0, 12) : PRODUCT_BUILD_ID;
  return (
    <div className="flex max-w-lg flex-col gap-5">
      <section>
        <h3 className="text-sm font-semibold">0xNuller</h3>
        <p className="mt-1 text-sm text-[var(--text-soft)]">Android 与网页使用同一个产品版本。</p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-[var(--text-faint)]">产品版本</dt>
          <dd className="font-mono text-[var(--text)]">v{PRODUCT_VERSION}</dd>
          <dt className="text-[var(--text-faint)]">构建</dt>
          <dd className="break-all font-mono text-xs text-[var(--text-soft)]">{buildLabel}</dd>
        </dl>
      </section>
      <section className="flex flex-wrap gap-2 border-t border-[var(--surface-border)] pt-4">
        <a
          href={ANDROID_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] px-3 text-sm text-[var(--text)] hover:bg-[var(--bg-soft)]"
        >
          <Download className="h-4 w-4" /> 下载 Android 版
        </a>
        <a
          href={PRODUCT_RELEASE_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-ctl)] px-3 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
        >
          <ExternalLink className="h-4 w-4" /> 查看 Release
        </a>
      </section>
    </div>
  );
}
