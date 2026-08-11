import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@0xnullai/ui';

interface ResetSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ResetSettingsDialog({ open, onOpenChange, onConfirm }: ResetSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="backdrop-blur-[2px]"
        className="reset-settings-dialog max-w-[380px] rounded-[var(--radius-md)] p-5 shadow-[var(--shadow-soft)]"
      >
        <DialogHeader className="gap-1 pr-10">
          <DialogTitle className="text-base font-semibold">恢复默认设置？</DialogTitle>
          <DialogDescription className="text-[13px] leading-5">
            这会重置当前模型、场景、安全、桥接和语音识别/合成配置。确认后会立即生效。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-5 gap-2">
          <Button
            type="button"
            variant="secondary"
            className="!text-sm !font-medium h-9 min-w-[72px] rounded-[var(--radius-xs)] px-4"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="!text-sm !font-medium h-9 min-w-[88px] rounded-[var(--radius-xs)] px-4 "
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            确认恢复
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
