import "reflect-metadata";
import { KbPageWriterService } from "./kb-page-writer.service";
import { KbPagesService } from "./kb-pages.service";
import { KbPageStatusService } from "./kb-page-status.service";
import { KbPageVersionsService } from "./kb-page-versions.service";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbPageDuplicateService } from "./kb-page-duplicate.service";
import { KbImportProcessConsumer } from "./kb-import-process.consumer";

function hasWriterInjected(ServiceClass: Function): boolean {
  const paramTypes = Reflect.getMetadata("design:paramtypes", ServiceClass) as
    | Function[]
    | undefined;
  return paramTypes?.some((t) => t === KbPageWriterService) ?? false;
}

// These six injectable services hand-roll kb.content.index events today.
// Lane 9 migrates them one at a time: add KbPageWriterService to the constructor,
// then remove the service's entry from this set.
// When this set is empty, every injectable page-mutating service has been migrated.
// Removing a service from the set flips its test from "not yet migrated" to
// "must have writer injected" — the test goes red immediately if the injection
// was not actually added, catching an incomplete migration.
const NOT_YET_MIGRATED = new Set<Function>([
  KbPagesService,
  KbPageStatusService,
  KbPageVersionsService,
  KbPageTreeService,
  KbPageDuplicateService,
  KbImportProcessConsumer,
]);

// Full list of injectable services that own page mutations.
// Add here when a new page-mutating service is introduced.
// A service added here but not in NOT_YET_MIGRATED must inject the writer
// or the test fails immediately.
const PAGE_MUTATING_SERVICES: Function[] = [
  KbPagesService,
  KbPageStatusService,
  KbPageVersionsService,
  KbPageTreeService,
  KbPageDuplicateService,
  KbImportProcessConsumer,
];

describe("structural invariant: every injectable page-mutating service migrates to KbPageWriterService", () => {
  for (const ServiceClass of PAGE_MUTATING_SERVICES) {
    if (NOT_YET_MIGRATED.has(ServiceClass)) {
      it(`${ServiceClass.name} — not yet migrated (remove from NOT_YET_MIGRATED after Lane 9 adds the injection)`, () => {
        expect(hasWriterInjected(ServiceClass)).toBe(false);
      });
    } else {
      it(`${ServiceClass.name} injects KbPageWriterService`, () => {
        expect(hasWriterInjected(ServiceClass)).toBe(true);
      });
    }
  }
});

// BLIND SPOT: support/core/lib/support-kb-articles.ts::updateArticle
// This file is a module of plain exported async functions, not an @Injectable() class.
// Reflect.getMetadata cannot see it. It emits kb.content.index for aggregateType "kb_page"
// directly via OutboxWriter.emit (confirmed at line 340–355).
// Lane 9 must migrate it separately: refactor updateArticle to accept a KbPageWriterService
// parameter, then add a behavioral test asserting it calls writer.commitPageChange rather
// than OutboxWriter.emit directly.
