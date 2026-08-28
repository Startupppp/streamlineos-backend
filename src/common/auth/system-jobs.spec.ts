import {
  SYSTEM_JOBS,
  SYSTEM_JOB_IDS,
  systemJobCeiling,
  type SystemJobId,
} from "./system-jobs";
import { isPersonalTokenPermissionDelegable } from "../rbac/personal-token-policy";
import { ALL_PERMISSION_NAMES } from "../../modules/rbac/permissions";

describe("the system job catalog", () => {
  it("declares jobs at all — an empty catalog is a broken import, not a clean one", () => {
    expect(SYSTEM_JOB_IDS.length).toBeGreaterThan(5);
  });

  it("gives every job a reason and a non-empty ceiling", () => {
    for (const id of SYSTEM_JOB_IDS) {
      const job = SYSTEM_JOBS[id];
      expect(job.reason.trim().length).toBeGreaterThan(0);
      expect(job.ceiling.length).toBeGreaterThan(0);
    }
  });

  function interactiveOnlyKeysIn(
    ceilings: ReadonlyMap<string, readonly string[]>,
  ): string[] {
    const offending: string[] = [];
    for (const [id, ceiling] of ceilings) {
      for (const key of ceiling) {
        if (!isPersonalTokenPermissionDelegable(key)) offending.push(`${id} → ${key}`);
      }
    }
    return offending;
  }

  it("never puts an interactive-only key in a ceiling", () => {
    const ceilings = new Map<string, readonly string[]>(
      SYSTEM_JOB_IDS.map((id) => [id, systemJobCeiling(id)]),
    );

    expect(ceilings.size).toBe(SYSTEM_JOB_IDS.length);
    expect(interactiveOnlyKeysIn(ceilings)).toEqual([]);
  });

  it("catches an interactive-only key when one is present", () => {
    const withOffender = new Map<string, readonly string[]>([
      ["accounting.only", ["accounting:journal:post"]],
      ["hypothetical.org-setup", ["accounting:journal:post", "settings:rbac:manage"]],
    ]);

    expect(interactiveOnlyKeysIn(withOffender)).toEqual([
      "hypothetical.org-setup → settings:rbac:manage",
    ]);
  });

  it("bars an interactive-only key rather than silently narrowing it to none", () => {
    expect(isPersonalTokenPermissionDelegable("billing:subscription:manage")).toBe(false);
    expect(isPersonalTokenPermissionDelegable("ownership:transfer:initiate")).toBe(false);
    expect(isPersonalTokenPermissionDelegable("settings:rbac:manage")).toBe(false);
    expect(isPersonalTokenPermissionDelegable("accounting:journal:post")).toBe(true);
  });

  it("names only keys that exist in the permission catalog", () => {
    const known = new Set(ALL_PERMISSION_NAMES);
    expect(known.size).toBeGreaterThan(100);
    const unknown: string[] = [];
    for (const id of SYSTEM_JOB_IDS) {
      for (const key of systemJobCeiling(id)) {
        if (!known.has(key)) unknown.push(`${id} → ${key}`);
      }
    }

    expect(unknown).toEqual([]);
  });

  it("has a ceiling per job that is free of duplicates", () => {
    for (const id of SYSTEM_JOB_IDS) {
      const ceiling = systemJobCeiling(id);
      expect(new Set(ceiling).size).toBe(ceiling.length);
    }
  });

  it("resolves a ceiling for every declared id", () => {
    for (const id of SYSTEM_JOB_IDS) expect(systemJobCeiling(id)).toBe(SYSTEM_JOBS[id].ceiling);
  });

  it("keeps the id union and the runtime id list in step", () => {
    const fromKeys = Object.keys(SYSTEM_JOBS) as SystemJobId[];
    expect(SYSTEM_JOB_IDS.sort()).toEqual(fromKeys.sort());
  });
});
