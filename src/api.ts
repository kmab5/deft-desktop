import { invoke } from '@tauri-apps/api/core';

export function rpc<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>('deft', { op, args });
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
