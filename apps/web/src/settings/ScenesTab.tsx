import { SceneLibrary } from '@0xnullai/scenes/library';
import { BUILTIN_PROMPT_PRESETS } from '@dg-agent/runtime';

/**
 * Scene library.
 *
 * One copy, shared by Agent and Voice — a persona written here is visible in both,
 * and so is anything imported from the market.
 *
 * The built-in scenes use Agent's metadata. The seven personas are the same set in
 * both modules (same id / name / icon), only the body text differs: Voice's version
 * was rewritten for speech so that reading it aloud doesn't sound like reciting a
 * document. The body text is not editable, so which copy is shown here does not
 * affect anything the user can do.
 *
 * Before the merge this editor had two nearly 450-line copies, each drifting along
 * with its own module: the writing template's body had already forked into two
 * versions. Now there is only the one in @0xnullai/scenes/library.
 */
export function ScenesTab() {
  return <SceneLibrary builtins={BUILTIN_PROMPT_PRESETS} />;
}
