import { Body, Controller, INestApplication, Module, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { z } from "zod";
import { AllExceptionsFilter } from "./all-exceptions.filter";
import { correlationIdMiddleware } from "./correlation-id.middleware";

/**
 * The envelope and the correlation header, asserted over a real HTTP round trip.
 *
 * Every existing proof called the filter with a hand-built ArgumentsHost, so
 * nothing showed that the two halves meet: that the middleware's header survives
 * onto a response the filter writes, and that a route Nest itself rejects (an
 * unknown path — no controller, no filter-aware code involved) still comes back
 * in the shape a client parses.
 *
 * PROVISIONAL: the flat `{code, message, details, correlationId}` envelope and
 * the 400 `VALIDATION_FAILED` status are the decided contract — not `requestId`,
 * not nested under `error`.
 */
const bodySchema = z.object({ email: z.string().email() });

@Controller("envelope-probe")
class EnvelopeProbeController {
  @Post()
  create(@Body() body: unknown): { ok: true } {
    bodySchema.parse(body);
    return { ok: true };
  }
}

@Module({ controllers: [EnvelopeProbeController] })
class EnvelopeProbeModule {}

describe("error envelope over HTTP", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [EnvelopeProbeModule],
    }).compile();

    app = ref.createNestApplication();
    app.use(correlationIdMiddleware);
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it("answers an unknown route with the envelope and the request id header", async () => {
    const res = await request(app.getHttpServer()).get("/no-such-route");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: "NOT_FOUND",
      message: expect.any(String),
    });
    expect(res.body.correlationId).toEqual(expect.any(String));
    expect(res.headers["x-request-id"]).toBe(res.body.correlationId);
  });

  it("echoes a caller-supplied correlation id onto the envelope and the header", async () => {
    const res = await request(app.getHttpServer())
      .get("/no-such-route")
      .set("x-correlation-id", "caller-supplied-1");

    expect(res.body.correlationId).toBe("caller-supplied-1");
    expect(res.headers["x-request-id"]).toBe("caller-supplied-1");
    expect(res.headers["x-correlation-id"]).toBe("caller-supplied-1");
  });

  it("answers a Zod validation failure 400 VALIDATION_FAILED with field details and the header", async () => {
    const res = await request(app.getHttpServer())
      .post("/envelope-probe")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Validation failed.",
      details: [{ path: "email", message: expect.any(String) }],
    });
    expect(res.headers["x-request-id"]).toBe(res.body.correlationId);
  });
});
