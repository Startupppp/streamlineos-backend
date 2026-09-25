import { IDEMPOTENCY_COMMAND } from "../../../common/idempotency/idempotency.constants";
import { KbPageReviewsController } from "./kb-page-reviews.controller";
import { KbPagesController } from "./kb-pages.controller";

function commandNameOf(handler: unknown): string | undefined {
  return Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler as object) as
    | string
    | undefined;
}

describe("KB bulk and destructive commands are replay-fenced", () => {
  it("bulk-decide carries an idempotency command name, like the single approve it batches", () => {
    expect(commandNameOf(KbPageReviewsController.prototype.bulkDecide)).toBeDefined();
  });

  it("bulk restore from trash carries an idempotency command name", () => {
    expect(
      commandNameOf(KbPagesController.prototype.bulkRestoreFromTrash),
    ).toBeDefined();
  });

  it("bulk purge from trash carries an idempotency command name, because a replayed purge is irreversible", () => {
    expect(
      commandNameOf(KbPagesController.prototype.bulkPurgeFromTrash),
    ).toBeDefined();
  });

  it("empty trash carries an idempotency command name", () => {
    expect(commandNameOf(KbPagesController.prototype.emptyTrash)).toBeDefined();
  });

  it("every fenced KB command name is distinct, so two routes cannot share one replay record", () => {
    const names = [
      commandNameOf(KbPageReviewsController.prototype.bulkDecide),
      commandNameOf(KbPagesController.prototype.bulkRestoreFromTrash),
      commandNameOf(KbPagesController.prototype.bulkPurgeFromTrash),
      commandNameOf(KbPagesController.prototype.emptyTrash),
      commandNameOf(KbPageReviewsController.prototype.approve),
      commandNameOf(KbPageReviewsController.prototype.reject),
    ];

    expect(new Set(names).size).toBe(names.length);
  });

  it("a read route carries no idempotency command, so the assertions above are not vacuous", () => {
    expect(commandNameOf(KbPageReviewsController.prototype.list)).toBeUndefined();
    expect(commandNameOf(KbPagesController.prototype.getTrash)).toBeUndefined();
  });
});
