import { MeController } from "./me.controller";
import { MeService } from "./me.service";
import { updateMyPreferencesSchema } from "./dto/me.schemas";
import type { CurrentUserContext } from "../common/auth/backend-claims";
import type { AccessService } from "../modules/access/access.service";

const caller = { userId: "user-self", orgId: "org-1" } as CurrentUserContext;

function makeDb(row?: { language: string }) {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = jest.fn().mockReturnValue({ values });
  const findFirst = jest.fn().mockResolvedValue(row);
  return {
    db: { insert, query: { userPreferences: { findFirst } } },
    values,
    onConflictDoUpdate,
  };
}

function makeController(db: unknown) {
  const service = new MeService(db as never, {} as never, {} as never);
  return new MeController({} as AccessService, service);
}

describe("/me/preferences is self-only", () => {
  it("writes the caller's own row and nobody else's", async () => {
    const { db, values, onConflictDoUpdate } = makeDb();

    await makeController(db).updateMyPreferences({ language: "hi" }, caller);

    expect(values).toHaveBeenCalledWith({ userId: "user-self", language: "hi" });
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: { language: "hi" } }),
    );
  });

  it("refuses a body that names another user or an unsupported language", () => {
    expect(
      updateMyPreferencesSchema.safeParse({ language: "hi", userId: "victim" }).success,
    ).toBe(false);
    expect(updateMyPreferencesSchema.safeParse({ language: "fr" }).success).toBe(false);
    expect(updateMyPreferencesSchema.safeParse({ language: "te" }).success).toBe(true);
  });

  it("reads back a stored language and falls back to en for anything else", async () => {
    await expect(
      makeController(makeDb({ language: "te" }).db).getMyPreferences(caller),
    ).resolves.toEqual({ language: "te" });
    await expect(
      makeController(makeDb({ language: "en-US" }).db).getMyPreferences(caller),
    ).resolves.toEqual({ language: "en" });
    await expect(
      makeController(makeDb(undefined).db).getMyPreferences(caller),
    ).resolves.toEqual({ language: "en" });
  });
});
