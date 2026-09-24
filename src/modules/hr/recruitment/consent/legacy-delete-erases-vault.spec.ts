import { RecruitmentCandidatesService } from "../recruitment-candidates.service";
import { RecruitmentCandidatesController } from "../recruitment-candidates.controller";
import type { CandidateErasureService } from "./candidate-erasure.service";

/**
 * `DELETE /hr/recruitment/candidates/:candidateId` is the button a recruiter
 * presses on the candidates list. It used to hard-delete the candidate, their
 * applications, interviews and SLA rows and never touch
 * `candidate_documents_vault` — leaving the résumé in the bucket with nothing
 * pointing at it, so no later erasure request could ever find it — and return
 * 204, which reads as "done".
 *
 * The 204 is still the contract. What changed is what happens before it, and
 * that is what these assert: the route erases through the service that ledgers
 * every object before deleting it, and the vault-blind delete it used to call
 * no longer exists to be called again.
 */

const ORG = "org-1";
const ACTOR = "user-1";

function build() {
  const eraseCandidate = jest.fn().mockResolvedValue({
    candidateId: 7,
    status: "ERASED",
    recordsDeleted: { applications: 1, interviews: 0, slaTracking: 0, vaultDocuments: 2, candidate: 1 },
    vault: { attempted: 2, confirmed: 2, failed: 0 },
    summary: "erased",
  });
  const erasure = { eraseCandidate } as unknown as CandidateErasureService;
  const controller = new RecruitmentCandidatesController(
    {} as never,
    {} as never,
    erasure,
  );
  return { controller, eraseCandidate };
}

describe("the recruiter's delete button", () => {
  it("erases through the vault-aware path, not a bare row delete", async () => {
    const { controller, eraseCandidate } = build();

    await controller.remove(7, { orgId: ORG, userId: ACTOR } as never);

    expect(eraseCandidate).toHaveBeenCalledWith(ORG, 7, ACTOR);
  });

  /**
   * Named separately from the call assertion: a handler that erased and then
   * also ran the old delete would satisfy the test above and still orphan
   * nothing — but a handler that erased for the wrong tenant would too, and the
   * tenant is the argument that decides whose résumé is destroyed.
   */
  it("erases for the caller's own organisation", async () => {
    const { controller, eraseCandidate } = build();

    await controller.remove(7, { orgId: "org-attacker", userId: ACTOR } as never);

    expect(eraseCandidate.mock.calls[0]?.[0]).toBe("org-attacker");
  });

  /**
   * The vault-blind delete is gone rather than merely unused. An unused method
   * that hard-deletes a candidate without their documents is a trap: the next
   * caller has no way to see, from the call site, that it skips the vault.
   */
  it("no longer exposes a candidate delete that skips the vault", () => {
    expect(
      (RecruitmentCandidatesService.prototype as Record<string, unknown>).remove,
    ).toBeUndefined();
  });
});
