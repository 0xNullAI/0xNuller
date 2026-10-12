import { useId, useState, type MouseEvent } from 'react';
import { LegalDialog } from './LegalDialog';
import { LEGAL_DOCUMENT_TITLES, legalDocumentPath, type LegalDocumentId } from './legal-routes';

const CONSENT_LABEL = '我已年满 18 岁，并阅读同意《用户协议》和《隐私政策》';

/**
 * The required consent box under the sign-up form. The links are real addresses (they work
 * when opened in a new tab), but a plain click opens the in-app reader so the form keeps
 * what was typed.
 */
export function RegistrationConsent({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  const [reading, setReading] = useState<LegalDocumentId | null>(null);

  const link = (doc: LegalDocumentId) => (
    <a
      href={legalDocumentPath(doc)}
      className="text-[var(--accent)] underline underline-offset-2"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        setReading(doc);
      }}
    >
      《{LEGAL_DOCUMENT_TITLES[doc]}》
    </a>
  );

  return (
    <div className="mt-2 flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        required
        aria-label={CONSENT_LABEL}
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
        className="mt-0.5 shrink-0 cursor-pointer accent-[var(--accent)]"
      />
      <span className="text-xs leading-5 text-[var(--text-soft)]">
        <label htmlFor={id} className="cursor-pointer">
          我已年满 18 岁，并阅读同意
        </label>
        {link('terms')}和{link('privacy')}
      </span>
      <LegalDialog
        open={reading !== null}
        onOpenChange={(open) => {
          if (!open) setReading(null);
        }}
        initial={reading ?? 'terms'}
      />
    </div>
  );
}
