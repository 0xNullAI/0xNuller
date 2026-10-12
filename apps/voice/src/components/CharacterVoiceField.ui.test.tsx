import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CharacterVoiceField } from './CharacterVoiceField';

const auth = vi.hoisted(() => ({
  listCharacterRelationships: vi.fn(),
  saveCharacterRelationship: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => auth);
// Radix Select needs pointer APIs jsdom lacks; the choice logic is what matters here.
vi.mock('@0xnullai/ui', () => ({
  SettingSelect: ({
    value,
    onValueChange,
    options,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    options: { value: string; label: string }[];
  }) => (
    <select aria-label="音色" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const relationship = {
  id: 'r1',
  characterId: 'card',
  aiNickname: '小夜',
  userPreferredName: '',
  relationshipType: '',
  notes: '',
  voice: '',
  version: 3,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('saves a voice on the relationship without touching its other fields', async () => {
  auth.listCharacterRelationships.mockResolvedValue({ items: [relationship], limit: 200 });
  auth.saveCharacterRelationship.mockResolvedValue({
    item: { ...relationship, voice: 'zh_male_m191_uranus_bigtts', version: 4 },
  });
  render(<CharacterVoiceField characterId="card" />);
  const select = (await screen.findByRole('combobox', { name: '音色' })) as HTMLSelectElement;
  expect(select.value).toBe('__default__');
  expect(screen.getByRole('option', { name: '云舟' })).toBeTruthy();
  fireEvent.change(select, { target: { value: 'zh_male_m191_uranus_bigtts' } });
  await waitFor(() => expect(select.value).toBe('zh_male_m191_uranus_bigtts'));
  expect(auth.saveCharacterRelationship).toHaveBeenCalledWith({
    id: 'r1',
    characterId: 'card',
    aiNickname: '小夜',
    userPreferredName: '',
    relationshipType: '',
    notes: '',
    version: 3,
    voice: 'zh_male_m191_uranus_bigtts',
  });
});

it('shows a voice saved for the previous provider as its catalog mapping without rewriting it', async () => {
  auth.listCharacterRelationships.mockResolvedValue({
    items: [{ ...relationship, voice: 'ara' }],
    limit: 200,
  });
  render(<CharacterVoiceField characterId="card" />);
  const select = (await screen.findByRole('combobox', { name: '音色' })) as HTMLSelectElement;
  expect(select.value).toBe('zh_female_xiaohe_uranus_bigtts');
  expect(auth.saveCharacterRelationship).not.toHaveBeenCalled();
});

it('shows nothing until the account has a relationship with this AI', async () => {
  auth.listCharacterRelationships.mockResolvedValue({ items: [], limit: 200 });
  render(<CharacterVoiceField characterId="card" />);
  await waitFor(() => expect(auth.listCharacterRelationships).toHaveBeenCalledWith('card'));
  expect(screen.queryByRole('combobox')).toBeNull();
});
