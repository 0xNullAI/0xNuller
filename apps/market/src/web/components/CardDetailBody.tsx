import { useState } from 'react';
import type { CharacterCard } from '@0xnullai/scenes/character-card';

/** Long text shows a few lines first; people open the rest only when they care. */
function Section({
  title,
  text,
  clampAt = 160,
}: {
  title: string;
  text: string;
  clampAt?: number;
}) {
  const long = text.length > clampAt;
  const [open, setOpen] = useState(false);
  return (
    <section className="card-section" aria-label={title}>
      <h3>{title}</h3>
      <p className={`whitespace-pre-wrap ${long && !open ? 'card-section-clamped' : ''}`}>{text}</p>
      {long && (
        <button type="button" className="card-section-toggle" onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开'}
        </button>
      )}
    </section>
  );
}

/** 「你：…」 lines are the reader; every other speaker line is the character. */
function Dialogue({ text }: { text: string }) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([^：:]{1,24})[：:]\s*(.+)$/.exec(line);
      return match
        ? { self: match[1] === '你', speaker: match[1]!, text: match[2]! }
        : { self: false, speaker: '', text: line };
    });
  return (
    <section className="card-section" aria-label="对话示例">
      <h3>对话示例</h3>
      <div className="card-dialogue">
        {lines.map((line, index) => (
          <p key={index} className={`card-bubble ${line.self ? 'card-bubble-self' : ''}`}>
            {line.text}
          </p>
        ))}
      </div>
    </section>
  );
}

/** The readable view of a public character or scene; the full prompt stays one tap away. */
export function CardDetailBody({
  card,
  prompt,
  isCharacter,
}: {
  card: CharacterCard | undefined;
  prompt: string;
  isCharacter: boolean;
}) {
  if (!card)
    return (
      <div className="card-detail">
        <Section title={isCharacter ? '人物设定' : '场景设定'} text={prompt} clampAt={240} />
      </div>
    );
  return (
    <div className="card-detail">
      {card.greeting && (
        <section className="card-section" aria-label="开场">
          <h3>TA 会这样开场</h3>
          <p className="card-bubble card-greeting whitespace-pre-wrap">{card.greeting}</p>
        </section>
      )}
      {card.description && <Section title="人物" text={card.description} />}
      {card.personality && <Section title="性格与说话方式" text={card.personality} />}
      {card.exampleDialogue && <Dialogue text={card.exampleDialogue} />}
      <details className="card-full-prompt">
        <summary>完整设定</summary>
        <pre className="prompt-box">{prompt}</pre>
      </details>
      {(card.creator || card.license) && (
        <p className="card-credit">
          {card.creator && <>原作者：{card.creator}</>}
          {card.creator && card.license && <br />}
          {card.license && <>许可：{card.license}</>}
        </p>
      )}
    </div>
  );
}
