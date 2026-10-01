import "reflect-metadata";
import { PATH_METADATA } from "@nestjs/common/constants";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { REQUIRE_PERMISSION } from "../../../common/rbac/require-permission-key";
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from "../../rbac/permissions";
import { DB_ENUMS } from "../../../db/enums.generated";
import { listComplianceResponseSchema } from "./dto/documents-response.schemas";
import { DocumentsController } from "./documents.controller";
import { SelfDocumentAcknowledgementsController } from "./self-document-acknowledgements.controller";

const SELF_DOCUMENT_ACK_PERMISSION = "self:document-acknowledgements";

const prototype = SelfDocumentAcknowledgementsController.prototype;

describe("HRMS-BE-001 an employee can acknowledge their own documents", () => {
  it("is mounted where an employee looks for their own records, not under the HR admin tree", () => {
    expect(Reflect.getMetadata(PATH_METADATA, SelfDocumentAcknowledgementsController)).toBe(
      "me/document-acknowledgements",
    );
  });

  it("gates both verbs on the self key, so a plain member is not refused by an HR admin key", () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, prototype.list)).toBe(
      SELF_DOCUMENT_ACK_PERMISSION,
    );
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, prototype.acknowledge)).toBe(
      SELF_DOCUMENT_ACK_PERMISSION,
    );
  });

  it("names a key the catalog actually defines, because a key absent from it can never resolve", () => {
    expect(PERMISSIONS.map((permission) => permission.name)).toContain(
      SELF_DOCUMENT_ACK_PERMISSION,
    );
  });

  it("grants that key to MEMBER, so the obligation reaches the person who carries it", () => {
    expect(ROLE_DEFAULT_PERMISSIONS["MEMBER"]).toContain(SELF_DOCUMENT_ACK_PERMISSION);
  });

  it("carries no plan-gated module requirement, so self-service survives HR being switched off", () => {
    expect(
      Reflect.getMetadata(REQUIRE_MODULE, SelfDocumentAcknowledgementsController),
    ).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_MODULE, prototype.list)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_MODULE, prototype.acknowledge)).toBeUndefined();
  });

  it("is a different controller from the HR-wide one, which is still module-gated and still admin-keyed", () => {
    expect(Reflect.getMetadata(REQUIRE_MODULE, DocumentsController)).toBe("hr");
    expect(SelfDocumentAcknowledgementsController).not.toBe(DocumentsController);
  });
});

describe("the acknowledgement list can carry every status the column permits", () => {
  it("accepts DECLINED, which the write schema has always allowed and the read schema used to reject", () => {
    const parsed = listComplianceResponseSchema.safeParse([
      {
        id: 1,
        orgId: "org_1",
        documentId: 7,
        userId: "user_1",
        userMembershipId: 3,
        status: "DECLINED",
        acknowledgedAt: new Date("2026-10-01T04:30:00.000Z"),
        ipAddress: null,
        createdAt: new Date("2026-09-30T04:30:00.000Z"),
        document: null,
        user: { id: "user_1", name: "Ravi Kumar" },
      },
    ]);

    expect(parsed.success).toBe(true);
  });

  it("covers the ack_status column exactly, so neither side can drift again", () => {
    const contractStatuses = [...listComplianceResponseSchema.element.shape.status.options].sort();

    expect(contractStatuses).toEqual([...DB_ENUMS.ack_status].sort());
  });
});
