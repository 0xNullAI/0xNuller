// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterArExperience } from './CharacterArExperience.js';
import { startCharacterAr, supportsCharacterAr } from './character-ar-session.js';

vi.mock('@0xnullai/auth/appearance-react', () => ({
  useSelectedCharacterAppearance: () => null,
  useCharacterPhoto: () => null,
  CharacterPortrait: () => <div aria-label="角色形象" />,
}));
vi.mock('@0xnullai/auth', () => ({
  readPrivateConversationSelection: () => null,
  subscribePrivateConversationSelection: () => () => undefined,
}));
vi.mock('./character-ar-session.js', () => ({
  supportsCharacterAr: vi.fn(),
  startCharacterAr: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CharacterArExperience', () => {
  it('shows a truthful 2D fallback when immersive AR is unavailable', async () => {
    vi.mocked(supportsCharacterAr).mockResolvedValue(false);
    render(<CharacterArExperience />);
    expect(await screen.findByText(/不支持 WebXR AR/)).toBeTruthy();
    expect(screen.getByLabelText('角色形象')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '进入 AR 放置' })).toBeNull();
    expect(startCharacterAr).not.toHaveBeenCalled();
  });

  it('starts an immersive session only after an explicit click', async () => {
    vi.mocked(supportsCharacterAr).mockResolvedValue(true);
    vi.mocked(startCharacterAr).mockResolvedValue({ end: vi.fn().mockResolvedValue(undefined) });
    render(<CharacterArExperience fallbackSource="blob:portrait" />);
    const button = await screen.findByRole('button', { name: '进入 AR 放置' });
    expect(startCharacterAr).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(startCharacterAr).toHaveBeenCalledOnce());
    expect(vi.mocked(startCharacterAr).mock.calls[0]?.[0].source).toBe('blob:portrait');
  });
});
