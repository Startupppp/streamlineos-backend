import { Reflector } from "@nestjs/core";
import { NO_TENANT_TRANSACTION } from "../../common/tenant/no-tenant-transaction.decorator";
import { ChatLinkPreviewController } from "./chat-link-preview.controller";

describe("ChatLinkPreviewController", () => {
  const reflector = new Reflector();

  it("opts out of the tenant transaction because it issues no database query", () => {
    const optedOut = reflector.get<boolean | undefined>(
      NO_TENANT_TRANSACTION,
      ChatLinkPreviewController.prototype.preview,
    );

    expect(optedOut).toBe(true);
  });
});
