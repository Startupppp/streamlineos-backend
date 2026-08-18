import { hrDocumentTags } from "../../../db/schema/hr/document-tags";
import { syncDocumentTags } from "./document-tag-compat";

describe("syncDocumentTags", () => {
  it("mirrors unique nonblank tags in caller order on the supplied transaction", async () => {
    const insertedValues = jest.fn().mockResolvedValue(undefined);
    const deleteWhere = jest.fn().mockResolvedValue(undefined);
    const transaction = {
      execute: jest.fn().mockResolvedValue([{ relationAvailable: true }]),
      delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      insert: jest.fn().mockReturnValue({ values: insertedValues }),
    };

    await syncDocumentTags(
      transaction as never,
      "org-1",
      41,
      ["tax", "", "tax", "approved"],
    );

    expect(transaction.delete).toHaveBeenCalledWith(hrDocumentTags);
    expect(insertedValues).toHaveBeenCalledWith([
      { organizationId: "org-1", documentId: 41, tag: "tax", sortOrder: 0 },
      {
        organizationId: "org-1",
        documentId: 41,
        tag: "approved",
        sortOrder: 3,
      },
    ]);
  });

  it("leaves the legacy write alone before the additive table exists", async () => {
    const transaction = {
      execute: jest.fn().mockResolvedValue([{ relationAvailable: false }]),
      delete: jest.fn(),
      insert: jest.fn(),
    };

    await syncDocumentTags(transaction as never, "org-1", 41, ["tax"]);

    expect(transaction.delete).not.toHaveBeenCalled();
    expect(transaction.insert).not.toHaveBeenCalled();
  });
});
