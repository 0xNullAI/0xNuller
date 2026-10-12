import { FileText } from 'lucide-react';
import { useState } from 'react';
import { SettingsRow } from '../settings/settings-list';
import { LegalDialog } from './LegalDialog';

/** The 关于 row that opens the 隐私政策 and 用户协议 reader. */
export function LegalDocumentsRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsRow icon={FileText} label="隐私政策与用户协议" onClick={() => setOpen(true)} />
      <LegalDialog open={open} onOpenChange={setOpen} initial="privacy" />
    </>
  );
}
