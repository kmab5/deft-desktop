import { invoke } from '@tauri-apps/api/core';

type Transfer = { deftTransfer: { id: string; size: number; chunks: number } };
type InlineBytes = { deftBytes: string };

const interactiveOperations = new Set([
  'scan', 'folderAdd', 'folderRemove', 'folderExclude', 'folderUnexclude',
  'exportToFile', 'restoreBackup', 'backupFolder', 'importFont', 'bookCover', 'categoryCover', 'chooseDictionary',
]);
const longOperations = new Set(['open', 'snapshot', 'matchCandidates', 'matchCover']);

function request<T>(command: string, args: Record<string, unknown>, timeout: number | null, signal?: AbortSignal): Promise<T> {
  let cleanup = () => {};
  const response = new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal?.reason);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    const timer = timeout === null ? undefined
      : window.setTimeout(() => reject(new Error('Deft stopped responding to this request. Try again.')), timeout);
    cleanup = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    void invoke<T>(command, args).then(resolve, reject);
  });
  return response.finally(cleanup);
}

function isTransfer(value: unknown): value is Transfer {
  return Boolean(value && typeof value === 'object' && 'deftTransfer' in value);
}

function decode64(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64);
  return Uint8Array.from(text, character => character.charCodeAt(0));
}

async function receive({ deftTransfer: { id, size, chunks } }: Transfer, signal?: AbortSignal) {
  const output = new Uint8Array(size);
  try {
    let offset = 0;
    for (let index = 0; index < chunks; index++) {
      const encoded = await request<string>('deft_chunk', { id, index }, 15000, signal);
      const chunk = decode64(encoded);
      output.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== size) throw new Error('Deft received an incomplete response.');
    return output;
  } catch (error) {
    void invoke('deft_discard', { id }).catch(() => {});
    throw error;
  }
}

export async function rpc<T = unknown>(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const timeout = interactiveOperations.has(op) ? null : longOperations.has(op) ? 90000 : 20000;
  const reply = await request<T | Transfer>('deft', { op, args }, timeout, signal);
  return isTransfer(reply) ? JSON.parse(new TextDecoder().decode(await receive(reply, signal))) as T : reply;
}

export async function nativeBookBytes(bookId: string, index?: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const reply = await request<Transfer | InlineBytes | ArrayBuffer | number[]>(
    'publication_asset', { bookId, index: index ?? null }, 120000, signal,
  );
  if (isTransfer(reply)) return (await receive(reply, signal)).buffer;
  if (reply instanceof ArrayBuffer) return reply;
  if (Array.isArray(reply)) return Uint8Array.from(reply).buffer;
  return decode64(reply.deftBytes).buffer;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
