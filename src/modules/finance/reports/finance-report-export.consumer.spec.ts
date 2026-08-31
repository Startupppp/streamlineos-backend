import { Test } from "@nestjs/testing";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { FinanceReportExportWorkerService } from "./finance-report-export-worker.service";
import { FinanceReportExportRequestedConsumer } from "./finance-report-export.consumer";
import { FINANCE_REPORT_EXPORT_REQUESTED_EVENT } from "./dto/finance-report-export.schemas";

const ORG_ID = "org-finance-export-1";
const EVENT_ID = "evt-finance-export-aaa";

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "finance_report_export_job",
    aggregateId: "job-1",
    aggregateVersion: 1,
    eventType: FINANCE_REPORT_EXPORT_REQUESTED_EVENT,
    payload: { jobId: 1, reportType: "vendor_statement" },
    deliveryState: "IN_FLIGHT",
    retryCount: 0,
    schemaVersion: 1,
    audience: "INTERNAL",
    actorMembershipId: null,
    causationId: null,
    correlationId: null,
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: null,
    lastError: null,
    deadLetteredAt: null,
    lifecycleState: "ACTIVE",
    createdAt: new Date(),
    ...overrides,
  };
}

async function buildService(options: { wakeImpl?: () => void } = {}) {
  const { wakeImpl = () => undefined } = options;
  const worker = {
    wake: jest.fn().mockImplementation(wakeImpl),
  } as unknown as FinanceReportExportWorkerService;
  const registry = new OutboxConsumerRegistry();

  const module = await Test.createTestingModule({
    providers: [
      FinanceReportExportRequestedConsumer,
      { provide: FinanceReportExportWorkerService, useValue: worker },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(FinanceReportExportRequestedConsumer);
  return { svc, worker, registry };
}

describe("FinanceReportExportRequestedConsumer", () => {
  describe("registration", () => {
    it("registers itself with the OutboxConsumerRegistry on init", async () => {
      const { svc, registry } = await buildService();
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = finance.report.export.requested", async () => {
      const { svc } = await buildService();
      expect(svc.eventType).toBe(FINANCE_REPORT_EXPORT_REQUESTED_EVENT);
    });
  });

  describe("B1 — consumer correctness", () => {
    it("calls worker.wake() on every delivered event", async () => {
      const { svc, worker } = await buildService();

      await svc.handle(makeEvent());

      expect(worker.wake).toHaveBeenCalledTimes(1);
    });
  });

  describe("B2 — no ambient tenant context needed", () => {
    it("does not use any ambient context — worker.wake() is org-agnostic", async () => {
      const { svc, worker } = await buildService();

      await svc.handle(makeEvent({ organizationId: "org-isolated-finance" }));

      expect(worker.wake).toHaveBeenCalledTimes(1);
    });
  });

  describe("B3 — thin consumer: wake() is synchronous, no network call, no retry needed", () => {
    it("completes without throwing for any event payload", async () => {
      const { svc } = await buildService();

      await expect(svc.handle(makeEvent({ payload: null }))).resolves.toBeUndefined();
    });
  });

  describe("B4 — no inbox fence: wake() called once per delivery (at-least-once)", () => {
    it("calls worker.wake() twice when the same event is delivered twice", async () => {
      const { svc, worker } = await buildService();

      await svc.handle(makeEvent());
      await svc.handle(makeEvent());

      expect(worker.wake).toHaveBeenCalledTimes(2);
    });
  });

  describe("B5 — DLQ replay: wake() is idempotent — re-delivery is safe", () => {
    it("wakes the worker on both the first call and the retry", async () => {
      const { svc, worker } = await buildService();

      await svc.handle(makeEvent());
      await svc.handle(makeEvent());

      expect(worker.wake).toHaveBeenCalledTimes(2);
    });
  });
});
