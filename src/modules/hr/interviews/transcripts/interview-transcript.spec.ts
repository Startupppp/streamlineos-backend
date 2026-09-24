import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { InterviewTranscriptService } from "./interview-transcript.service";
import {
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  resolveTranscription,
  TRANSCRIPTION_ADAPTERS,
} from "./transcription-provider";

const INTERVIEW_AT = new Date("2026-03-02T10:00:00.000Z");

interface Written {
  values: Record<string, unknown>;
}

function build(options: { interviewExists?: boolean; transcript?: string | null } = {}) {
  const updates: Written[] = [];
  const audits: Array<{ action: string; critical: boolean; metadata?: Record<string, unknown> }> = [];

  const row = {
    id: 7,
    scheduledAt: INTERVIEW_AT,
    transcript: options.transcript ?? null,
    transcriptSource: null,
    transcriptConsentAt: null,
    transcriptRetainUntil: null,
    transcriptStoredAt: null,
  };

  const db = {
    query: {
      interviews: {
        findFirst: jest.fn(() =>
          Promise.resolve(options.interviewExists === false ? undefined : row),
        ),
      },
    },
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => ({
        where: jest.fn(() => {
          updates.push({ values });
          return {
            returning: jest.fn(() =>
              Promise.resolve(options.transcript ? [{ id: 7 }] : []),
            ),
          };
        }),
      })),
    })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([{ id: 7 }])) })),
      })),
    })),
  };

  const audit = {
    logCritical: jest.fn((entry: { action: string; metadata?: Record<string, unknown> }) => {
      audits.push({ action: entry.action, critical: true, metadata: entry.metadata });
      return Promise.resolve();
    }),
    log: jest.fn((entry: { action: string }) => {
      audits.push({ action: entry.action, critical: false });
    }),
  };

  const credentials = { forPlatform: jest.fn(() => Promise.resolve(null)) };

  return {
    service: new InterviewTranscriptService(db as never, audit as never, credentials as never),
    updates,
    audits,
  };
}

