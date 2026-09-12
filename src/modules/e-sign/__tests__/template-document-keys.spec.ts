import { BadRequestException } from "@nestjs/common";
import { SignTemplatesService } from "../sign-templates.service";
import { assertSnapshotDocumentsOwned, isSignDocumentKeyOf } from "../lib/template-document-keys";
import { parseTemplateSnapshot } from "../sign-template-snapshot";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

const ownKey = `${ORG}/signos/${ORG}/42/abc-offer.pdf`;
const regionPrefixedOwnKey = `eu/${ORG}/signos/${ORG}/42/abc-offer.pdf`;
const foreignKey = `${OTHER_ORG}/signos/${OTHER_ORG}/7/abc-offer.pdf`;
const ownHrKey = `${ORG}/hr-documents/${ORG}/payslip.pdf`;
const legacyKey = "documents/anything.pdf";

function templateJsonWith(fileKey: string): Record<string, unknown> {
  return {
    documents: [{ fileKey, fileName: "offer.pdf", mimeType: "application/pdf", fileSize: 10, sha256Hash: "x", orderIndex: 0 }],
  };
}

function snapshotWith(fileKey: string) {
  return parseTemplateSnapshot(templateJsonWith(fileKey));
}

describe("a template may only point at this organisation's own SignOS uploads", () => {
  it("accepts a key SignDocumentsService minted, with or without a region prefix", () => {
    expect(isSignDocumentKeyOf(ORG, ownKey)).toBe(true);
    expect(isSignDocumentKeyOf(ORG, regionPrefixedOwnKey)).toBe(true);
    expect(() => assertSnapshotDocumentsOwned(ORG, snapshotWith(ownKey))).not.toThrow();
  });

  it("refuses another tenant's key", () => {
    expect(isSignDocumentKeyOf(ORG, foreignKey)).toBe(false);
    expect(() => assertSnapshotDocumentsOwned(ORG, snapshotWith(foreignKey))).toThrow(BadRequestException);
  });

  it("refuses this tenant's key from any folder that is not signos", () => {
    expect(isSignDocumentKeyOf(ORG, ownHrKey)).toBe(false);
    expect(() => assertSnapshotDocumentsOwned(ORG, snapshotWith(ownHrKey))).toThrow(BadRequestException);
  });

  it("refuses a legacy key that names no organisation, and a malformed one", () => {
    expect(isSignDocumentKeyOf(ORG, legacyKey)).toBe(false);
    expect(isSignDocumentKeyOf(ORG, `${ORG}/signos/../${OTHER_ORG}/x.pdf`)).toBe(false);
    expect(isSignDocumentKeyOf(ORG, "")).toBe(false);
  });

  it("is indifferent to a template with no documents", () => {
    expect(() => assertSnapshotDocumentsOwned(ORG, parseTemplateSnapshot({}))).not.toThrow();
  });
});

describe("SignTemplatesService refuses a foreign document key before touching the database", () => {
  function build() {
    const insert = jest.fn();
    const update = jest.fn();
    const templateRow = {
      id: 5,
      orgId: ORG,
      name: "t",
      status: "draft",
      templateJson: templateJsonWith(foreignKey),
    };
    const db = {
      insert,
      update,
      query: { signTemplates: { findFirst: jest.fn().mockResolvedValue(templateRow) } },
    };
    const service = new SignTemplatesService(
      db as never,
      { record: jest.fn() } as never,
      {} as never,
      { assertWithinLimit: jest.fn() } as never,
      { getOrCreate: jest.fn() } as never,
      { assertUsable: jest.fn() } as never,
    );
    return { service, insert, update };
  }

  it("on create", async () => {
    const { service, insert } = build();
    await expect(
      service.create(ORG, null, { name: "t", templateJson: templateJsonWith(foreignKey) }),
    ).rejects.toThrow(BadRequestException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("on an update that replaces the snapshot", async () => {
    const { service, update } = build();
    await expect(
      service.update(ORG, 5, { templateJson: templateJsonWith(ownHrKey) }, { orgId: ORG, userId: "u" }),
    ).rejects.toThrow(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("at instantiate, for a template written before the check existed", async () => {
    const { service, insert } = build();
    await expect(
      service.instantiate(ORG, null, 5, { recipients: [] }),
    ).rejects.toThrow(BadRequestException);
    expect(insert).not.toHaveBeenCalled();
  });
});
