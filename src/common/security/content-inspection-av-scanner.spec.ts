import { AvScanner, type AvScanResult } from "./av-scan";
import {
  CompositeAvScanner,
  ContentInspectionScanner,
  inspectContent,
} from "./content-inspection-av-scanner";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

function withMagic(magic: number[], rest = ""): Buffer {
  return Buffer.concat([Buffer.from(magic), Buffer.from(rest, "latin1")]);
}

const PNG = withMagic([0x89, 0x50, 0x4e, 0x47], "a perfectly ordinary screenshot");
const PDF = withMagic([0x25, 0x50, 0x44, 0x46], "-1.7\n/Type /Catalog\n/Pages 2 0 R");
const DOCX = withMagic([0x50, 0x4b, 0x03, 0x04], "word/document.xml");
const DOC = withMagic([0xd0, 0xcf, 0x11, 0xe0], "WordDocument");

describe("an ordinary user upload is not refused", () => {
  it.each([
    ["a screenshot", PNG],
    ["a receipt PDF", PDF],
    ["a Word document", DOCX],
    ["a legacy Word document", DOC],
  ])("passes %s", (_label, buffer) => {
    expect(inspectContent(buffer)).toEqual({ status: "clean" });
  });

  it("passes a PDF carrying /OpenAction, /AA and /EmbeddedFile, because exported receipts and PDF/A-3 invoices carry them routinely", () => {
    const benign = withMagic(
      [0x25, 0x50, 0x44, 0x46],
      "-1.7 /OpenAction 5 0 R /AA << >> /EmbeddedFile 9 0 R",
    );
    expect(inspectContent(benign)).toEqual({ status: "clean" });
  });
});

describe("content that can execute is refused even when the container type is allowed", () => {
  it("refuses the EICAR test file, so the gate can be verified end to end after deployment", () => {
    expect(inspectContent(Buffer.from(EICAR))).toEqual({
      status: "infected",
      threat: "EICAR-Test-Signature",
    });
  });

  it.each([
    ["a Windows PE", [0x4d, 0x5a]],
    ["an ELF binary", [0x7f, 0x45, 0x4c, 0x46]],
    ["a Mach-O binary", [0xcf, 0xfa, 0xed, 0xfe]],
    ["a shell script", [0x23, 0x21]],
  ])("refuses %s regardless of the declared type", (_label, magic) => {
    const result = inspectContent(withMagic(magic, "payload"));
    expect(result).toEqual({ status: "infected", threat: "executable-image-in-upload" });
  });

  it("refuses an OOXML document carrying a VBA project, which a .docx has no legitimate reason to contain", () => {
    const macroDocx = withMagic([0x50, 0x4b, 0x03, 0x04], "word/vbaProject.bin");
    expect(inspectContent(macroDocx)).toEqual({
      status: "infected",
      threat: "ooxml-macro:vbaProject.bin",
    });
  });

  it("refuses a legacy OLE document carrying a VBA project", () => {
    const macroDoc = withMagic([0xd0, 0xcf, 0x11, 0xe0], "_VBA_PROJECT");
    expect(inspectContent(macroDoc)).toEqual({
      status: "infected",
      threat: "ole-macro:_VBA_PROJECT",
    });
  });

  it.each([["/JavaScript"], ["/JS"], ["/Launch"]])(
    "refuses a PDF containing %s",
    (marker) => {
      const result = inspectContent(withMagic([0x25, 0x50, 0x44, 0x46], `-1.7 ${marker} (app)`));
      expect(result.status).toBe("infected");
    },
  );

  it("only applies the macro check to the matching container, so a PNG mentioning vbaProject.bin in metadata is not refused", () => {
    const png = withMagic([0x89, 0x50, 0x4e, 0x47], "comment: vbaProject.bin");
    expect(inspectContent(png)).toEqual({ status: "clean" });
  });
});

describe("the scanner composes so that adding ClamAV keeps the structural checks in front of it", () => {
  function stub(result: AvScanResult): AvScanner & { scan: jest.Mock } {
    const scan = jest.fn().mockResolvedValue(result);
    return { scan } as unknown as AvScanner & { scan: jest.Mock };
  }

  it("never reaches the signature scanner once content inspection has refused", async () => {
    const signatures = stub({ status: "clean" });
    const composite = new CompositeAvScanner([new ContentInspectionScanner(), signatures]);

    const result = await composite.scan(Buffer.from(EICAR), "eicar.txt", "text/plain");

    expect(result.status).toBe("infected");
    expect(signatures.scan).not.toHaveBeenCalled();
  });

  it("surfaces the signature scanner's verdict when content inspection is satisfied", async () => {
    const signatures = stub({ status: "infected", threat: "Win.Trojan.Fake" });
    const composite = new CompositeAvScanner([new ContentInspectionScanner(), signatures]);

    const result = await composite.scan(PNG, "shot.png", "image/png");

    expect(result).toEqual({ status: "infected", threat: "Win.Trojan.Fake" });
    expect(signatures.scan).toHaveBeenCalledTimes(1);
  });

  it("propagates a signature scanner outage as an error, so the upload still fails closed", async () => {
    const signatures = stub({ status: "error", reason: "clamd-unreachable" });
    const composite = new CompositeAvScanner([new ContentInspectionScanner(), signatures]);

    const result = await composite.scan(PNG, "shot.png", "image/png");

    expect(result).toEqual({ status: "error", reason: "clamd-unreachable" });
  });

  it("is clean only when every scanner is clean", async () => {
    const signatures = stub({ status: "clean" });
    const composite = new CompositeAvScanner([new ContentInspectionScanner(), signatures]);

    await expect(composite.scan(PNG, "shot.png", "image/png")).resolves.toEqual({
      status: "clean",
    });
  });
});

describe("the scanner behaves identically in development and production", () => {
  it("does not consult NODE_ENV, so a file that uploads in dev uploads in production", async () => {
    const scanner = new ContentInspectionScanner();
    const previous = process.env.NODE_ENV;

    process.env.NODE_ENV = "development";
    const inDev = await scanner.scan(PNG, "shot.png", "image/png");
    process.env.NODE_ENV = "production";
    const inProd = await scanner.scan(PNG, "shot.png", "image/png");
    process.env.NODE_ENV = previous;

    expect(inDev).toEqual({ status: "clean" });
    expect(inProd).toEqual({ status: "clean" });
  });
});
