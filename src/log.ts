import { AsyncLocalStorage } from 'node:async_hooks';

// 任务级日志作用域（形如「豆包·关键词」）。并发任务各持一份，互不串扰。
const scopeStore = new AsyncLocalStorage<string>();

export function withLogScope<T>(scope: string, fn: () => T): T {
  return scopeStore.run(scope, fn);
}

function prefix(): string {
  const s = scopeStore.getStore();
  return s ? `[${s}] ` : '';
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
