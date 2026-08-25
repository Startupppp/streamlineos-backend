/**
 * `@composio/core` ships ESM only, and jest cannot parse it — the workflow pulls
 * in the service, which pulls in `ComposioGateway`, which imports it. Stubbed at
 * the module loader exactly as `telephony-call-log.service.spec.ts` stubs it,
 * and never constructed here.
 *
 * Worth being precise about what this is and is not. It replaces the *transport
 * library* so the file can be loaded; it is not a mock of any CRM provider.
 * There is no Salesforce, HubSpot, Zoho or Pipedrive SDK in this repository to
 * mock — every connector reads raw HTTP through the proxy, and every one of them
 * is driven from a captured response body in `connectors/fixtures`. This spec
 * does not read a fixture at all: it is about what the run does between pages,
 * so its pages are a script.
 */
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { Logger } from "@nestjs/common";
import { createStepContext } from "../../common/workflow/step-context";
import { WorkflowRegistry } from "../../common/workflow";
import {
  isSuspension,
  type JsonValue,
  type RecordedStep,
  type WorkflowStepStore,
} from "../../common/workflow/workflow.types";
import type {
  CrmConnectorService,
  PageOutcome,
  WalkExtent,
  WalkResult,
} from "./crm-connector.service";
import { CrmConnectorWorkflow } from "./crm-connector.workflow";
import { CONNECTOR_SYNC_WORKFLOW } from "./import-workflow-names";
import { ATTEMPT_BUDGET_MS } from "./import-batches";
import type { ConnectorRequest } from "./connectors/connector-source";

const ORG = "org-1";
const SYNC = "sync-1";
const RUN = "run-1";

/**
 * The step store, in memory, obeying the one rule the whole design leans on:
 * **only a COMPLETED step is memoised.** A step whose previous attempt FAILED
 * runs again. A fake that memoised failures too would make every resumption test
 * here pass for the wrong reason.
 */
class FakeStepStore implements WorkflowStepStore {
  readonly steps = new Map<string, RecordedStep>();

  loadSteps(): Promise<RecordedStep[]> {
    return Promise.resolve([...this.steps.values()]);
  }

  recordStep(step: {
    stepName: string;
    status: "COMPLETED" | "FAILED";
    output: JsonValue | null;
  }): Promise<void> {
    this.steps.set(step.stepName, {
      stepName: step.stepName,
      status: step.status,
      output: step.output,
    });
    return Promise.resolve();
  }

  named(prefix: string): string[] {
    return [...this.steps.keys()].filter((name) => name.startsWith(prefix)).sort();
  }
}

function request(path: string): ConnectorRequest {
  return { method: "GET", path };
}

/**
 * A connector service that answers from a script, and records what it was asked.
 *
 * The script is a list of page outcomes; `fetchPage` returns the next one and
 * remembers the request it was given. That is what makes re-fetching visible: a
 * resumed attempt that re-issued a memoised page would appear here as an extra
 * entry in `requested`, which is the failure the memoisation exists to prevent.
 */
class FakeConnectors {
  readonly requested: string[] = [];
  readonly failures: string[] = [];
  finished: { drained: boolean } | null = null;

  constructor(
    private readonly pages: readonly (PageOutcome | Error)[],
    private readonly extent: WalkExtent = {
      settled: false,
      reason: null,
      startAt: request("/first"),
      since: null,
    },
    private readonly full = Number.POSITIVE_INFINITY,
  ) {}

  beginWalk(): Promise<WalkExtent> {
    return Promise.resolve(this.extent);
  }

  fetchPage(
    _organizationId: string,
    _syncId: string,
    req: ConnectorRequest,
  ): Promise<PageOutcome> {
    const index = this.requested.length;
    this.requested.push(req.path);

    const page = this.pages[index];
    if (!page) throw new Error(`no scripted page ${String(index)}`);
    if (page instanceof Error) return Promise.reject(page);
    return Promise.resolve(page);
  }

  isFull(total: number): boolean {
    return total >= this.full;
  }

