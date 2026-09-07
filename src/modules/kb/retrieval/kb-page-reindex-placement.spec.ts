import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { KbPageIndexingController } from "./kb-page-indexing.controller";

describe("KB reindex handlers opt out of the request transaction", () => {
  it.each([
    ["reindexPage", KbPageIndexingController.prototype.reindexPage],
    ["reindexAllPages", KbPageIndexingController.prototype.reindexAllPages],
  ])("%s carries @NoTenantTransaction", (_name, handler) => {
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, handler)).toBe(true);
  });
});
