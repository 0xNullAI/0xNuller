import { SceneLibrary } from '@0xnullai/scenes/library';
import { BUILTIN_PROMPT_PRESETS } from '@dg-agent/runtime';

/**
 * 场景库。
 *
 * 一份，Agent 与 Voice 共用——在这里写的人设两边都看得到，从市场导入的也是。
 *
 * 内置场景用 Agent 那份的元数据。七个人设在两个模块里是同一批（id / 名字 / 图标
 * 一致），只有正文不同：Voice 那份为口语重写过，读出来才不会像在念文档。正文不可
 * 编辑，所以这里显示哪一份都不影响用户能做的事。
 *
 * 合并前这个编辑器有两份近 450 行的副本，各自跟着自己的模块漂：写作模板的正文已经
 * 分叉成两个版本了。现在只有 @0xnullai/scenes/library 一份。
 */
export function ScenesTab() {
  return <SceneLibrary builtins={BUILTIN_PROMPT_PRESETS} />;
}
