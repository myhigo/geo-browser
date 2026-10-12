import { AsyncLocalStorage } from 'node:async_hooks';

// 任务级日志作用域（形如「豆包·关键词」）。并发任务各持一份，互不串扰。
const scopeStore = new AsyncLocalStorage<string>();

export function withLogScope<T>(scope: string, fn: () => T): T {
  return scopeStore.run(scope, fn);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// 绝对时间戳（MM-DD HH:mm:ss），与调度器日志（pull.ts ts()）同格式，便于跨行对时
function stamp(): string {
  const d = new Date();
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function prefix(): string {
  const s = scopeStore.getStore();
  return `[${stamp()}]` + (s ? `[${s}] ` : ' ');
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}

export function log(...args: unknown[]): void {
  console.log(prefix() + fmt(args));
}

export function warn(...args: unknown[]): void {
  console.warn(prefix() + fmt(args));
}

export function err(...args: unknown[]): void {
  console.error(prefix() + fmt(args));
}
