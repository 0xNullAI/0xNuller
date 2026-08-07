import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { EditingWaveformState } from '../hooks/use-waveform-manager.js';

interface WaveformEditorDialogProps {
  editingWaveform: EditingWaveformState | null;
  onEditingWaveformChange: (wf: EditingWaveformState | null) => void;
  onSave: () => Promise<void>;
}

export function WaveformEditorDialog({
  editingWaveform,
  onEditingWaveformChange,
  onSave,
}: WaveformEditorDialogProps) {
  return (
    <Dialog
      open={Boolean(editingWaveform)}
      onOpenChange={(open) => {
        if (!open) {
          onEditingWaveformChange(null);
        }
      }}
    >
      {editingWaveform && (
        <DialogContent
          overlayClassName="bg-black/18 backdrop-blur-[2px]"
          className="max-w-[680px] overflow-hidden p-0"
        >
          <div className="panel-header">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-[1.1rem] tracking-[-0.03em]">编辑波形</DialogTitle>
              <DialogDescription className="mt-1">修改自定义波形的名称和说明</DialogDescription>
            </div>
          </div>
          <label className="settings">
            <span>名称</span>
            <Input
              value={editingWaveform.name}
              onChange={(event) =>
                onEditingWaveformChange(
                  editingWaveform
                    ? { ...editingWaveform, name: event.target.value }
                    : editingWaveform,
                )
              }
            />
          </label>
          <label className="settings">
            <span>说明</span>
            <Textarea
              rows={4}
              value={editingWaveform.description}
              onChange={(event) =>
                onEditingWaveformChange(
                  editingWaveform
                    ? { ...editingWaveform, description: event.target.value }
                    : editingWaveform,
                )
              }
            />
          </label>
          <div className="settings-actions waveform-modal-actions mt-2 mb-5">
            <Button variant="secondary" onClick={() => onEditingWaveformChange(null)}>
              取消
            </Button>
            <Button onClick={() => void onSave()}>保存</Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
