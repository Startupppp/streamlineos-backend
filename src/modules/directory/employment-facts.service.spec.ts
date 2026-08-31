import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { EmploymentFactsService } from "./employment-facts.service";
import type { Db } from "../../db/drizzle.module";
import { sealSensitive } from "../../common/security/sensitive-field";
import { sealBankDetails } from "../../common/hr/canonical-bank-details";

const ORG = "11111111-1111-4111-8111-111111111111";
const dialect = new PgDialect();

function render(condition: unknown): string {
  return dialect.sqlToQuery(condition as SQL).sql;
}

class QueryRecorder {
  readonly joins: unknown[] = [];
  readonly filters: unknown[] = [];
  ordered = false;

  constructor(private readonly rows: unknown[]) {}

  select(): this {
    return this;
  }
  selectDistinct(): this {
    return this;
  }
  from(): this {
    return this;
  }
  leftJoin(_table: unknown, condition: unknown): this {
    this.joins.push(condition);
    return this;
  }
  innerJoin(_table: unknown, condition: unknown): this {
    this.joins.push(condition);
    return this;
  }
  where(condition: unknown): this {
    this.filters.push(condition);
    return this;
  }
  orderBy(): this {
    this.ordered = true;
    return this;
  }
  then(resolve: (rows: unknown[]) => unknown): unknown {
    return resolve(this.rows);
  }

  allSql(): string {
    return [...this.joins, ...this.filters].map(render).join(" ");
  }
}

function serviceOver(rows: unknown[]): {
  service: EmploymentFactsService;
  recorder: QueryRecorder;
} {
  const recorder = new QueryRecorder(rows);
  return {
    service: new EmploymentFactsService(recorder as unknown as Db),
    recorder,
  };
}

