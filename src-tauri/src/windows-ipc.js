// Use WebView2's native message transport instead of its virtual HTTP handler.
;(function () {
  const key = __INVOKE_KEY__;
  const serialize = '__TAURI_TO_IPC_KEY__';
  Object.defineProperty(window.__TAURI_INTERNALS__, 'postMessage', {
    value({ cmd, callback, error, payload, options }) {
      window.ipc.postMessage(JSON.stringify({
        cmd, callback, error, payload, __TAURI_INVOKE_KEY__: key,
        options: { ...options, customProtocolIpcBlocked: true },
      }, (_, value) => value && typeof value[serialize] === 'function' ? value[serialize]() : value));
    },
  });
})();
