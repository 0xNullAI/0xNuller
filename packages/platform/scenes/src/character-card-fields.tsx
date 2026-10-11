import { emptyCharacterCard, parseCharacterCard, type CharacterCard } from './character-card.js';
const FIELDS = [
  ['description', '人物背景'],
  ['personality', '性格与表达方式'],
  ['greeting', '开场白'],
  ['exampleDialogue', '对话示例'],
  ['creator', '原作者署名'],
  ['license', '使用与转载许可'],
] as const;

/** Only public character definition is editable here. No relationship or account memory fields. */
export function CharacterCardFields({
  value,
  onChange,
  allowRemove = true,
}: {
  value?: CharacterCard;
  onChange: (card: CharacterCard | undefined) => void;
  allowRemove?: boolean;
}) {
  return (
    <fieldset className="space-y-2">
      {value && !parseCharacterCard(value) && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          角色卡内容超出限制，请缩短后再保存；编辑内容已保留。
        </p>
      )}
      <legend>角色卡</legend>
      {allowRemove && (
        <label className="field flex flex-col gap-1 text-sm">
          <span>
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(event) =>
                onChange(event.target.checked ? emptyCharacterCard() : undefined)
              }
            />{' '}
            添加公开人物设定
          </span>
        </label>
      )}
      {value && (
        <>
          <p className="upload-note">
            发布到 Market 时，这些内容会公开。专属昵称、私人关系和个人记忆请在聊天中管理。
          </p>
          <details>
            <summary className="cursor-pointer text-sm">
              旧版详细设定（可选，已有内容会保留）
            </summary>
            {FIELDS.map(([key, label]) => (
              <label key={key} className="field flex flex-col gap-1 text-sm">
                <span>
                  {label} · {value[key].length} / 4000
                </span>
                <textarea
                  className="w-full rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg)] p-2 text-sm"
                  rows={key === 'creator' || key === 'license' ? 2 : 4}
                  value={value[key]}
                  onChange={(event) => onChange({ ...value, [key]: event.target.value })}
                />
              </label>
            ))}
            <label className="field flex flex-col gap-1 text-sm">
              <span>角色标签（逗号分隔，最多 16 个，每个 40 字）</span>
              <input
                value={value.tags.join(', ')}
                onChange={(event) =>
                  onChange({
                    ...value,
                    tags: event.target.value.split(/[,，]/).map((tag) => tag.trim()),
                  })
                }
              />
            </label>
            <p className="upload-note">
              角色卡各文本字段合计最多 12000 字。主要人设写在上方 Prompt；已有详细设定不会被清除。
            </p>
          </details>
        </>
      )}
    </fieldset>
  );
}
