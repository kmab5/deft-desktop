import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeBookBytes, rpc } from './api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const native = vi.mocked(invoke);

beforeEach(() => {
  native.mockReset();
  vi.stubGlobal('window', globalThis);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('desktop requests', () => {
  it('reassembles a large UTF-8 response across chunk boundaries', async () => {
    const json = Buffer.from('{"title":"Déliver"}');
    native.mockResolvedValueOnce({ deftTransfer: { id: 'response', chunks: 2, size: json.length } })
      .mockResolvedValueOnce(json.subarray(0, 12).toString('base64'))
      .mockResolvedValueOnce(json.subarray(12).toString('base64'));
    await expect(rpc('open', { bookId: 'book' })).resolves.toEqual({ title: 'Déliver' });
    expect(native).toHaveBeenNthCalledWith(3, 'deft_chunk', { id: 'response', index: 1 });
  });

  it('reads binary page data independently of JSON book metadata', async () => {
    native.mockResolvedValueOnce({ deftBytes: 'AP8a' });
    expect([...new Uint8Array(await nativeBookBytes('book', 0))]).toEqual([0, 255, 26]);
    expect(native).toHaveBeenCalledWith('publication_asset', { bookId: 'book', index: 0 });
  });

  it('reports a stalled mutation instead of replaying it', async () => {
    vi.useFakeTimers();
    native.mockReturnValueOnce(new Promise(() => {}));
    const failed = expect(rpc('bookPatch', { bookId: 'book', favorite: true })).rejects.toThrow('stopped responding');
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(native).toHaveBeenCalledTimes(1);
  });

  it('sends Windows calls over the native WebView bridge with Tauri authentication', () => {
    const script = readFileSync(new URL('../src-tauri/src/windows-ipc.js', import.meta.url), 'utf8')
      .replace('__INVOKE_KEY__', '"test-invoke-key"');
    const postMessage = vi.fn();
    const bridge = { postMessage: (_message: unknown) => {} };
    runInNewContext(script, { window: { ipc: { postMessage }, __TAURI_INTERNALS__: bridge } });
    bridge.postMessage({ cmd: 'deft', callback: 1, error: 2, payload: { op: 'snapshot', args: {} } });
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({
      cmd: 'deft', callback: 1, error: 2, payload: { op: 'snapshot', args: {} },
      options: { customProtocolIpcBlocked: true }, __TAURI_INVOKE_KEY__: 'test-invoke-key',
    });
  });
});
