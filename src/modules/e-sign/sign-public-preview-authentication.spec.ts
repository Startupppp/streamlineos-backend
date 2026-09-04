import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { SignPublicService } from "./sign-public.service";

jest.mock("../../common/tenant/with-public-token");
jest.mock("../../common/tenant/run-in-tenant-transaction");

import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

const ORG = "11111111-1111-4111-8111-111111111111";

/**
 * PRD-C103, "authorization recheck before short-lived download URLs", on the
 * one route where the reader is anonymous.
 *
 * `/sign/public/:token/documents/:id/preview` is `@Public()`. Possession of the
 * signing link was treated as sufficient to mint a 900-second URL for the
 * envelope's source PDF, so a link forwarded, logged by a mail gateway or read
 * out of a browser history handed the document to whoever held it — while every
 * OTHER action on the same session (consent, field values, signing) already
 * required `authenticatedAt`. Only `email_link` recipients auto-authenticate;
 * for `otp_email` and `access_code` the second factor is the whole point, and
 * the preview was the one way past it.
 */
describe("SignPublicService.getDocumentPreview — second factor before the signed URL", () => {
  const getFileUrl = jest.fn().mockResolvedValue("https://signed.example/doc.pdf");

  function build(recipient: Record<string, unknown>, envelope: Record<string, unknown>) {
    jest.mocked(withPublicToken).mockResolvedValue(recipient as never);
    jest
      .mocked(runInTenantTransaction)
      .mockImplementation(async (_db: unknown, fn: unknown) =>
        (fn as (tx: unknown) => Promise<unknown>)({
          query: {
            signEnvelopes: { findFirst: async () => envelope },
            signDocuments: {
              findFirst: async () => ({
                id: 5,
                envelopeId: 1,
                currentFileKey: `${ORG}/esign/5-contract.pdf`,
                fileName: "contract.pdf",
              }),
            },
          },
        }) as never,
      );

    const db = {
      query: {
        signDocuments: {
          findFirst: async () => ({
            id: 5,
            envelopeId: 1,
            currentFileKey: `${ORG}/esign/5-contract.pdf`,
            fileName: "contract.pdf",
          }),
        },
      },
    } as unknown as Db;
    const tokens = { hash: (t: string) => `h:${t}` } as never;
    return new SignPublicService(
      db,
      { getFileUrl } as never,
      {} as never,
      tokens,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  const ENVELOPE = { id: 1, orgId: ORG, status: "sent", title: "T" };
  const BASE_RECIPIENT = {
    id: 9,
    orgId: ORG,
    envelopeId: 1,
    status: "viewed",
    authMethod: "otp_email",
    tokenRevokedAt: null,
    tokenExpiresAt: null,
    signingTokenHash: "h:tok",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getFileUrl.mockResolvedValue("https://signed.example/doc.pdf");
  });

  it("refuses to mint a URL for a recipient who has not passed the second factor", async () => {
    const svc = build({ ...BASE_RECIPIENT, authenticatedAt: null }, ENVELOPE);

    await expect(svc.getDocumentPreview("tok", 5)).rejects.toBeInstanceOf(ForbiddenException);
    expect(getFileUrl).not.toHaveBeenCalled();
  });

  it("refuses even when the envelope is already completed, which is the other reachable state", async () => {
    const svc = build(
      { ...BASE_RECIPIENT, status: "completed", authenticatedAt: null },
      { ...ENVELOPE, status: "completed" },
    );

    await expect(svc.getDocumentPreview("tok", 5)).rejects.toBeInstanceOf(ForbiddenException);
    expect(getFileUrl).not.toHaveBeenCalled();
  });

  it("mints the URL once the recipient has authenticated (control)", async () => {
    const svc = build({ ...BASE_RECIPIENT, authenticatedAt: new Date() }, ENVELOPE);

    const result = await svc.getDocumentPreview("tok", 5);

    expect(result.url).toBe("https://signed.example/doc.pdf");
    expect(getFileUrl).toHaveBeenCalledTimes(1);
  });

  /**
   * `esign/` is a sensitive folder root, so the minting primitive refuses it
   * unless the caller states it ran a record-scoped check. This route has one —
   * the recipient session plus the second factor above — so it must pass the
   * opt-out, and the assertion pins that it does rather than leaving the route
   * silently broken.
   */
  it("passes the preauthorization opt-out, because the e-sign folder is sensitive", async () => {
    const svc = build({ ...BASE_RECIPIENT, authenticatedAt: new Date() }, ENVELOPE);

    await svc.getDocumentPreview("tok", 5);

    expect(getFileUrl).toHaveBeenCalledWith(
      ORG,
      `${ORG}/esign/5-contract.pdf`,
      900,
      undefined,
      { preauthorized: true },
    );
  });
});
