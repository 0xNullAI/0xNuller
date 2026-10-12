import { isDeviceToolName } from '@dg-agent/core';
import { parseToolOutput, type ToolExecutionReceipt } from './runtime-tool-receipt.js';

type ClaimedAction =
  | 'device-start'
  | 'device-stop'
  | 'device-adjust'
  | 'timer'
  | 'plan-save'
  | 'memory-write'
  | 'file-read'
  | 'tool-invoke'
  | 'web-search'
  | 'reminder-send'
  | 'media-generate';

/** Model prose is never evidence that a side effect happened. Keep this list narrow and explicit. */
export function guardUnverifiedActionClaim(
  reply: string,
  calls: readonly ToolExecutionReceipt[],
): string {
  if (reply.startsWith('Fake LLM 已完成工具执行：'))
    return '模型文本不能作为工具执行凭证。请以工具记录和实际设备状态为准。';
  const claimed = claimedActions(reply);
  if (!claimed.length) return reply;
  const verified = new Set<ClaimedAction>();
  const verifiedDeviceKinds = new Map<ClaimedAction, Set<'coyote' | 'opossum'>>();
  for (const call of calls) {
    if (call.status !== 'succeeded') continue;
    const output = parseToolOutput(call.output);
    if (!output) continue;
    verified.add('tool-invoke');
    if (
      ['web_search', 'search_web', 'browser_search'].includes(call.name) &&
      (Array.isArray(output.results) || Array.isArray(output.items))
    )
      verified.add('web-search');
    if (isDeviceToolName(call.name)) {
      const command = output.command;
      const type =
        command && typeof command === 'object' && !Array.isArray(command)
          ? (command as Record<string, unknown>).type
          : undefined;
      if (output.ok !== true && output.ok !== 'clamped') continue;
      let action: ClaimedAction | null = null;
      if (type === 'start' || type === 'vibrateStart') action = 'device-start';
      if (type === 'stop' || type === 'emergencyStop' || type === 'vibrateStop')
        action = 'device-stop';
      if (
        type === 'adjustStrength' ||
        type === 'changeWave' ||
        type === 'vibrateAdjust' ||
        type === 'vibrateSetPattern'
      )
        action = 'device-adjust';
      if (action) {
        verified.add(action);
        const kind = deviceKindForTool(call.name);
        if (kind) {
          const kinds = verifiedDeviceKinds.get(action) ?? new Set<'coyote' | 'opossum'>();
          kinds.add(kind);
          verifiedDeviceKinds.set(action, kinds);
        }
      }
    }
    if (call.name === 'timer') verified.add('timer');
    if (call.name === 'task_plan_save') verified.add('plan-save');
    if (
      call.name === 'file_read' &&
      typeof output.id === 'string' &&
      typeof output.text === 'string'
    )
      verified.add('file-read');
  }
  const missing =
    claimed.find((action) => !verified.has(action)) ??
    claimedSpecificDeviceActions(reply).find(
      ({ action, kind }) => !verifiedDeviceKinds.get(action)?.has(kind),
    )?.action;
  if (!missing) return reply;
  return `这一步没有可核实的工具执行结果，因此不能确认“${actionLabel(missing)}”已完成。请检查工具记录或重试。`;
}

function deviceKindForTool(name: string): 'coyote' | 'opossum' | null {
  if (
    name.startsWith('shock_') ||
    ['start', 'stop', 'adjust_strength', 'change_wave', 'burst'].includes(name)
  )
    return 'coyote';
  if (name.startsWith('vibrate_')) return 'opossum';
  return null;
}

function claimedSpecificDeviceActions(reply: string): Array<{
  action: ClaimedAction;
  kind: 'coyote' | 'opossum';
}> {
  const result: Array<{ action: ClaimedAction; kind: 'coyote' | 'opossum' }> = [];
  for (const clause of reply.split(/[，。；;！？!\n]/)) {
    const actions = claimedActions(clause).filter((action) => action.startsWith('device-'));
    if (!actions.length) continue;
    if (/(?:郊狼|coyote)/i.test(clause))
      for (const action of actions) result.push({ action, kind: 'coyote' });
    if (/(?:负鼠|opossum)/i.test(clause))
      for (const action of actions) result.push({ action, kind: 'opossum' });
  }
  return result;
}

