import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const assetRoot = 'reader-support';
const mime: Record<string, string> = {
  wasm: 'application/wasm',
  mjs: 'text/javascript',
  js: 'text/javascript',
  css: 'text/css',
  txt: 'text/plain',
  ttf: 'font/ttf',
  woff2: 'font/woff2',
};

function assetsIn(path: string, prefix: string, output: Map<string, string>): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const source = join(path, entry.name);
    const target = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) assetsIn(source, target, output);
    else if (entry.isFile()) output.set(target, source);
  }
}

const fontNames = [
  'literata', 'source-serif-4', 'pt-serif', 'eb-garamond', 'crimson-pro', 'bitter',
  'lato', 'open-sans', 'inter', 'atkinson-hyperlegible', 'opendyslexic',
];

const fontSubsets = new Set(['latin', 'latin-ext', 'greek', 'greek-ext', 'cyrillic', 'cyrillic-ext']);

function readerFonts(assets: Map<string, string>): string {
  const faces: string[] = [];
  let bytes = 0;
  for (const font of fontNames) {
    const source = dirname(require.resolve(`@fontsource/${font}/package.json`));
    assets.set(`${assetRoot}/licenses/${font}.txt`, join(source, 'LICENSE'));
    for (const face of ['400', '400-italic', '700']) {
      const css = readFileSync(join(source, `${face}.css`), 'utf8');
      const variants = css.matchAll(/@font-face\s*\{[^}]+\}/g);
      for (const [rule] of variants) {
        const filename = /url\(\.\/files\/([^)]*\.woff2)\)/.exec(rule)?.[1];
        if (!filename) continue;
        const subset = filename.slice(font.length + 1).replace(/-\d+-(?:normal|italic)\.woff2$/, '');
        if (!fontSubsets.has(subset)) continue;
        const local = join(source, 'files', filename);
        assets.set(`${assetRoot}/fonts/${filename}`, local);
        bytes += statSync(local).size;
        faces.push(rule.replace(/src:[^;]+;/, `src: url("fonts/${filename}") format("woff2");`));
      }
    }
  }
  if (bytes > 3 * 1024 * 1024) throw new Error(`Reader fonts exceed the 3 MiB font budget (${bytes} bytes).`);
  return faces.join('\n');
}

export function staticReaderAssets(): Plugin {
  const assets = new Map<string, string>();
  const pdf = dirname(require.resolve('pdfjs-dist/package.json'));
  for (const directory of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
    assetsIn(join(pdf, directory), `${assetRoot}/${directory}`, assets);
  }
  assets.set(`${assetRoot}/licenses/pdfjs.txt`, join(pdf, 'LICENSE'));
  const djvu = dirname(require.resolve('djvu-rs'));
  assets.set(`${assetRoot}/licenses/djvu-rs.txt`, join(djvu, 'LICENSE'));
  assets.set(`${assetRoot}/licenses/djvu-rs-third-party.txt`, join(djvu, 'THIRD_PARTY_NOTICES'));
  for (const variant of ['scalar', 'simd128']) {
    const name = `djvu-${variant}.wasm`;
    assets.set(`${assetRoot}/${name}`, join(djvu, variant, 'djvu_rs_bg.wasm'));
  }

  const packages = {
    'space-grotesk': '@fontsource/space-grotesk',
    'space-mono': '@fontsource/space-mono',
    'react': 'react',
    'react-dom': 'react-dom',
  };
  for (const [name, pkg] of Object.entries(packages)) {
    assets.set(`${assetRoot}/licenses/${name}.txt`, join(dirname(require.resolve(`${pkg}/package.json`)), 'LICENSE'));
  }
  for (const pkg of ['foliate-js', 'fflate', 'lucide-react', 'dompurify']) {
    const license = join(dirname(require.resolve('react/package.json')), '..', pkg, 'LICENSE');
    assets.set(`${assetRoot}/licenses/${pkg}.txt`, license);
  }

  const fontCss = readerFonts(assets);
  const stylesheet = `${assetRoot}/fonts.css`;

  return {
    name: 'deft-reader-support',
    transformIndexHtml: () => [{ tag: 'link', attrs: { rel: 'stylesheet', href: `/${stylesheet}` }, injectTo: 'head' }],
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split('?')[0].replace(/^\//, '');
        if (name === stylesheet && (request.method === 'GET' || request.method === 'HEAD')) {
          response.setHeader('Content-Type', 'text/css');
          response.end(request.method === 'HEAD' ? undefined : fontCss);
          return;
        }
        const source = name ? assets.get(name) : undefined;
        if (!source || (request.method !== 'GET' && request.method !== 'HEAD')) return next();
        response.setHeader('Content-Type', mime[source.split('.').at(-1) || ''] || 'application/octet-stream');
        response.setHeader('Content-Length', statSync(source).size);
        if (request.method === 'HEAD') response.end();
        else createReadStream(source).pipe(response);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: stylesheet, source: fontCss });
      for (const [fileName, source] of assets) {
        if (/\/djvu-(?:scalar|simd128)\.wasm$/.test(fileName)) continue;
        this.emitFile({ type: 'asset', fileName, source: readFileSync(source) });
      }
    },
  };
}
