let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

/**
 * Singleton loader for PDF.js that ensures workerSrc is configured once
 * across text extraction, OCR, and Answer Receipt validation.
 */
export async function getPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }
  return pdfjsPromise;
}
