import { inflateSync } from "node:zlib";
import { SignPdfService } from "../sign-pdf.service";
import type { CertificateData } from "../sign-pdf.service";

/**
 * The drawn text, recovered from the PDF.
 *
 * pdf-lib writes page content into Flate-compressed streams, so searching the
 * raw bytes finds nothing and a test that did so would pass whatever the
 * document said. Every stream is inflated and concatenated; the ones that are
 * not text (fonts, object streams) simply contribute no matches.
 */
function renderedText(pdf: Buffer): string {
  const marker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  let out = "";
  let cursor = 0;

  while (cursor < pdf.length) {
    const start = pdf.indexOf(marker, cursor);
    if (start === -1) break;
    const end = pdf.indexOf(endMarker, start);
    if (end === -1) break;

    /** Skip past "stream" and the EOL that must follow it. */
    let bodyStart = start + marker.length;
    while (pdf[bodyStart] === 0x0d || pdf[bodyStart] === 0x0a) bodyStart += 1;

    try {
      out += inflateSync(pdf.subarray(bodyStart, end)).toString("latin1");
    } catch {
      out += pdf.subarray(bodyStart, end).toString("latin1");
    }
    cursor = end + endMarker.length;
  }

  /**
   * pdf-lib emits drawn text as hex string operands — `<4365727469…> Tj` — not
   * as literals, so the inflated stream still does not contain a single
   * readable sentence. Decoding them is the last step, and skipping it is how
   * a test like this ends up asserting against binary noise and passing.
   */
  return out.replace(/<([0-9A-Fa-f\s]+)>\s*Tj/g, (_match, hex: string) =>
    Buffer.from(hex.replace(/\s+/g, ""), "hex").toString("latin1"),
  );
}

/**
 * SIGN-P0-07. What the certificate says it is.
 *
 * Nothing in this PDF ever claimed PKI, and that is not the same as being
 * clear. A page headed "Certificate of Completion", issued by an e-signature
 * product and covered in cryptographic hashes, reads as a signing certificate
 * to anyone not looking for the distinction — and the people who read these
 * are lawyers and auditors deciding what it proves.
 *
 * The assertions run against the rendered bytes rather than the source, so a
 * refactor that moves the wording out of the document still fails. That
 * matters more than usual here: the whole risk is a sentence quietly
 * disappearing while the code that used to draw it still exists.
 */

const DATA: CertificateData = {
  certificateNumber: "CERT-0001",
  tenantName: "Probe Org",
  envelopeTitle: "Master Services Agreement",
  senderName: "Sender Person",
  senderEmail: "sender@example.invalid",
  finalPdfHash: "a".repeat(64),
  watermarked: false,
  completedAt: "2026-09-09T10:00:00.000Z",
  documents: [{ fileName: "msa.pdf", sha256Hash: "b".repeat(64), pageCount: 3 }],
  recipients: [
    {
      name: "Signer Person",
      email: "signer@example.invalid",
      role: "Signer",
      authMethod: "otp_email",
      completedAt: "2026-09-09T09:59:00.000Z",
    },
  ],
  events: [
    {
      eventType: "envelope_completed",
      actorName: "Signer Person",
      createdAt: "2026-09-09T09:59:00.000Z",
      ipAddress: "198.18.0.1",
    },
  ],
};

describe("certificate honesty", () => {
  let text: string;

  beforeAll(async () => {
    const pdf = await new SignPdfService().generateCertificatePdf(DATA);
    text = renderedText(pdf);
  }, 30_000);

  it("says it is tamper evidence rather than a signature", () => {
    expect(text).toContain("SHA-256 tamper-evidence record");
  });

  it("names the three things it is not, because those are what a reader assumes", () => {
    expect(text).toMatch(/Not a licensed digital signature/);
    expect(text).toMatch(/DSC\/PKI/);
    expect(text).toMatch(/Aadhaar eSign/);
  });

  it("says where identity evidence actually comes from", () => {
    expect(text).toContain("audit trail");
    expect(text).toContain("not by a certificate authority");
  });

  /** A reader who skipped the header lands at the foot; the statement is in both places. */
  it("repeats the statement at the end of the document", () => {
    expect(text).toContain("What this certificate does and does not establish");
    expect(text).toContain("has attested to any");
  });

  it("still carries the evidence it does have", () => {
    expect(text).toContain("CERT-0001");
    expect(text).toContain("a".repeat(64));
    expect(text).toContain("b".repeat(64));
  });
});
