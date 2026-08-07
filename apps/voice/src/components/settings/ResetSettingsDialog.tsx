import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ResetSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ResetSettingsDialog({ open, onOpenChange, onConfirm }: ResetSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>恢复默认设置？</DialogTitle>
          <DialogDescription>
            这会把所有设置——语音供应商、API Key、音色、场景、安全上限——恢复为出厂默认值，且无法撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            恢复默认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
