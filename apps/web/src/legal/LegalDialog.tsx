import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  SegmentedControl,
} from '@0xnullai/ui';
import { LegalMarkdown } from './legal-markdown';
import { LEGAL_DOCUMENT_ORDER, LEGAL_DOCUMENT_TITLES, type LegalDocumentId } from './legal-routes';
import { PRIVACY_POLICY_MARKDOWN } from './privacy-policy';
import { USER_AGREEMENT_MARKDOWN } from './user-agreement';

const SOURCES: Record<LegalDocumentId, string> = {
  terms: USER_AGREEMENT_MARKDOWN,
  privacy: PRIVACY_POLICY_MARKDOWN,
};

const SWITCH_OPTIONS = LEGAL_DOCUMENT_ORDER.map((id) => [id, LEGAL_DOCUMENT_TITLES[id]] as const);

/** One legal text on the same elevated surface the settings lists use. */
export function LegalDocumentView({ id }: { id: LegalDocumentId }) {
  return (
    <article
      aria-label={LEGAL_DOCUMENT_TITLES[id]}
      className="rounded-2xl bg-[var(--bg-elevated)] px-4 py-4"
    >
      <LegalMarkdown source={SOURCES[id]} />
    </article>
  );
}

/** Switch between the two texts; used by the dialog and the public page. */
export function LegalDocumentSwitch({
  value,
  onChange,
}: {
  value: LegalDocumentId;
  onChange: (id: LegalDocumentId) => void;
}) {
  return (
    <SegmentedControl label="选择文档" value={value} onChange={onChange} options={SWITCH_OPTIONS} />
  );
}

/**
 * The in-app reader. The registration form and 关于 open this instead of leaving the page, so a
 * half-filled form (or an Android shell without a browser tab) keeps its state.
 */
export function LegalDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: LegalDocumentId;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] max-w-2xl flex-col gap-4 bg-[var(--bg)] p-4 sm:p-6">
        {/* The content unmounts while closed, so each opening starts on `initial`. */}
        <LegalReader initial={initial} />
      </DialogContent>
    </Dialog>
  );
}

function LegalReader({ initial }: { initial: LegalDocumentId }) {
  const [shown, setShown] = useState(initial);
  return (
    <>
      <div className="flex flex-col gap-3 pr-12">
        <DialogTitle>{LEGAL_DOCUMENT_TITLES[shown]}</DialogTitle>
        <DialogDescription className="sr-only">猫愿的用户协议与隐私政策</DialogDescription>
        <LegalDocumentSwitch value={shown} onChange={setShown} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <LegalDocumentView id={shown} />
      </div>
    </>
  );
}
