# Auth Engine

## JWT Flow

1. User signs in via NextAuth credentials provider (passwordless)
2. NextAuth `authorize()` POSTs to `POST /auth/magic-link/verify` (magic link / email-OTP) or `POST /auth/google` (Google OAuth) on NestJS backend
3. The Next server forwards the real browser context via `x-client-user-agent` and `x-client-ip` headers
4. Backend verifies the token/code, creates a `user_sessions` row, and returns `{ userId, orgId, sessionId }` (magic link) or `{ userId, isNewUser, sessionId }` (Google)
5. NextAuth stores `sessionId` in the JWT cookie; every subsequent API call carries it in the bearer token
6. `JwtAuthGuard` validates the JWT and populates `CurrentUserContext` on every request

## Guards

- `JwtAuthGuard` — validates JWT, populates `@CurrentUser()`; skipped for `@Public()` endpoints
- `ApiKeyGuard` — alternative auth via `x-api-key` header
- `@Public()` — marks endpoints that bypass `JwtAuthGuard`

## Session Caching Contract

- Redis key: `user:session:{userId}` — caches user profile, access scope map, and plan, TTL 300s
- Invalidated on: logout, account deactivation, role change
- Auth pipeline: `JwtAuthGuard` validates token → `@CurrentUser()` provides `userId`, `orgId`, `role`, `sessionId`; capability checks use `AccessService.scopeFor()`/`holds()`

## Auth Engine Pipeline (login)

### Magic link / Email-OTP
```
verify token/OTP hash
  → mark token used
  → resolve active org membership
  → create session row (user_sessions, 30-day expiry)
  → log loginHistory
  → invalidate session cache
  → return { userId, orgId, sessionId }
```

### Google OAuth
```
look up google account by providerAccountId
  → if found: create session row → return { userId, isNewUser: false, sessionId }
  → else: find user by email, link google account, create session row
         → if no user: create user + account + session row, emit audit event
  → return { userId, isNewUser, sessionId }
```

### Self-healing (sessions.list)
When a bearer-carried `sessionId` has no matching DB row (e.g. session minted before this change), `sessions.list` inserts the row with the real browser context on the first call rather than silently no-op'ing. Incoming API-client user-agents never overwrite a stored real browser UA.

## Rate Limits (public endpoints)

| Endpoint | Limit | Window |
|----------|-------|--------|
| POST /auth/magic-link/verify | 10 | 60s |
| POST /auth/email-otp/verify | 10 | 60s |
| POST /auth/magic-link | 5 | 60s |
| POST /auth/email-otp | 5 | 60s |
| POST /auth/verify-email | 10 | 60s |
| POST /auth/resend-verification | 3 | 60s |
