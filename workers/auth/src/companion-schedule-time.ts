export interface CompanionScheduleConfig {
  kind: 'once' | 'weekly';
  localDate?: string;
  localTime: string;
  timeZone: string;
  weekdays: number[];
  quietStart: string;
  quietEnd: string;
  dailyLimit: number;
  template: string;
  mode?: 'template' | 'model';
  acceptedCredits?: number;
  generationPriceVersion?: string;
  contextConsent?: boolean;
}
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}
function parts(at: number, format: Intl.DateTimeFormat) {
  const p = Object.fromEntries(format.formatToParts(at).map((v) => [v.type, v.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function localInstants(date: string, time: string, format: Intl.DateTimeFormat): number[] {
  const target = Date.parse(`${date}T${time}:00Z`);
  const candidates = new Set<number>();
  // Sample offsets on both sides of a transition; round-trip matching rejects
  // nonexistent spring-forward times and captures both fall-back instants.
  for (let delta = -36; delta <= 36; delta += 6) {
    const sample = target + delta * 3_600_000;
    const local = parts(sample, format);
    const offset = Date.parse(`${local.date}T${local.time}:00Z`) - sample;
    const candidate = target - offset;
    const check = parts(candidate, format);
    if (check.date === date && check.time === time) candidates.add(candidate);
  }
  return [...candidates].sort((a, b) => a - b);
}
function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
export function validateScheduleConfig(value: unknown): CompanionScheduleConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('定时配置无效');
  const c = value as CompanionScheduleConfig;
  if (
    !['once', 'weekly'].includes(c.kind) ||
    !TIME.test(c.localTime) ||
    !TIME.test(c.quietStart) ||
    !TIME.test(c.quietEnd) ||
    typeof c.timeZone !== 'string' ||
    c.timeZone.length > 100 ||
    !Array.isArray(c.weekdays) ||
    c.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
    new Set(c.weekdays).size !== c.weekdays.length ||
    !Number.isInteger(c.dailyLimit) ||
    c.dailyLimit < 1 ||
    c.dailyLimit > 3 ||
    typeof c.template !== 'string' ||
    !c.template.trim() ||
    c.template.length > 1000
  )
    throw new Error('请检查时间、时区、星期、消息内容和频率上限');
  if (c.mode !== undefined && !['template', 'model'].includes(c.mode))
    throw new Error('消息模式无效');
  if (
    c.mode === 'model' &&
    (!Number.isSafeInteger(c.acceptedCredits) ||
      c.acceptedCredits! < 1 ||
      c.acceptedCredits! > 10000 ||
      typeof c.generationPriceVersion !== 'string' ||
      c.generationPriceVersion.length > 100 ||
      c.contextConsent !== true)
  )
    throw new Error('请确认AI价格和资料使用授权');
  formatter(c.timeZone).format(0);
  if (c.kind === 'weekly' && c.weekdays.length === 0) throw new Error('请选择至少一天');
  if (
    c.kind === 'once' &&
    (typeof c.localDate !== 'string' ||
      !DATE.test(c.localDate) ||
      Number.isNaN(Date.parse(`${c.localDate}T00:00:00Z`)) ||
      new Date(`${c.localDate}T00:00:00Z`).toISOString().slice(0, 10) !== c.localDate)
  )
    throw new Error('请选择有效日期');
  return {
    kind: c.kind,
    ...(c.kind === 'once' ? { localDate: c.localDate } : {}),
    localTime: c.localTime,
    timeZone: c.timeZone,
    weekdays: [...c.weekdays],
    quietStart: c.quietStart,
    quietEnd: c.quietEnd,
    dailyLimit: c.dailyLimit,
    template: c.template.trim(),
    ...(c.mode === 'model'
      ? {
          mode: 'model' as const,
          acceptedCredits: c.acceptedCredits,
          generationPriceVersion: c.generationPriceVersion,
          contextConsent: true,
        }
      : {}),
  };
}
export function nextOccurrence(
  config: CompanionScheduleConfig,
  after: number,
): { at: number; key: string } | null {
  const format = formatter(config.timeZone);
  const today = parts(after, format).date;
  const dates =
    config.kind === 'once'
      ? [config.localDate!]
      : Array.from({ length: 16 }, (_, i) => addDays(today, i));
  for (const date of dates) {
    if (
      config.kind === 'weekly' &&
      !config.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay())
    )
      continue;
    // Use the first instance only on a repeated local hour, even when after is
    // between the two instances. One local occurrence must never run twice.
    const instant = localInstants(date, config.localTime, format)[0];
    if (instant !== undefined && instant > after)
      return {
        at: instant,
        key: `${date.replaceAll('-', '')}${config.localTime.replace(':', '')}`,
      };
  }
  return null;
}
export function quietUntil(config: CompanionScheduleConfig, at: number): number | null {
  if (config.quietStart === config.quietEnd) return null;
  const format = formatter(config.timeZone);
  const local = parts(at, format);
  const overnight = config.quietStart > config.quietEnd;
  const quiet = overnight
    ? local.time >= config.quietStart || local.time < config.quietEnd
    : local.time >= config.quietStart && local.time < config.quietEnd;
  if (!quiet) return null;
  const date = overnight && local.time >= config.quietStart ? addDays(local.date, 1) : local.date;
  // If quiet-end falls in a missing DST hour, defer minute by minute until the
  // first existing local time beyond it; never send during the quiet interval.
  for (let i = 0; i <= 180; i++) {
    const nominal = new Date(Date.parse(`${date}T${config.quietEnd}:00Z`) + i * 60_000);
    const candidates = localInstants(
      nominal.toISOString().slice(0, 10),
      nominal.toISOString().slice(11, 16),
      format,
    );
    const future = candidates.find((candidate) => candidate > at);
    if (future !== undefined) return future;
  }
  throw new Error('无法计算安静时段结束时间');
}
