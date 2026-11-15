import init, { WasmDocument, wasmSimd128Supported } from 'djvu-rs';

type Request =
  | { id: number; action: 'open'; bytes: ArrayBuffer }
  | { id: number; action: 'render'; page: number; width: number };

let document: WasmDocument | undefined;

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    if (request.action === 'open') {
      const variant = wasmSimd128Supported() ? 'simd128' : 'scalar';
      const asset = import.meta.env.DEV
        ? new URL(`/reader-support/djvu-${variant}.wasm`, self.location.href)
        : undefined;
      await init(asset);
      document?.free();
      document = WasmDocument.from_bytes(new Uint8Array(request.bytes));
      self.postMessage({ id: request.id, count: document.page_count() });
      return;
    }

    if (!document) throw new Error('The DjVu document is closed.');
    const page = document.page(request.page);
    try {
      const nativeDpi = page.dpi() || 300;
      const width = page.width_at(nativeDpi);
      const height = page.height_at(nativeDpi);
      const scale = Math.min(1.5, request.width / width, 4096 / Math.max(width, height));
      const dpi = Math.max(1, Math.round(nativeDpi * scale));
      const pixels = page.render(dpi);
      self.postMessage(
        { id: request.id, pixels, width: page.width_at(dpi), height: page.height_at(dpi) },
        { transfer: [pixels.buffer] },
      );
    } finally {
      page.free();
    }
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
