import { expect, it } from 'vitest';
import { CHARACTER_TEMPLATES } from './character-templates';
import { parseCharacterCard } from './character-card';
it('provides uniquely identified, valid editable prompts without external assets', () => {
  expect(new Set(CHARACTER_TEMPLATES.map((template) => template.id)).size).toBe(
    CHARACTER_TEMPLATES.length,
  );
  for (const template of CHARACTER_TEMPLATES) {
    expect(parseCharacterCard(template.characterCard)).not.toBeNull();
    expect(template.prompt).toContain(template.name);
    expect(JSON.stringify(template)).not.toMatch(/https?:\/\//);
  }
});
