import { expect, it } from 'vitest';
import { CHARACTER_TEMPLATES } from './character-templates';
import { parseCharacterCard } from './character-card';
it('keeps original IDs and provides six valid, explicitly original editable prompts without external assets', () => {
  expect(CHARACTER_TEMPLATES.slice(0, 3).map((template) => template.id)).toEqual([
    'companion-lan',
    'companion-yu',
    'companion-momo',
  ]);
  expect(new Set(CHARACTER_TEMPLATES.map((template) => template.id)).size).toBe(6);
  for (const template of CHARACTER_TEMPLATES) {
    expect(parseCharacterCard(template.characterCard)).not.toBeNull();
    expect(template.prompt).toContain(template.name);
    expect(template.prompt).toContain('不捏造过去');
    expect(template.characterCard.license).toBe('MIT');
    expect(JSON.stringify(template)).not.toMatch(/https?:\/\//);
  }
});
