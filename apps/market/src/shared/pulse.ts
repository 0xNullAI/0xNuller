// DG-Lab `.pulse` 文本格式解析器，移植自 @dg-kit/waveforms，纯函数无运行时依赖。
// 将一段 "Dungeonlab+pulse:..." 展开为 25ms 网格上的 [编码频率, 强度][]。

type WaveFrame = [number, number];

const FREQ_DATASET = [
  10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
];
const DURATION_DATASET = [1, 2, 3, 4, 5, 8, 10, 15, 20, 30, 40, 50, 60];

function freqFromIndex(index: number): number {
  const clamped = Math.max(0, Math.min(FREQ_DATASET.length - 1, Math.floor(index)));
  return FREQ_DATASET[clamped] ?? 10;
}

function durationFromIndex(index: number): number {
  const clamped = Math.max(0, Math.min(DURATION_DATASET.length - 1, Math.floor(index)));
  return DURATION_DATASET[clamped] ?? 1;
}

export function encodeFreq(value: number): number {
  let output: number;
  if (value >= 10 && value <= 100) output = value;
  else if (value > 100 && value <= 600) output = (value - 100) / 5 + 100;
  else if (value > 600 && value <= 1000) output = (value - 600) / 10 + 200;
  else if (value < 10) output = 10;
  else output = 240;
  return Math.max(10, Math.min(240, Math.round(output)));
}

export interface ParsedPulse {
  name: string;
  frames: WaveFrame[];
}

export function parsePulseText(data: string): ParsedPulse {
  const trimmed = data.trim();
  if (!/^Dungeonlab\+pulse:/i.test(trimmed)) {
    throw new Error("脉冲格式无效，必须以 'Dungeonlab+pulse:' 开头");
  }
  const cleanData = trimmed.replace(/^Dungeonlab\+pulse:/i, '');
  const sectionParts = cleanData.split('+section+');
  if (sectionParts.length === 0 || !sectionParts[0]) {
    throw new Error('脉冲数据无效，未找到任何分段');
  }
  const firstPart = sectionParts[0];
  const equalIndex = firstPart.indexOf('=');
  if (equalIndex === -1) {
    throw new Error("脉冲格式无效，缺少 '=' 分隔符");
  }
  const embeddedName = firstPart.substring(0, equalIndex).trim();

  interface Section {
    frequencyMode: number;
    shape: { strength: number }[];
    startFrequency: number;
    endFrequency: number;
    duration: number;
  }
  const sections: Section[] = [];
  const firstSectionData = firstPart.substring(equalIndex + 1);
  const allSectionData = [firstSectionData, ...sectionParts.slice(1)];

  for (let index = 0; index < allSectionData.length && index < 10; index++) {
    const sectionData = allSectionData[index];
    if (!sectionData) continue;
    const slashIndex = sectionData.indexOf('/');
    if (slashIndex === -1) {
      throw new Error(`第 ${index + 1} 段缺少 '/' 分隔符`);
    }
    const headerPart = sectionData.substring(0, slashIndex);
    const shapePart = sectionData.substring(slashIndex + 1);
    const headerValues = headerPart.split(',');
    const freqRange1Index = Number(headerValues[0]) || 0;
    const freqRange2Index = Number(headerValues[1]) || 0;
    const durationIndex = Number(headerValues[2]) || 0;
    const freqMode = Number(headerValues[3]) || 1;
    const enabled = headerValues[4] !== '0';

    const shapePoints: { strength: number }[] = [];
    for (const item of shapePart.split(',')) {
      if (!item) continue;
      const [strengthStr] = item.split('-');
      const strength = Math.round(Number(strengthStr) || 0);
      shapePoints.push({ strength: Math.max(0, Math.min(100, strength)) });
    }
    if (shapePoints.length < 2) {
      throw new Error(`第 ${index + 1} 段至少需要 2 个形状点`);
    }
    if (enabled) {
      sections.push({
        frequencyMode: freqMode,
        shape: shapePoints,
        startFrequency: freqFromIndex(freqRange1Index),
        endFrequency: freqFromIndex(freqRange2Index),
        duration: durationFromIndex(durationIndex),
      });
    }
  }

  if (sections.length === 0) {
    throw new Error('脉冲数据无效，没有启用的分段');
  }

  const frames: WaveFrame[] = [];
  for (const section of sections) {
    const shapeCount = section.shape.length;
    const pulseElementDuration = shapeCount;
    const sectionDuration = section.duration;
    const { startFrequency, endFrequency, frequencyMode } = section;
    const pulseElementCount = Math.max(1, Math.ceil(sectionDuration / pulseElementDuration));
    const actualDuration = pulseElementCount * pulseElementDuration;

    for (let elementIndex = 0; elementIndex < pulseElementCount; elementIndex++) {
      for (let shapeIndex = 0; shapeIndex < shapeCount; shapeIndex++) {
        const strength = section.shape[shapeIndex]?.strength ?? 0;
        const currentTime = elementIndex * pulseElementDuration + shapeIndex;
        const sectionProgress = currentTime / actualDuration;
        const elementProgress = shapeIndex / shapeCount;
        let rawFreq: number;
        switch (frequencyMode) {
          case 2:
            rawFreq = startFrequency + (endFrequency - startFrequency) * sectionProgress;
            break;
          case 3:
            rawFreq = startFrequency + (endFrequency - startFrequency) * elementProgress;
            break;
          case 4: {
            const progress = pulseElementCount > 1 ? elementIndex / (pulseElementCount - 1) : 0;
            rawFreq = startFrequency + (endFrequency - startFrequency) * progress;
            break;
          }
          default:
            rawFreq = startFrequency;
        }
        frames.push([encodeFreq(rawFreq), Math.max(0, Math.min(100, Math.round(strength)))]);
      }
    }
  }

  if (frames.length === 0) {
    throw new Error('解析后的波形为空');
  }
  return { name: embeddedName, frames };
}
