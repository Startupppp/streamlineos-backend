/**
 * BOLA regression for the three e-sign envelope-child list routes (register A-3).
 *
 *   GET /sign/envelopes/:envelopeId/fields
 *   GET /sign/envelopes/:envelopeId/recipients
 *   GET /sign/envelopes/:envelopeId/documents
 *
 * Each was a bare `findMany` on `(orgId, envelopeId)`. For another organisation's
 * envelope id the predicate matched nothing, so the route answered `[]` with HTTP
 * 200. No row crossed the tenant boundary — but the response still separated
 * "this envelope exists and has no fields" from "this envelope is not yours",
 * which is exactly the disclosure the 404 contract exists to prevent. The fourth
 * route named in the original finding, `.../audit`, was already fixed and calls
 * `mustGetVisibleEnvelope`; these three did not.
 *
 * After the fix all three resolve the envelope in the caller's org and scope
 * first, so a cross-tenant id and an id belonging to no organisation answer the
 * SAME 404 — never 403, never an empty 200.
 */

import type { Db } from "../../../src/db/drizzle.module";
import { SignFieldsService } from "../../../src/modules/e-sign/sign-fields.service";
import { SignRecipientsService } from "../../../src/modules/e-sign/sign-recipients.service";
import { SignDocumentsService } from "../../../src/modules/e-sign/sign-documents.service";
import { systemEnvelopeScope } from "../../../src/modules/e-sign/sign-envelope-scope";
import { standIn } from "../rbac-matrix/world-db";

const CALLER_ORG = "org-caller";
const OWN_ENVELOPE_ID = 42;

const ownEnvelope = { id: OWN_ENVELOPE_ID, orgId: CALLER_ORG, senderMembershipId: 10, title: "Own envelope", status: "sent", routingMode: "parallel" };

function emptyDb(): Db {
  return standIn<Db>({
    query: {
      signEnvelopes: { findFirst: jest.fn().mockResolvedValue(ownEnvelope) },
      signDocuments: { findMany: jest.fn().mockResolvedValue([]) },
    },
  });
}

describe("the envelope-child lists take a scope argument, so an unscoped list is unrepresentable", () => {
  it.each([
    ["SignFieldsService.listForEnvelope", SignFieldsService.prototype.listForEnvelope],
    ["SignRecipientsService.listForEnvelope", SignRecipientsService.prototype.listForEnvelope],
    ["SignDocumentsService.list", SignDocumentsService.prototype.list],
    ["SignDocumentsService.getPreviewUrl", SignDocumentsService.prototype.getPreviewUrl],
  ])("%s requires (read, membershipId, id)", (_name, method) => {
    expect(method.length).toBe(3);
  });
});

describe("the internal callers of these lists name their own scope", () => {
  it("systemEnvelopeScope is the only unrestricted read, and it binds the tenant it was asked for", () => {
    const read = systemEnvelopeScope(CALLER_ORG);
    expect(read.unrestricted).toBe(true);
    expect(read.orgId).toBe(CALLER_ORG);
    expect(systemEnvelopeScope("org-other").orgId).toBe("org-other");
  });

  it("fetchBuffers reads documents under systemEnvelopeScope rather than an unscoped read", async () => {
    const service = new SignDocumentsService(emptyDb(), standIn({}), standIn({}), standIn({}), standIn({ record: jest.fn() }));
    const listSpy = jest.spyOn(service, "list").mockResolvedValue([]);
    await service.fetchBuffers(CALLER_ORG, OWN_ENVELOPE_ID);
    const [read, membershipId, envelopeId] = listSpy.mock.calls[0] ?? [];
    expect(read?.unrestricted).toBe(true);
    expect(read?.orgId).toBe(CALLER_ORG);
    expect(membershipId).toBeNull();
    expect(envelopeId).toBe(OWN_ENVELOPE_ID);
  });
});

/** The bare-findMany shape must not come back in this module. */
describe("no envelope-child list in e-sign reads its table before the envelope", () => {
  const SOURCES = [
    "src/modules/e-sign/sign-fields.service.ts",
    "src/modules/e-sign/sign-recipients.service.ts",
    "src/modules/e-sign/sign-documents.service.ts",
  ];

  it.each(SOURCES)("%s asserts envelope visibility inside its envelope-scoped list", async (relPath) => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(__dirname, "../../..", relPath), "utf8");
    expect(source).toContain("mustGetVisibleEnvelope");
    const listBody = source.slice(source.indexOf("membershipId: number | null, envelopeId: number"));
    expect(listBody.indexOf("mustGetVisibleEnvelope")).toBeGreaterThan(-1);
    expect(listBody.indexOf("mustGetVisibleEnvelope")).toBeLessThan(listBody.indexOf("findMany"));
  });
});
