import "reflect-metadata";
import { listAccessRequestsQuerySchema } from "./hr-directory.schemas";
import {
  VALIDATION_SCHEMAS,
  type ValidationSchemas,
} from "../../../../common/validation/validate.decorator";
import { AccessRequestsController } from "../access-requests.controller";

describe("listAccessRequestsQuerySchema", () => {
  it("accepts an omitted employeeId, which is the org-wide list the endpoint already served", () => {
    expect(listAccessRequestsQuerySchema.parse({})).toEqual({});
  });

  it("accepts a supplied employeeId and passes it through unchanged", () => {
    expect(listAccessRequestsQuerySchema.parse({ employeeId: "emp-1" })).toEqual({
      employeeId: "emp-1",
    });
  });

  it("rejects an empty employeeId rather than silently widening to the whole org", () => {
    expect(() => listAccessRequestsQuerySchema.parse({ employeeId: "" })).toThrow();
  });

  it("rejects an over-long employeeId", () => {
    expect(() =>
      listAccessRequestsQuerySchema.parse({ employeeId: "e".repeat(129) }),
    ).toThrow();
  });

  it("rejects a non-string employeeId, so an array param cannot reach the where clause", () => {
    expect(() =>
      listAccessRequestsQuerySchema.parse({ employeeId: ["a", "b"] }),
    ).toThrow();
  });

  it("rejects unknown query keys, so orgId cannot be smuggled past the token-derived tenant", () => {
    expect(() =>
      listAccessRequestsQuerySchema.parse({ employeeId: "emp-1", orgId: "other-org" }),
    ).toThrow();
  });
});

describe("AccessRequestsController query contract", () => {
  it("wires listAccessRequestsQuerySchema onto the list handler, so employeeId is validated at the boundary", () => {
    const schemas = Reflect.getMetadata(
      VALIDATION_SCHEMAS,
      AccessRequestsController.prototype.list,
    ) as ValidationSchemas | undefined;

    expect(schemas?.query).toBe(listAccessRequestsQuerySchema);
  });
});