  finishWalk(
    _organizationId: string,
    _syncId: string,
    drained: boolean,
  ): Promise<WalkResult> {
    this.finished = { drained };
    return Promise.resolve({
      crmImportId: "import-1",
      records: 3,
      drained,
      watermarkAdvanced: drained,
    });
  }

  recordFailure(_organizationId: string, _syncId: string, message: string): Promise<void> {
    this.failures.push(message);
    return Promise.resolve();
  }

  asService(): CrmConnectorService {
    return this as unknown as CrmConnectorService;
  }
}

function page(staged: number, total: number, next: string | null): PageOutcome {
  return { staged, total, next: next ? request(next) : null };
}

interface Attempt {
  outcome: "completed" | "suspended" | "failed";
  error?: unknown;
  output?: JsonValue | void;
}

/**
 * One attempt at a run, through the REAL step context.
 *
 * Deliberately not a hand-written replay: the memoisation rules are the thing
 * under test, and a fake step context would be a second implementation of them
 * that agrees with the real one only by inspection.
 */
async function attempt(
  registry: WorkflowRegistry,
  store: FakeStepStore,
  attemptNumber: number,
): Promise<Attempt> {
  const definition = registry.get(CONNECTOR_SYNC_WORKFLOW);
  if (!definition) throw new Error(`${CONNECTOR_SYNC_WORKFLOW} is not registered`);

  const step = await createStepContext({
    runId: RUN,
    organizationId: ORG,
    attempt: attemptNumber,
    store,
  });

  try {
    const output = await definition.handler(step, {
      runId: RUN,
      organizationId: ORG,
      attempt: attemptNumber,
      input: { crmConnectorSyncId: SYNC },
    });
    return { outcome: "completed", output };
  } catch (error) {
    if (isSuspension(error)) return { outcome: "suspended" };
    return { outcome: "failed", error };
  }
}

