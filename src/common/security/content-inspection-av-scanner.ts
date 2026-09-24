import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { AvScanner, type AvScanResult } from "./av-scan";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

const EXECUTABLE_MAGICS: readonly (readonly number[])[] = [
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0x23, 0x21],
];

const OOXML_MAGIC: readonly number[] = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0];
const PDF_MAGIC: readonly number[] = [0x25, 0x50, 0x44, 0x46];

const OOXML_MACRO_MARKERS = ["vbaProject.bin", "vbaData.xml"] as const;
const OLE_MACRO_MARKERS = ["_VBA_PROJECT", "VBA_PROJECT_CUR"] as const;

const PDF_ACTIVE_CONTENT_MARKERS = ["/JavaScript", "/JS", "/Launch"] as const;

function startsWith(buffer: Buffer, magic: readonly number[]): boolean {
  if (buffer.length < magic.length) return false;
  return magic.every((byte, index) => buffer[index] === byte);
}

function containsAscii(buffer: Buffer, needle: string): boolean {
  return buffer.includes(Buffer.from(needle, "latin1"));
}

export function inspectContent(buffer: Buffer): AvScanResult {
  if (containsAscii(buffer, EICAR))
    return { status: "infected", threat: "EICAR-Test-Signature" };

  const executable = EXECUTABLE_MAGICS.find((magic) => startsWith(buffer, magic));
  if (executable)
    return { status: "infected", threat: "executable-image-in-upload" };

  if (startsWith(buffer, OOXML_MAGIC)) {
    const marker = OOXML_MACRO_MARKERS.find((needle) => containsAscii(buffer, needle));
    if (marker) return { status: "infected", threat: `ooxml-macro:${marker}` };
  }

  if (startsWith(buffer, OLE_MAGIC)) {
    const marker = OLE_MACRO_MARKERS.find((needle) => containsAscii(buffer, needle));
    if (marker) return { status: "infected", threat: `ole-macro:${marker}` };
  }

  if (startsWith(buffer, PDF_MAGIC)) {
    const marker = PDF_ACTIVE_CONTENT_MARKERS.find((needle) => containsAscii(buffer, needle));
    if (marker) return { status: "infected", threat: `pdf-active-content:${marker}` };
  }

  return { status: "clean" };
}

@Injectable()
export class ContentInspectionScanner extends AvScanner implements OnModuleInit {
  private readonly logger = new Logger(ContentInspectionScanner.name);

  onModuleInit(): void {
    this.logger.log(
      "Content-inspection scanner active — structural checks only, no malware signatures. Set AV_SCANNER=clamav for signature scanning.",
    );
  }

  async scan(buffer: Buffer, filename: string, _mimeType: string): Promise<AvScanResult> {
    const result = inspectContent(buffer);
    if (result.status === "infected")
      this.logger.warn(`Upload refused by content inspection: ${result.threat}`, { filename });
    return result;
  }
}

@Injectable()
export class CompositeAvScanner extends AvScanner {
  constructor(private readonly scanners: readonly AvScanner[]) {
    super();
  }

  async scan(buffer: Buffer, filename: string, mimeType: string): Promise<AvScanResult> {
    for (const scanner of this.scanners) {
      const result = await scanner.scan(buffer, filename, mimeType);
      if (result.status !== "clean") return result;
    }
    return { status: "clean" };
  }
}
