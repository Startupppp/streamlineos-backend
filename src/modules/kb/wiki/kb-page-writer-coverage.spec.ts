import "reflect-metadata";
import { KbPageWriterService } from "./kb-page-writer.service";
import { KbPagesService } from "./kb-pages.service";
import { KbPagePublicService } from "./kb-page-public.service";
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

const PAGE_MUTATING_SERVICES: Function[] = [
  KbPagesService,
  KbPagePublicService,
  KbPageStatusService,
  KbPageVersionsService,
  KbPageTreeService,
  KbPageDuplicateService,
  KbImportProcessConsumer,
];

describe("structural invariant: every injectable page-mutating service routes its index event through KbPageWriterService", () => {
  for (const ServiceClass of PAGE_MUTATING_SERVICES) {
    it(`${ServiceClass.name} injects KbPageWriterService, without which it would hand-roll its own kb.content.index event and drift from the others`, () => {
      expect(hasWriterInjected(ServiceClass)).toBe(true);
    });
  }

  it("CONTROL: a page-mutating service that does not take the writer is reported as uninjected, proving the assertions above are not true of every class", () => {
    class ServiceWithoutWriter {
      constructor(readonly unrelated: string) {}
    }

    expect(hasWriterInjected(ServiceWithoutWriter)).toBe(false);
  });
});
