/**
 * A `@Version` route must not be a blind spot in the body/query BOLA sweep.
 *
 * Nest suffixes the operationId of a versioned handler with `_v<n>`, so
 * `UsersController.listUsersV2` is emitted as `UsersController_listUsersV2_v2`.
 * The analyser indexed routes as `<ControllerClass>_<handler>` and looked the
 * operationId up directly, so every versioned route missed, was recorded
 * `handler-not-found`, and its id-shaped body and query fields never received a
 * verdict. `GET /v2/users` reached the contract carrying four of them —
 * `departmentId`, `branchId`, `teamId`, `managerUserId` — and none was analysed.
 *
 * The assertion is over the WHOLE contract, not the one route that exposed it:
 * any future `@Version` handler is covered by the same statement.
 */

import { analyzeIdFields, type FieldBinding } from "./body-id-binding";

const VERSION_SUFFIX = /_v\d+$/;

let bindings: FieldBinding[];

beforeAll(() => {
  bindings = analyzeIdFields();
});

describe("versioned operationIds resolve to their handler", () => {
  it("ANTI-VACUITY: the contract really does carry version-suffixed operationIds with id-shaped fields", () => {
    const versioned = bindings.filter((binding) =>
      VERSION_SUFFIX.test(binding.operationId),
    );
    expect(versioned.length).toBeGreaterThan(0);
  });

  it("leaves no version-suffixed operation unanalysed", () => {
    const unresolved = bindings
      .filter(
        (binding) =>
          VERSION_SUFFIX.test(binding.operationId) &&
          binding.verdict === "handler-not-found",
      )
      .map((binding) => `${binding.operationId}|${binding.field}`);

    expect(unresolved).toEqual([]);
  });

  it("gives the versioned users read the same verdicts as an analysed route, not a blind spot", () => {
    const usersV2 = bindings.filter(
      (binding) => binding.operationId === "UsersController_listUsersV2_v2",
    );

    expect(usersV2.map((binding) => binding.field).sort()).toEqual([
      "branchId",
      "departmentId",
      "managerUserId",
      "teamId",
    ]);
    for (const binding of usersV2)
      expect(binding.verdict).not.toBe("handler-not-found");
  });
});
