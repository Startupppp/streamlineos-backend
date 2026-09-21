import { of, tap } from "rxjs";
import { lastValueFrom } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { ImpersonationContextInterceptor } from "./impersonation-context.interceptor";
import { getImpersonationContext, type ImpersonationContext } from "./impersonation-context";
import type { CurrentUserContext } from "../auth/backend-claims";
import { ACCOUNT_ONLY_PRINCIPAL } from "../auth/principal";

function makeImpersonatedUser(): CurrentUserContext {
  return {
    userId: "target-user-uuid",
    orgId: "org-uuid",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "impersonated-session-uuid",
    tokenScopes: null,
    principal: ACCOUNT_ONLY_PRINCIPAL,
    impersonation: {
      realActorUserId: "real-admin-uuid",
      realSessionId: "real-session-uuid",
      impersonationSessionId: "ims-session-uuid",
    },
  };
}

function makeRegularUser(): CurrentUserContext {
  return {
    userId: "user-uuid",
    orgId: "org-uuid",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-uuid",
    tokenScopes: null,
    principal: ACCOUNT_ONLY_PRINCIPAL,
  };
}

function makeHttpContext(user: CurrentUserContext | undefined): ExecutionContext {
  const req: { user?: CurrentUserContext } = { user };
  return {
    getType: () => "http" as const,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeNonHttpContext(): ExecutionContext {
  return {
    getType: () => "ws" as const,
    switchToHttp: () => { throw new Error("should not be called"); },
  } as unknown as ExecutionContext;
}

describe("ImpersonationContextInterceptor", () => {
  const interceptor = new ImpersonationContextInterceptor();

  it("sets the impersonation context so getImpersonationContext returns the real actor for audit attribution during an impersonated request", async () => {
    let captured: ImpersonationContext | undefined;
    const handler: CallHandler = {
      handle: () => of("result").pipe(tap(() => { captured = getImpersonationContext(); })),
    };

    await lastValueFrom(interceptor.intercept(makeHttpContext(makeImpersonatedUser()), handler));

    expect(captured).toEqual({
      realActorUserId: "real-admin-uuid",
      impersonationSessionId: "ims-session-uuid",
    });
  });

  it("leaves getImpersonationContext undefined inside the handler for a non-impersonated request so audit logs are not contaminated with stale impersonation data", async () => {
    let captured: ImpersonationContext | undefined;
    const handler: CallHandler = {
      handle: () => of("result").pipe(tap(() => { captured = getImpersonationContext(); })),
    };

    await lastValueFrom(interceptor.intercept(makeHttpContext(makeRegularUser()), handler));

    expect(captured).toBeUndefined();
  });

  it("passes through non-HTTP execution contexts without intercepting the handler chain", async () => {
    const handler: CallHandler = { handle: () => of("ws-result") };

    const result = await lastValueFrom(interceptor.intercept(makeNonHttpContext(), handler));

    expect(result).toBe("ws-result");
  });

  it("passes through when req.user is absent so unauthenticated public routes are unaffected", async () => {
    let captured: ImpersonationContext | undefined;
    const handler: CallHandler = {
      handle: () => of("anon").pipe(tap(() => { captured = getImpersonationContext(); })),
    };

    await lastValueFrom(interceptor.intercept(makeHttpContext(undefined), handler));

    expect(captured).toBeUndefined();
  });
});
