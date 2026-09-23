import "reflect-metadata";
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { IDEMPOTENCY_COMMAND } from "../../common/idempotency/idempotency.constants";
import { REQUIRE_PERMISSION } from "../../common/rbac/require-permission-key";
import { RESPONSE_SCHEMA } from "../../common/openapi/zod-operation-contracts";
import { FeedbucketController } from "./feedbucket.controller";
import { feedbucketBulkSubmissionsSchema } from "./dto/feedbucket-response.schemas";

const handler = FeedbucketController.prototype.bulkUpdateSubmissions;

function meta<T>(key: string): T | undefined {
  return Reflect.getMetadata(key, handler) as T | undefined;
}

describe("POST feedbucket/submissions/bulk — route contract", () => {
  it("is a POST so the bounded id list travels in the body and not in a URL", () => {
    expect(meta<number>(METHOD_METADATA)).toBe(RequestMethod.POST);
  });

  it("is mounted at submissions/bulk, which no :submissionId route can shadow", () => {
    expect(meta<string>(PATH_METADATA)).toBe("submissions/bulk");
  });

  it("answers 200 rather than 201 because a bulk mutation creates nothing", () => {
    expect(meta<number>(HTTP_CODE_METADATA)).toBe(200);
  });

  it("carries an idempotency command so a retried bulk replays instead of applying twice", () => {
    expect(meta<string>(IDEMPOTENCY_COMMAND)).toBe("feedbucket.submissions.bulk-update");
  });

  it("declares feedbucket:submissions:update, a key that already exists in the catalog", () => {
    expect(meta<string>(REQUIRE_PERMISSION)).toBe("feedbucket:submissions:update");
  });

  it("declares the per-item bulk response schema so partial outcomes are part of the contract", () => {
    expect(meta<unknown>(RESPONSE_SCHEMA)).toBe(feedbucketBulkSubmissionsSchema);
  });

  it("keeps the single-submission update route on the same permission key, so bulk is not a privilege shortcut", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, FeedbucketController.prototype.updateSubmission),
    ).toBe("feedbucket:submissions:update");
  });
});

describe("GET feedbucket/submissions — list route contract", () => {
  it("still declares the view key so the cursor cutover did not change who may read the list", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, FeedbucketController.prototype.listSubmissions),
    ).toBe("feedbucket:submissions:view");
  });

  it("carries no idempotency command, because a read is not a command", () => {
    expect(
      Reflect.getMetadata(IDEMPOTENCY_COMMAND, FeedbucketController.prototype.listSubmissions),
    ).toBeUndefined();
  });
});
