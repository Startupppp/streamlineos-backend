export type AvScanResult =
  | { status: "clean" }
  | { status: "infected"; threat: string }
  | { status: "error"; reason: string };

export abstract class AvScanner {
  abstract scan(buffer: Buffer, filename: string, mimeType: string): Promise<AvScanResult>;
}