function claimedActions(reply: string): ClaimedAction[] {
  const actions: ClaimedAction[] = [];
  for (const clause of reply.split(/[，。；;！？!\n]/)) {
    const statement = clause.trim();
    // Natural completed-action wording often omits “已经”: “我把郊狼打开了”.
    // Only anchored, past-tense assertions qualify; hypothetical or planned
    // operations must not be mistaken for execution claims.
    const directDeviceAction =
      /^(?:(?:好|好的|完成|没问题)\s*)?(?:(?:我|我们|刚才|刚刚|刚)\s*)?(?:(?:已(?:经)?|刚(?:刚)?|成功|帮你|为你)\s*)?(?:把|将)(?:.{0,12})?(?:设备|郊狼|负鼠|震动器|电击器)(?:.{0,12})?(打开|开启|启动|通电|开始震动|停止|关闭|关掉|急停|调整|调高|调低|增大|减小|改变)(?:好|成功|完成|了|啦)$/u.exec(
        statement,
      );
    const deviceFirstAction =
      /^(?:设备|郊狼|负鼠|震动器|电击器)\s*(?:(?:已(?:经)?|刚(?:刚)?)\s*)?(?:的?(?:强度|频率|波形)\s*)?(打开|开启|启动|通电|开始震动|停止|关闭|关掉|急停|调整|调高|调低|增大|减小|改变)(?:好|成功|完成|了|啦)$/u.exec(
        statement,
      );
    const directVerb = directDeviceAction?.[1] ?? deviceFirstAction?.[1];
    if (directVerb) {
      if (/^(?:打开|开启|启动|通电|开始震动)$/.test(directVerb)) actions.push('device-start');
      else if (/^(?:停止|关闭|关掉|急停)$/.test(directVerb)) actions.push('device-stop');
      else actions.push('device-adjust');
    }
    // A model can assert a completed call without leading with "already/done".
    // Keep the subject and completion marker explicit so "我可以调用工具"
    // remains a capability statement rather than a claim of execution.
    if (
      /^(?:(?:我|我们|刚才|刚刚)\s*)?(?:已(?:经)?|刚才|刚刚|成功)?\s*(?:调用|执行|运行|使用)(?:了|过|成功)?\s*(?:.{0,12})?(?:工具|函数|接口|API)(?:调用成功|执行成功)?$/i.test(
        statement,
      ) ||
      /^(?:工具|函数|接口|API)\s*(?:已(?:经)?|调用|执行|运行|使用).{0,8}(?:成功|完成|了)$/i.test(
        statement,
      ) ||
      /^(?:i|we)\s+(?:just\s+)?(?:called|used|ran|executed)\s+(?:the\s+|a\s+)?(?:tool|function|api)\b/i.test(
        statement,
      )
    )
      actions.push('tool-invoke');
    // Direct English past-tense claims do not need "I've" or "Done" to assert
    // an action. Keep the subject and past-tense verb anchored so advice,
    // capability statements and future plans are left alone.
    if (
      /^(?:i|we)\s+(?:(?:just|already)\s+)?(?:started|turned on|activated)\s+(?:the|your)\s+(?:device|vibrator|coyote|opossum)\b/i.test(
        statement,
      )
    )
      actions.push('device-start');
    if (
      /^(?:i|we)\s+(?:(?:just|already)\s+)?(?:stopped|turned off|disabled)\s+(?:the|your)\s+(?:device|vibrator|coyote|opossum)\b/i.test(
        statement,
      )
    )
      actions.push('device-stop');
    if (
      /^(?:i|we)\s+(?:(?:just|already)\s+)?(?:adjusted|changed|increased|decreased)\s+(?:the|your)\s+(?:device|strength|intensity|frequency|vibration|waveform)\b/i.test(
        statement,
      )
    )
      actions.push('device-adjust');
    if (
      /^(?:done[,.: ]*|i(?:'ve| have)|we(?:'ve| have)|the (?:device|timer|reminder|plan|file|image|video) (?:has|is)\b)/i.test(
        statement,
      )
    ) {
      if (/\b(?:called|used|ran|executed)\b.{0,48}\b(?:tool|function|api)\b/i.test(statement))
        actions.push('tool-invoke');
      if (
        /\b(?:searched|looked up)\b.{0,48}\b(?:web|internet|online)\b|\b(?:web|internet|online)\b.{0,48}\b(?:searched|looked up)\b/i.test(
          statement,
        )
      )
        actions.push('web-search');
      if (
        /\b(?:started|turned on|activated)\b.{0,48}\b(?:device|vibrator|shock|coyote|opossum)\b|\b(?:device|vibrator|shock|coyote|opossum)\b.{0,48}\b(?:started|turned on|activated)\b/i.test(
          statement,
        )
      )
        actions.push('device-start');
      if (
        /\b(?:stopped|turned off|disabled)\b.{0,48}\b(?:device|vibrator|shock|coyote|opossum)\b|\b(?:device|vibrator|shock|coyote|opossum)\b.{0,48}\b(?:stopped|turned off|disabled)\b/i.test(
          statement,
        )
      )
        actions.push('device-stop');
      if (
        /\b(?:adjusted|changed|increased|decreased)\b.{0,48}\b(?:device|strength|intensity|frequency|vibration|waveform)\b|\b(?:device|strength|intensity|frequency|vibration|waveform)\b.{0,48}\b(?:adjusted|changed|increased|decreased)\b/i.test(
          statement,
        )
      )
        actions.push('device-adjust');
      if (
        /\b(?:set|started|created)\b.{0,48}\btimer\b|\btimer\b.{0,48}\b(?:set|started|created)\b/i.test(
          statement,
        )
      )
        actions.push('timer');
      if (
        /\b(?:saved|created|updated)\b.{0,48}\bplan\b|\bplan\b.{0,48}\b(?:saved|created|updated)\b/i.test(
          statement,
        )
      )
        actions.push('plan-save');
      if (
        /\b(?:saved|stored|memorized|remembered)\b.{0,48}\b(?:memory|fact|this)\b|\bmemory\b.{0,48}\b(?:saved|stored|updated|deleted)\b/i.test(
          statement,
        )
      )
        actions.push('memory-write');
      if (/\b(?:read|opened)\b.{0,48}\bfile\b|\bfile\b.{0,48}\b(?:read|opened)\b/i.test(statement))
        actions.push('file-read');
      if (
        /\b(?:scheduled|set|enabled)\b.{0,48}\b(?:reminder|proactive message)\b|\breminder\b.{0,48}\b(?:scheduled|set|enabled)\b/i.test(
          statement,
        )
      )
        actions.push('reminder-send');
      if (
        /\b(?:generated|created|made)\b.{0,48}\b(?:image|picture|video)\b|\b(?:image|picture|video)\b.{0,48}\b(?:generated|created|made)\b/i.test(
          statement,
        )
      )
        actions.push('media-generate');
    }
    if (
      !/^(?:(?:(?:好|好的|完成|没问题)\s*[,，]?\s*)?(?:我\s*)?(?:已(?:经)?|成功|帮你|为你)|(?:设备|计时器|提醒|任务|计划|记忆|文件|图片|视频)\s*已(?:经)?)/.test(
        statement,
      )
    )
      continue;
    if (/(?:调用|使用|运行|执行).{0,12}(?:工具|函数|接口|API)/i.test(statement))
      actions.push('tool-invoke');
    if (
      /(?:联网|网络|网页|网上).{0,12}(?:搜索|检索|查找)|(?:搜索|检索|查找).{0,12}(?:联网|网络|网页|网上)/.test(
        statement,
      )
    )
      actions.push('web-search');
    if (
      /(?:启动|开启|打开|通电|开始震动).{0,12}(?:设备|郊狼|负鼠|震动|电击)|(?:设备|郊狼|负鼠|震动|电击).{0,12}(?:启动|开启|打开|通电)/.test(
        statement,
      )
    )
      actions.push('device-start');
    if (
      /(?:停止|关闭|关掉|急停).{0,12}(?:设备|郊狼|负鼠|震动|电击)|(?:设备|郊狼|负鼠|震动|电击).{0,12}(?:停止|关闭|关掉|急停)/.test(
        statement,
      )
    )
      actions.push('device-stop');
    if (
      /(?:调整|调高|调低|增大|减小|改变).{0,12}(?:设备|强度|频率|震动|波形)|(?:设备|强度|频率|震动|波形).{0,12}(?:调整|调高|调低|增大|减小|改变)/.test(
        statement,
      )
    )
      actions.push('device-adjust');
    if (/(?:设置|启动|开启).{0,12}计时器|计时器.{0,12}(?:设置|启动|开启)/.test(statement))
      actions.push('timer');
    if (
      /(?:保存|创建|更新).{0,12}(?:任务计划|计划)|(?:任务计划|计划).{0,12}(?:保存|创建|更新)/.test(
        statement,
      )
    )
      actions.push('plan-save');
    if (
      /(?:记住|记下).{0,12}(?:这件事|这段事|你的事|了)|(?:保存|新增|更新|删除).{0,12}记忆|记忆.{0,12}(?:记住|保存|新增|更新|删除)/.test(
        statement,
      )
    )
      actions.push('memory-write');
    if (/(?:读取|读完|打开).{0,12}文件|文件.{0,12}(?:读取|读完|打开)/.test(statement))
      actions.push('file-read');
    if (
      /(?:安排|开启|设置).{0,12}(?:提醒|定时消息|主动消息)|(?:提醒|定时消息|主动消息).{0,12}(?:安排|开启|设置)/.test(
        statement,
      )
    )
      actions.push('reminder-send');
    if (
      /(?:生成|制作).{0,12}(?:图片|图像|视频)|(?:图片|图像|视频).{0,12}(?:生成|制作)/.test(
        statement,
      )
    )
      actions.push('media-generate');
  }
  return actions;
}

function actionLabel(action: ClaimedAction): string {
  switch (action) {
    case 'device-start':
      return '启动设备';
    case 'device-stop':
      return '停止设备';
    case 'device-adjust':
      return '调整设备';
    case 'timer':
      return '设置计时器';
    case 'plan-save':
      return '保存计划';
    case 'memory-write':
      return '写入记忆';
    case 'file-read':
      return '读取文件';
    case 'tool-invoke':
      return '调用工具';
    case 'web-search':
      return '联网搜索';
    case 'reminder-send':
      return '安排提醒';
    case 'media-generate':
      return '生成媒体';
  }
}
