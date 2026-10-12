import { ChevronLeft } from 'lucide-react';
import { LegalDocumentView } from './LegalDialog';
import { LEGAL_TERMS_TITLE } from './legal-routes';

/**
 * /legal/terms: readable without an account, so the registration form,
 * app-store listings and emails can link to them.
 */
export function LegalPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <div className="flex-1">
      <main
        aria-label={LEGAL_TERMS_TITLE}
        className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            // In-app readers use the dialog; this page is mostly opened from a link, so the way
            // back is the app's front door rather than browser history that may leave the site.
            onClick={() => onNavigate('/')}
            aria-label="返回猫愿"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-[var(--bg-soft)]"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
            猫愿 · {LEGAL_TERMS_TITLE}
          </h1>
        </div>
        <LegalDocumentView />
      </main>
    </div>
  );
}
