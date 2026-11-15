declare module 'foliate-js/mobi.js' {
  export interface KindleToc {
    label: string;
    href: string;
    subitems?: KindleToc[];
  }

  interface KindleLocation {
    index: number;
    anchor?: (doc: DocumentFragment) => Element | null;
  }

  export interface KindlePublication {
    metadata: { title?: string; language?: string | string[] };
    sections: Array<{ load?: () => Promise<string> }>;
    toc?: KindleToc[];
    resolveHref(href: string): KindleLocation | undefined | Promise<KindleLocation | undefined>;
    destroy(): void;
  }

  export class MOBI {
    constructor(options: { unzlib(bytes: Uint8Array): Uint8Array });
    open(file: Blob): Promise<KindlePublication>;
  }
}
