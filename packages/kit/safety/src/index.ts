// @dg-kit/safety —— 设备安全链的唯一真身。
//
// 策略引擎（强度上限 / 冷启动钳制 / burst 独立上限 / 累计天花板）、默认策略、
// 串行命令队列（含急停插队与 generation 作废）。合并前 DG-Agent 与 DG-Voice 各
// 持一份：剥离 import 与注释后两份逐字节相同，所以这次合并不涉及任何行为仲裁。
export * from './contracts.js';
export * from './policy-engine.js';
export * from './default-policies.js';
export * from './device-command-queue.js';