describe("EmploymentFactsService", () => {
  const previousKey = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "employment-facts-service-spec-key";
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousKey;
  });

  describe("query shape", () => {
    it("excludes a soft-deleted manager from the resolved reporting line", async () => {
      const { service, recorder } = serviceOver([]);
      await service.getFactsBatch(ORG, ["u1"]);
      const sql = recorder.allSql();

      expect(sql).toContain('"employment_facts_manager_employment"."deleted_at" is null');
      expect(sql).toContain('"employment_facts_manager_person"."deleted_at" is null');
    });

    it("excludes a soft-deleted manager when listing direct reports", async () => {
      const { service, recorder } = serviceOver([]);
      await service.getDirectReportUserIds(ORG, "manager-1");
      const sql = recorder.allSql();

      expect(sql).toContain('"employment_facts_manager_employment"."deleted_at" is null');
      expect(sql).toContain('"employment_facts_manager_person"."deleted_at" is null');
    });

    it("bounds the reporting line on both sides so a future-dated line is not current yet", async () => {
      const { service, recorder } = serviceOver([]);
      await service.getFactsBatch(ORG, ["u1"]);
      const sql = recorder.allSql();

      expect(sql).toContain('"effective_from" <= CURRENT_DATE');
      expect(sql).toContain('"effective_to" >= CURRENT_DATE');
    });

    it("bounds the reporting line on both sides when listing direct reports", async () => {
      const { service, recorder } = serviceOver([]);
      await service.getDirectReportUserIds(ORG, "manager-1");
      const sql = recorder.allSql();

      expect(sql).toContain('"effective_from" <= CURRENT_DATE');
      expect(sql).toContain('"effective_to" >= CURRENT_DATE');
    });

    it("scopes every join and filter to the requested organization", async () => {
      const { service, recorder } = serviceOver([]);
      await service.getFactsBatch(ORG, ["u1"]);

      const orgPredicates = [...recorder.joins, ...recorder.filters]
        .map(render)
        .filter((sql) => sql.includes('"org_id" = $'));
      expect(orgPredicates.length).toBeGreaterThanOrEqual(5);
    });

    it("orders by employment id so a duplicate primary employment resolves deterministically", async () => {
      const { service, recorder } = serviceOver([]);
      await service.getFactsBatch(ORG, ["u1"]);
      expect(recorder.ordered).toBe(true);
    });
  });

  describe("resolution", () => {
    it("issues no query for an empty batch", async () => {
      const { service, recorder } = serviceOver([]);
      const facts = await service.getFactsBatch(ORG, []);

      expect(facts.size).toBe(0);
      expect(recorder.joins).toHaveLength(0);
      expect(recorder.filters).toHaveLength(0);
    });

    it("returns empty facts rather than omitting a user with no employment row", async () => {
      const { service } = serviceOver([]);
      const facts = await service.getFactsBatch(ORG, ["absent"]);

      expect(facts.has("absent")).toBe(true);
      expect(facts.get("absent")?.employmentId).toBeNull();
      expect(facts.get("absent")?.designation).toBeNull();
    });

    it("never carries salary, bank details or tax identifiers on the non-sensitive shape", async () => {
      const { service } = serviceOver([
        {
          userId: "u1",
          employmentId: 7,
          employeeNumber: "E-7",
          designation: "Engineer",
          joiningDate: "2026-01-01",
          departmentId: null,
          locationId: null,
          managerUserId: null,
        },
      ]);
      const facts = await service.getFactsBatch(ORG, ["u1"]);

      expect(Object.keys(facts.get("u1") ?? {})).toEqual(
        expect.not.arrayContaining(["salaryAmountCents", "bankDetails", "taxId", "panNumber"]),
      );
    });

    it("decrypts the tax identifier and the PAN a statutory filing depends on", async () => {
      const { service } = serviceOver([
        {
          userId: "u1",
          employmentId: 7,
          salaryAmountCents: 500_000,
          bankDetails: sealBankDetails({
            accountNumber: "000123456789",
            bankName: "HDFC Bank",
            branch: "Indiranagar",
            ifsc: "HDFC0001234",
            accountHolder: "Test Payee",
          }),
          taxId: sealSensitive("ABCDE1234F"),
          panNumber: sealSensitive("ZZZZZ9999Z"),
        },
      ]);
      const facts = await service.getSensitiveFactsBatch(ORG, ["u1"]);

      expect(facts.get("u1")?.taxId).toBe("ABCDE1234F");
      expect(facts.get("u1")?.panNumber).toBe("ZZZZZ9999Z");
      expect(facts.get("u1")?.bankDetails?.accountNumber).toBe("000123456789");
    });

    it("fills a user with no sensitive row with nulls, including the PAN", async () => {
      const { service } = serviceOver([]);
      const facts = await service.getSensitiveFactsBatch(ORG, ["absent"]);

      expect(facts.get("absent")).toEqual({
        userId: "absent",
        employmentId: null,
        salaryAmountCents: null,
        bankDetails: null,
        taxId: null,
        panNumber: null,
      });
    });

    it("resolves a payee who has no login account by organization person id", async () => {
      const { service } = serviceOver([
        {
          organizationPersonId: "person-1",
          userId: null,
          employmentId: 9,
          salaryAmountCents: 250_000,
          bankDetails: sealBankDetails({
            accountNumber: "999888777666",
            bankName: "ICICI Bank",
            branch: "Koramangala",
            ifsc: "ICIC0004321",
            accountHolder: "Worker Payee",
          }),
          taxId: null,
          panNumber: null,
        },
      ]);
      const facts = await service.getSensitiveFactsByPersonBatch(ORG, ["person-1"]);

      expect(facts.get("person-1")?.bankDetails?.accountNumber).toBe("999888777666");
    });

    it("refuses to return a bank record it cannot decrypt", async () => {
      const { service } = serviceOver([
        {
          userId: "u1",
          employmentId: 7,
          salaryAmountCents: null,
          bankDetails: "not-ciphertext-at-all",
          taxId: null,
          panNumber: null,
        },
      ]);

      await expect(service.getSensitiveFactsBatch(ORG, ["u1"])).rejects.toThrow();
    });
  });
});
