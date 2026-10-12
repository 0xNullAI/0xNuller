import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@0xnullai/ui';
import { LegalMarkdown } from './legal-markdown';
import { LEGAL_TERMS_TITLE } from './legal-routes';
import { USER_AGREEMENT_MARKDOWN } from './user-agreement';

/** The 用户协议 on the same elevated surface the settings lists use. */
export function LegalDocumentView() {
  return (
    <article
      aria-label={LEGAL_TERMS_TITLE}
      className="rounded-2xl bg-[var(--bg-elevated)] px-4 py-4"
    >
      <LegalMarkdown source={USER_AGREEMENT_MARKDOWN} />
    </article>
  );
}

/**
 * The in-app reader. The registration form and 关于 open this instead of leaving the page, so a
 * half-filled form (or an Android shell without a browser tab) keeps its state.
 */
export function LegalDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] max-w-2xl flex-col gap-4 bg-[var(--bg)] p-4 sm:p-6">
        <div className="pr-12">
          <DialogTitle>{LEGAL_TERMS_TITLE}</DialogTitle>
          <DialogDescription className="sr-only">猫愿的用户协议</DialogDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <LegalDocumentView />
        </div>
      </DialogContent>
    </Dialog>
  );
}
