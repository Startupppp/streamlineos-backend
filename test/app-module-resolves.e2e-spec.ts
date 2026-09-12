import { Test } from "@nestjs/testing";
import { AppModule } from "src/app.module";

/**
 * The application's dependency graph resolves.
 *
 * This exists because it did not, and nothing noticed.
 *
 * `CrmMcpModule` shipped injecting `PartyService` from a `PartyModule` that
 * provided it without exporting it. Nest cannot satisfy that, so `AppModule`
 * failed to instantiate — not the MCP route, the entire application — from the
 * commit that added it until the commit that added this file. Every unit spec in
 * the repository stayed green throughout, because each one builds its own tiny
 * testing module with the two or three providers it needs and never asks whether
 * the real graph closes.
 *
 * The seeded e2e suite would have caught it, and does. But it needs a live
 * database, an `APP_DATABASE_URL` pointing at a non-owner role, and a schema in
 * step with the branch — so it is the suite most likely not to have been run on
 * the branch where the wiring changed. A DI break should not need any of that to
 * be found.
 *
 * `compile()` and not `init()`, deliberately. Compiling resolves every provider,
 * which is the whole failure class this guards; `init()` would additionally run
 * `onModuleInit` across the graph — registering workflows, opening connections,
 * reading migrations — and turn a fast structural check into an integration test
 * that needs the very infrastructure this is meant to work without. The
 * `postgres` client is lazy, so a connection string that merely parses is
 * enough and none is opened here.
 */
describe("AppModule", () => {
  /** Booting the whole graph is slower than a unit spec, and far faster than e2e. */
  jest.setTimeout(120_000);

  const REQUIRED_FOR_COMPILE: Readonly<Record<string, string>> = {
    // Never connected to — see the docblock. Present so config validation and
    // the pool factory have something well-formed to read.
    DATABASE_URL: "postgres://app:app@127.0.0.1:5432/app_module_resolves",
    BACKEND_JWT_SECRET: "app-module-resolves-secret-not-used-for-signing",
    NODE_ENV: "test",
  };

  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const [key, value] of Object.entries(REQUIRED_FOR_COMPILE)) {
      saved.set(key, process.env[key]);
      // A real `.env` in the working tree wins: this is a floor, not an override,
      // so running with one configured exercises the same graph the app does.
      process.env[key] ??= value;
    }
  });

  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("resolves every provider in the real module graph", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
