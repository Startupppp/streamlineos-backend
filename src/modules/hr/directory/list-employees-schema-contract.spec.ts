import { countEmployeesSchema, listEmployeesSchema } from "./dto/hr-directory.schemas";

/**
 * Contract tests for listEmployeesSchema (GET /hr/employees).
 *
 * Root cause memo: a runtime-verification lane called
 *   GET /hr/employees?status=ACTIVE
 * and received 400 VALIDATION_FAILED because the schema is `.strict()` and has no
 * `status` field.  The frontend never sends `status` — it maps the URL param
 * `status=active|inactive|all` to the API param `isActive=true|false|all` via
 * `toHrEmployeesApiParams()`.  So the failure was a direct-API-call mistake, not
 * a broken page.  These tests pin that mapping so a future schema change that
 * removes `isActive`, or a hook change that starts sending `status`, fails loudly.
 */
describe("listEmployeesSchema contract", () => {
  describe("defaults", () => {
    it("applies active-only default when isActive is omitted", () => {
      const result = listEmployeesSchema.parse({});
      expect(result.isActive).toBe("true");
    });

    it("applies the configured default page size", () => {
      const result = listEmployeesSchema.parse({});
      expect(result.limit).toBe(20);
    });
  });

  describe("accepted keys — every param the frontend HrEmployeesParams can send", () => {
    it("accepts cursor", () => {
      expect(() =>
        listEmployeesSchema.parse({ cursor: "opaque-cursor-value" }),
      ).not.toThrow();
    });

    it("accepts limit as a numeric string (query params arrive as strings)", () => {
      const result = listEmployeesSchema.parse({ limit: "50" });
      expect(result.limit).toBe(50);
    });

    it("accepts search", () => {
      expect(() =>
        listEmployeesSchema.parse({ search: "Alice" }),
      ).not.toThrow();
    });

    it("accepts departmentId", () => {
      expect(() =>
        listEmployeesSchema.parse({ departmentId: "dept-abc" }),
      ).not.toThrow();
    });

    it("accepts isActive=true", () => {
      expect(listEmployeesSchema.parse({ isActive: "true" }).isActive).toBe("true");
    });

    it("accepts isActive=false", () => {
      expect(listEmployeesSchema.parse({ isActive: "false" }).isActive).toBe("false");
    });

    it("accepts isActive=all", () => {
      expect(listEmployeesSchema.parse({ isActive: "all" }).isActive).toBe("all");
    });

    it("accepts role", () => {
      expect(() =>
        listEmployeesSchema.parse({ role: "ENGINEERING" }),
      ).not.toThrow();
    });

    it("accepts the full frontend param set together", () => {
      expect(() =>
        listEmployeesSchema.parse({
          cursor: "c1",
          limit: "20",
          search: "Bob",
          departmentId: "dept-1",
          isActive: "false",
          role: "HR",
        }),
      ).not.toThrow();
    });
  });

  describe("rejected keys — schema is .strict()", () => {
    it("rejects status=ACTIVE (wrong param name — must be isActive with lowercase enum)", () => {
      expect(() =>
        listEmployeesSchema.parse({ status: "ACTIVE" }),
      ).toThrow();
    });

    it("rejects status=active (lowercase variant of wrong param name)", () => {
      expect(() =>
        listEmployeesSchema.parse({ status: "active" }),
      ).toThrow();
    });

    it("rejects isActive=ACTIVE (enum value must be lowercase true|false|all)", () => {
      expect(() =>
        listEmployeesSchema.parse({ isActive: "ACTIVE" }),
      ).toThrow();
    });

    it("rejects organizationId (cross-tenant injection attempt)", () => {
      expect(() =>
        listEmployeesSchema.parse({ organizationId: "other-org" }),
      ).toThrow();
    });

    it("rejects any other unrecognized field", () => {
      expect(() =>
        listEmployeesSchema.parse({ unknownField: "value" }),
      ).toThrow();
    });
  });
});

describe("countEmployeesSchema contract (GET /hr/employees/counts)", () => {
  it("accepts exactly the list's filter params so the summary can only be narrowed the way the list is", () => {
    expect(
      countEmployeesSchema.parse({
        search: "ada",
        q: "ada",
        departmentId: "dept-1",
        role: "ENGINEERING",
      }),
    ).toEqual({ search: "ada", q: "ada", departmentId: "dept-1", role: "ENGINEERING" });
  });

  it("rejects the status axis — the count splits active/inactive itself, so a status param would double-filter", () => {
    expect(() => countEmployeesSchema.parse({ isActive: "true" })).toThrow();
  });

  it("rejects pagination params — a count has no page", () => {
    expect(() => countEmployeesSchema.parse({ cursor: "abc" })).toThrow();
    expect(() => countEmployeesSchema.parse({ limit: "20" })).toThrow();
  });

  it("rejects organizationId (cross-tenant injection attempt)", () => {
    expect(() => countEmployeesSchema.parse({ organizationId: "other-org" })).toThrow();
  });
});
