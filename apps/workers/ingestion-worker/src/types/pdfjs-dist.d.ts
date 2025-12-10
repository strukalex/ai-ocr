declare module 'pdfjs-dist/legacy/build/pdf.js' {
  export function getDocument(options: unknown): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{
          items: Array<{ str?: string }>;
        }>;
        cleanup?: () => void;
      }>;
      destroy?: () => void | Promise<void>;
    }>;
  };
}

