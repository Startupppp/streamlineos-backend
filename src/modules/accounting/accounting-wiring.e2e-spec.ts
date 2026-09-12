/**
 * Boot proof for the accounting module.
 *
 * Typecheck cannot see a dependency-injection mistake — a service provided in
 * one module while its own dependency lives in another compiles perfectly and
 * fails at runtime. backend/CLAUDE.md §8 is explicit that mocked tests are not
 * proof a feature works, so this actually constructs the Nest application and
 * asserts every accounting service resolves and every route is mounted.
 */
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../../app.module";
import { AccountingRootModule } from "./accounting.module";
import { LedgerService } from "./kernel/ledger.service";
import { BooksService } from "./kernel/books.service";
import { AccountsService } from "./kernel/accounts.service";
import { PeriodsService } from "./kernel/periods.service";
import { FxService } from "./kernel/fx.service";
import { SequenceService } from "./kernel/sequence.service";
import { PackRegistry } from "./packs/pack.registry";
import { TaxService } from "./tax/tax.service";
import { TaxEngineRegistry } from "./tax/tax-engine.registry";
import { AccountingSetupService } from "./setup/accounting-setup.service";
import { ComplianceService } from "./compliance/compliance.service";
import { PostingCommandService } from "./adapters/posting-command.service";

let app: INestApplication;

beforeAll(async () => {
  process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe("accounting module wiring", () => {
  it("boots the application with accounting registered", () => {
    expect(app).toBeDefined();
    expect(app.get(AccountingRootModule)).toBeDefined();
  });

  it("resolves every kernel service", () => {
    expect(app.get(LedgerService)).toBeInstanceOf(LedgerService);
    expect(app.get(BooksService)).toBeInstanceOf(BooksService);
    expect(app.get(AccountsService)).toBeInstanceOf(AccountsService);
    expect(app.get(PeriodsService)).toBeInstanceOf(PeriodsService);
    expect(app.get(FxService)).toBeInstanceOf(FxService);
    expect(app.get(SequenceService)).toBeInstanceOf(SequenceService);
  });

  it("resolves the tax engine and its packs", () => {
    const registry = app.get(TaxEngineRegistry);
    expect(app.get(TaxService)).toBeInstanceOf(TaxService);

    const packs = Object.fromEntries(registry.list().map((e) => [e.pack, e.status]));
    expect(packs.IN).toBe("enabled");
    expect(packs.GENERIC_VAT).toBe("enabled");
    expect(packs.US).toBe("stub");
  });

  it("resolves the localization pack registry with India enabled", () => {
    const packs = app.get(PackRegistry);
    expect(packs.get("IN").status).toBe("enabled");
    // Portugal is listed by the EU pack, so it resolves there rather than to
    // the generic fallback.
    expect(packs.forCountry("PT").code).toBe("EU");
    // A country no pack claims still gets usable books via generic VAT, which
    // is what stops accounting being India-only.
    expect(packs.forCountry("BR").code).toBe("GENERIC_VAT");
  });

  it("resolves setup, compliance and the anti-corruption layer", () => {
    expect(app.get(AccountingSetupService)).toBeInstanceOf(AccountingSetupService);
    expect(app.get(ComplianceService)).toBeInstanceOf(ComplianceService);
    expect(app.get(PostingCommandService)).toBeInstanceOf(PostingCommandService);
  });

  it("mounts the accounting HTTP surface", () => {
    const server = app.getHttpAdapter().getInstance();
    const stack = server._router?.stack ?? server.router?.stack ?? [];
    const routes: string[] = stack
      .filter((layer: { route?: { path?: string; methods?: Record<string, boolean> } }) => layer.route)
      .map((layer: { route: { path: string; methods: Record<string, boolean> } }) => {
        const method = Object.keys(layer.route.methods)[0]?.toUpperCase() ?? "GET";
        return `${method} ${layer.route.path}`;
      })
      .filter((route: string) => route.includes("accounting"));

    // Printed so a reviewer can see the real surface rather than trust a count.
     
    console.log(`\naccounting routes mounted: ${routes.length}\n${routes.sort().join("\n")}\n`);

    expect(routes.length).toBeGreaterThan(20);

    // The kernel's own surface must be present, whatever else moved.
    const joined = routes.join(" ");
    expect(joined).toContain("accounting/setup/enable");
    expect(joined).toContain("accounting/journals/post");
    expect(joined).toContain("accounting/accounts");
    expect(joined).toContain("accounting/periods");
    expect(joined).toContain("accounting/trial-balance");
  });
});