function build(connectors: FakeConnectors): { registry: WorkflowRegistry; store: FakeStepStore } {
  const registry = new WorkflowRegistry();
  const workflow = new CrmConnectorWorkflow(registry, connectors.asService());
  workflow.onModuleInit();
  return { registry, store: new FakeStepStore() };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe("the connector sync workflow", () => {
  it("follows the provider's pages to the end of the collection", async () => {
    const connectors = new FakeConnectors([
      page(2, 2, "/page-2"),
      page(2, 4, "/page-3"),
      page(1, 5, null),
    ]);
    const { registry, store } = build(connectors);

    const result = await attempt(registry, store, 0);

    expect(result.outcome).toBe("completed");
    expect(connectors.requested).toEqual(["/first", "/page-2", "/page-3"]);
    expect(connectors.finished).toEqual({ drained: true });
    expect(store.named("fetch-page-")).toEqual([
      "fetch-page-0",
      "fetch-page-1",
      "fetch-page-2",
    ]);
  });

  /**
   * Stopping because the import is full is NOT draining.
   *
   * This is the distinction the whole watermark rule rests on. The provider
   * still has records, so the collection was not read to the end, so nothing may
   * be claimed as read — `finishWalk` is told `drained: false` and the cursor it
   * kept is where the next sync starts.
   */
  it("stops when the import is full without claiming the collection was drained", async () => {
    const connectors = new FakeConnectors(
      [page(3, 3, "/page-2"), page(3, 6, "/page-3"), page(3, 9, "/page-4")],
      undefined,
      5,
    );
    const { registry, store } = build(connectors);

    await attempt(registry, store, 0);

    // Two pages, because the second took the total past the ceiling.
    expect(connectors.requested).toEqual(["/first", "/page-2"]);
    expect(connectors.finished).toEqual({ drained: false });
  });

  /**
   * The resumption property, watched rather than assumed.
   *
   * The second page fails, so its step is recorded FAILED and is not memoised.
   * On the next attempt the first page is replayed from its memo — no request —
   * and the walk continues from the frontier rather than from the collection's
   * beginning. A design that re-read from page one on every attempt would show
   * up here as `/first` appearing twice.
   */
  it("resumes at the failed page instead of restarting the collection", async () => {
    const boom = new Error("429 Too Many Requests");
    const connectors = new FakeConnectors([
      page(2, 2, "/page-2"),
      boom,
      // The retry of page two, then the last page.
      page(2, 4, "/page-3"),
      page(1, 5, null),
    ]);
    const { registry, store } = build(connectors);

    const first = await attempt(registry, store, 0);
    expect(first.outcome).toBe("failed");
    expect(connectors.requested).toEqual(["/first", "/page-2"]);
    // Counted so a connector nobody will fix eventually stops, and re-thrown so
    // the runtime can retry the ones that are transient.
    expect(connectors.failures).toEqual(["429 Too Many Requests"]);

    const second = await attempt(registry, store, 1);
    expect(second.outcome).toBe("completed");

    // `/first` exactly once across both attempts: the memo was honoured.
    expect(connectors.requested).toEqual(["/first", "/page-2", "/page-2", "/page-3"]);
    expect(connectors.requested.filter((path) => path === "/first")).toHaveLength(1);
    expect(connectors.finished).toEqual({ drained: true });
  });

  /**
   * A failure must not look like a drain.
   *
   * `finishWalk` is the only thing that can advance a watermark, so a run that
   * threw must never reach it. If it did, a failed read of half a collection
   * would claim the whole of it.
   */
  it("never finishes a walk that failed", async () => {
    const connectors = new FakeConnectors([new Error("connection reset")]);
    const { registry, store } = build(connectors);

    const result = await attempt(registry, store, 0);

    expect(result.outcome).toBe("failed");
    expect(connectors.finished).toBeNull();
  });

  /**
   * A settled walk reads nothing at all.
   *
   * Disabled, too many failures, or a disconnected account: each is an answer
   * rather than an error, and none of them should cost a provider request.
   */
  it("does nothing when the walk is settled", async () => {
    const connectors = new FakeConnectors([], {
      settled: true,
      reason: "This connector is switched off.",
      startAt: null,
      since: null,
    });
    const { registry, store } = build(connectors);

    const result = await attempt(registry, store, 0);

    expect(result.outcome).toBe("completed");
    expect(result.output).toMatchObject({ settled: true });
    expect(connectors.requested).toEqual([]);
    expect(connectors.finished).toBeNull();
  });

  /**
   * A walk that resumes starts from the persisted cursor, not from the top.
   *
   * The cursor comes out of `sync-begin`'s memo, which is what makes every
   * attempt of the run agree about where the walk began.
   */
  it("starts from the persisted cursor when one was left behind", async () => {
    const connectors = new FakeConnectors([page(1, 1, null)], {
      settled: false,
      reason: null,
      startAt: request("/resume-from-here"),
      since: "2026-08-01T00:00:00.000Z",
    });
    const { registry, store } = build(connectors);

    await attempt(registry, store, 0);

    expect(connectors.requested).toEqual(["/resume-from-here"]);
  });

  /**
   * An attempt that spends its budget releases the run between pages, and the
   * replay picks up where it stopped without re-issuing a request.
   */
  it("suspends when the attempt's budget is spent and resumes at the frontier", async () => {
    const connectors = new FakeConnectors([
      page(2, 2, "/page-2"),
      page(2, 4, "/page-3"),
      page(1, 5, null),
    ]);
    const { registry, store } = build(connectors);

    const realNow = Date.now;
    let ticks = 0;
    jest.spyOn(Date, "now").mockImplementation(() => {
      ticks += 1;
      // The first few reads are the attempt's start and its first budget check;
      // after that every check is past the budget.
      return ticks <= 2 ? realNow() : realNow() + ATTEMPT_BUDGET_MS + 1;
    });

    const first = await attempt(registry, store, 0);
    expect(first.outcome).toBe("suspended");
    expect(connectors.requested).toEqual(["/first"]);

    jest.spyOn(Date, "now").mockImplementation(() => realNow());

    const second = await attempt(registry, store, 1);
    expect(second.outcome).toBe("completed");

    // No page re-read across the suspension.
    expect(connectors.requested).toEqual(["/first", "/page-2", "/page-3"]);
    expect(connectors.finished).toEqual({ drained: true });
  });
});