describe("InterviewTranscriptService.store", () => {
  const consentAt = new Date("2026-03-02T09:58:00.000Z");

  it("stores the transcript with its consent and a retention date", async () => {
    const { service, updates } = build();
    await service.store("org-1", "user-1", 42, 7, { text: "Q: ...\nA: ...", consentAt });

    expect(updates[0]?.values).toMatchObject({
      transcript: "Q: ...\nA: ...",
      transcriptSource: "MANUAL_UPLOAD",
      transcriptConsentAt: consentAt,
      transcriptStoredByMembershipId: 42,
    });
    expect(updates[0]?.values.transcriptRetainUntil).toBeInstanceOf(Date);
  });

  it("defaults retention to a year and caps it at three", async () => {
    const { service, updates } = build();
    await service.store("org-1", "user-1", 42, 7, { text: "t", consentAt });
    const retainUntil = updates[0]?.values.transcriptRetainUntil as Date;
    const days = Math.round((retainUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    expect(days).toBe(DEFAULT_RETENTION_DAYS);

    const capped = build();
    await capped.service.store("org-1", "user-1", 42, 7, {
      text: "t",
      consentAt,
      retentionDays: 99_999,
    });
    const cappedUntil = capped.updates[0]?.values.transcriptRetainUntil as Date;
    const cappedDays = Math.round((cappedUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    expect(cappedDays).toBe(MAX_RETENTION_DAYS);
  });

  /**
   * The gate. A transcript held without a consent instant is a recording of
   * somebody who never agreed, and the failure has to be at the write.
   */
  it("refuses a consent timestamp in the future", async () => {
    const { service, updates } = build();
    await expect(
      service.store("org-1", "user-1", 42, 7, {
        text: "t",
        consentAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it("refuses a consent timestamp from long before the interview", async () => {
    const { service, updates } = build();
    await expect(
      service.store("org-1", "user-1", 42, 7, {
        text: "t",
        consentAt: new Date("2020-01-01T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it("accepts consent given shortly before the interview started", async () => {
    const { service, updates } = build();
    await service.store("org-1", "user-1", 42, 7, {
      text: "t",
      consentAt: new Date(INTERVIEW_AT.getTime() - 5 * 60 * 1000),
    });
    expect(updates).toHaveLength(1);
  });

  it("404s for an interview in another organisation", async () => {
    const { service } = build({ interviewExists: false });
    await expect(
      service.store("org-1", "user-1", 42, 7, { text: "t", consentAt }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * logCritical, not log: this row is the evidence a named person stored a
   * recording under a stated consent, and it must not drop silently.
   */
  it("writes a critical audit row naming the consent and retention", async () => {
    const { service, audits } = build();
    await service.store("org-1", "user-1", 42, 7, { text: "hello", consentAt });

    const stored = audits.find((a) => a.action === "hr.interviews.transcript.stored");
    expect(stored?.critical).toBe(true);
    expect(stored?.metadata).toMatchObject({
      source: "MANUAL_UPLOAD",
      consentAt: consentAt.toISOString(),
    });
  });
});

describe("InterviewTranscriptService.read", () => {
  it("records who read a transcript", async () => {
    const { service, audits } = build({ transcript: "the words" });
    await service.read("org-1", "user-1", 7);
    expect(audits.map((a) => a.action)).toContain("hr.interviews.transcript.viewed");
  });

  /** Nothing to disclose, nothing to audit. */
  it("does not record a read of an interview with no transcript", async () => {
    const { service, audits } = build({ transcript: null });
    await service.read("org-1", "user-1", 7);
    expect(audits).toHaveLength(0);
  });

  it("reports why an automatic transcription is unavailable", async () => {
    const { service } = build({ transcript: "x" });
    const view = await service.read("org-1", "user-1", 7);
    expect(view.providerBlockedReason).toContain("not connected");
  });
});

describe("InterviewTranscriptService.erase", () => {
  it("clears every transcript column and logs the reason", async () => {
    const { service, updates, audits } = build({ transcript: "the words" });
    const result = await service.erase("org-1", "user-1", 7, "DPDP erasure request");

    expect(result.erased).toBe(true);
    expect(updates[0]?.values).toEqual({
      transcript: null,
      transcriptSource: null,
      transcriptConsentAt: null,
      transcriptRetainUntil: null,
      transcriptStoredAt: null,
      transcriptStoredByMembershipId: null,
    });
    const erased = audits.find((a) => a.action === "hr.interviews.transcript.erased");
    expect(erased?.critical).toBe(true);
    expect(erased?.metadata).toMatchObject({ reason: "DPDP erasure request" });
  });

  it("reports false and logs nothing when there was no transcript", async () => {
    const { service, audits } = build({ transcript: null });
    const result = await service.erase("org-1", "user-1", 7, "sweep");
    expect(result.erased).toBe(false);
    expect(audits).toHaveLength(0);
  });
});

describe("the transcription provider", () => {
  /**
   * The most important empty registry in this module. A transcript justifies a
   * hiring decision months later; an adapter that produced plausible sentences
   * with no vendor behind it would put invented words in somebody's record with
   * no way to tell them from real ones.
   */
  it("ships no adapter", () => {
    expect(TRANSCRIPTION_ADAPTERS.size).toBe(0);
  });

  it("blocks with no-integration when nothing is connected", () => {
    expect(resolveTranscription(null)).toMatchObject({
      status: "BLOCKED",
      code: "no-integration",
    });
  });

  it("blocks as not-implemented even with credentials saved, and names the fallback", () => {
    const resolved = resolveTranscription({
      platform: "TRANSCRIPTION",
      isActive: true,
      token: "vendor-key",
      meta: {},
    });
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "not-implemented" });
    if ("adapter" in resolved) throw new Error("expected no adapter");
    expect(resolved.message).toContain("Upload a transcript yourself");
  });

  it("refuses the automatic path rather than inventing a transcript", async () => {
    const { service } = build();
    await expect(service.transcribeRecording("org-1", 7)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
