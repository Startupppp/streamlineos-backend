import { PDFDocument, type PDFPage } from "pdf-lib";

export interface PdfRenderLimits {
  readonly maxBytes: number;
  readonly maxInputBytes: number;
  readonly maxPages: number;
  readonly maxWorkUnits: number;
  readonly timeoutMs: number;
}

export interface PdfRenderContext {
  readonly document: PDFDocument;
  addPage(size?: [number, number]): PDFPage;
  checkpoint(workUnits?: number): void;
  load(source: Buffer): Promise<PDFDocument>;
}

export interface PdfRenderSession extends PdfRenderContext {
  finish(): Promise<Buffer>;
}

export type PdfRenderErrorCode =
  | "PDF_INPUT_SIZE_LIMIT_EXCEEDED"
  | "PDF_PAGE_LIMIT_EXCEEDED"
  | "PDF_RENDER_FAILED"
  | "PDF_RENDER_TIMEOUT"
  | "PDF_SIZE_LIMIT_EXCEEDED"
  | "PDF_WORK_LIMIT_EXCEEDED";

const ERROR_MESSAGES: Readonly<Record<PdfRenderErrorCode, string>> = {
  PDF_INPUT_SIZE_LIMIT_EXCEEDED: "PDF input size limit exceeded",
  PDF_PAGE_LIMIT_EXCEEDED: "PDF page limit exceeded",
  PDF_RENDER_FAILED: "PDF rendering failed",
  PDF_RENDER_TIMEOUT: "PDF rendering timed out",
  PDF_SIZE_LIMIT_EXCEEDED: "PDF size limit exceeded",
  PDF_WORK_LIMIT_EXCEEDED: "PDF work limit exceeded",
};

export class PdfRenderError extends Error {
  constructor(readonly code: PdfRenderErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PdfRenderError";
  }
}

export const PDF_RENDER_LIMITS: PdfRenderLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxInputBytes: 16 * 1024 * 1024,
  maxPages: 100,
  maxWorkUnits: 250_000,
  timeoutMs: 15_000,
});

function resolveLimits(requested?: Partial<PdfRenderLimits>): PdfRenderLimits {
  const resolve = (value: number | undefined, ceiling: number): number => {
    if (value === undefined) return ceiling;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PdfRenderError("PDF_RENDER_FAILED");
    }
    return Math.min(value, ceiling);
  };

  return {
    maxBytes: resolve(requested?.maxBytes, PDF_RENDER_LIMITS.maxBytes),
    maxInputBytes: resolve(requested?.maxInputBytes, PDF_RENDER_LIMITS.maxInputBytes),
    maxPages: resolve(requested?.maxPages, PDF_RENDER_LIMITS.maxPages),
    maxWorkUnits: resolve(requested?.maxWorkUnits, PDF_RENDER_LIMITS.maxWorkUnits),
    timeoutMs: resolve(requested?.timeoutMs, PDF_RENDER_LIMITS.timeoutMs),
  };
}

class BoundedPdfSession implements PdfRenderSession {
  private readonly startedAt = performance.now();
  private inputBytes = 0;
  private workUnits = 0;

  constructor(
    readonly document: PDFDocument,
    private readonly limits: PdfRenderLimits,
  ) {}

  addPage(size?: [number, number]): PDFPage {
    this.checkpoint();
    if (this.document.getPageCount() >= this.limits.maxPages) {
      throw new PdfRenderError("PDF_PAGE_LIMIT_EXCEEDED");
    }
    return size === undefined ? this.document.addPage() : this.document.addPage(size);
  }

  checkpoint(units = 1): void {
    if (!Number.isSafeInteger(units) || units < 0) {
      throw new PdfRenderError("PDF_RENDER_FAILED");
    }
    this.workUnits += units;
    if (this.workUnits > this.limits.maxWorkUnits) {
      throw new PdfRenderError("PDF_WORK_LIMIT_EXCEEDED");
    }
    this.assertDeadline();
  }

  async load(source: Buffer): Promise<PDFDocument> {
    this.inputBytes += source.length;
    if (this.inputBytes > this.limits.maxInputBytes) {
      throw new PdfRenderError("PDF_INPUT_SIZE_LIMIT_EXCEEDED");
    }
    const loaded = await this.withDeadline(
      PDFDocument.load(source, { ignoreEncryption: true }),
    );
    if (loaded.getPageCount() > this.limits.maxPages) {
      throw new PdfRenderError("PDF_PAGE_LIMIT_EXCEEDED");
    }
    this.checkpoint(loaded.getPageCount());
    return loaded;
  }

  async finish(): Promise<Buffer> {
    this.checkpoint(0);
    if (this.document.getPageCount() > this.limits.maxPages) {
      throw new PdfRenderError("PDF_PAGE_LIMIT_EXCEEDED");
    }
    const saved = await this.withDeadline(
      this.document.save({ addDefaultPage: false, objectsPerTick: 50, useObjectStreams: true }),
    );
    const bytes = Buffer.from(saved);
    if (bytes.length > this.limits.maxBytes) {
      throw new PdfRenderError("PDF_SIZE_LIMIT_EXCEEDED");
    }
    return bytes;
  }

  async run(render: (context: PdfRenderContext) => Promise<void> | void): Promise<Buffer> {
    const context: PdfRenderContext = {
      document: this.document,
      addPage: this.addPage.bind(this),
      checkpoint: this.checkpoint.bind(this),
      load: this.load.bind(this),
    };
    await this.withDeadline(Promise.resolve().then(() => render(context)));
    return this.finish();
  }

  private assertDeadline(): void {
    if (performance.now() - this.startedAt > this.limits.timeoutMs) {
      throw new PdfRenderError("PDF_RENDER_TIMEOUT");
    }
  }

  private async withDeadline<T>(operation: Promise<T>): Promise<T> {
    const remaining = this.limits.timeoutMs - (performance.now() - this.startedAt);
    if (remaining <= 0) throw new PdfRenderError("PDF_RENDER_TIMEOUT");

    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new PdfRenderError("PDF_RENDER_TIMEOUT")),
            remaining,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function protect<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: unknown) => {
    if (error instanceof PdfRenderError) throw error;
    throw new PdfRenderError("PDF_RENDER_FAILED");
  });
}

export async function createBoundedPdfSession(
  requestedLimits?: Partial<PdfRenderLimits>,
): Promise<PdfRenderSession> {
  const limits = resolveLimits(requestedLimits);
  return protect(async () => new BoundedPdfSession(await PDFDocument.create(), limits));
}

export async function loadBoundedPdfSession(
  source: Buffer,
  requestedLimits?: Partial<PdfRenderLimits>,
): Promise<PdfRenderSession> {
  const limits = resolveLimits(requestedLimits);
  return protect(async () => {
    const loader = new BoundedPdfSession(await PDFDocument.create(), limits);
    const loaded = await loader.load(source);
    return new BoundedPdfSession(loaded, limits);
  });
}

export async function renderBoundedPdf(
  render: (context: PdfRenderContext) => Promise<void> | void,
  requestedLimits?: Partial<PdfRenderLimits>,
): Promise<Buffer> {
  return protect(async () => {
    const session = (await createBoundedPdfSession(requestedLimits)) as BoundedPdfSession;
    return session.run(render);
  });
}
