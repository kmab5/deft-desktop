import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { staticReaderAssets } from './src/readerAssetPlugin';

export default defineConfig({
  clearScreen: false,
  base: './',
  plugins: [react(), staticReaderAssets()],
  server: { host: 'localhost', port: 1420, strictPort: true },
  build: { target: 'es2022' },
});
