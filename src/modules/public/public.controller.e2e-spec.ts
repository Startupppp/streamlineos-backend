import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "../../../test/helpers/e2e-app";

describe("Public auth (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch";

  interface PublicCase {
    method: Method;
    path: string;
    body?: Record<string, unknown>;
  }

  function call(c: PublicCase): request.Test {
    const agent = request(app.getHttpServer());
    switch (c.method) {
      case "get":
        return agent.get(c.path);
      case "post":
        return agent.post(c.path).send(c.body ?? {});
      case "patch":
        return agent.patch(c.path).send(c.body ?? {});
    }
  }

  const publicRoutes: ReadonlyArray<PublicCase> = [
    { method: "get", path: "/public/roadmap" },
    { method: "post", path: "/public/roadmap/vote", body: {} },
    { method: "post", path: "/public/roadmap/feedback", body: {} },
    { method: "get", path: "/public/kb" },
    { method: "post", path: "/public/kb/getting-started/feedback", body: {} },
    { method: "post", path: "/public/nps/sometoken", body: {} },
    { method: "get", path: "/public/careers/acme/jobs/not-a-number" },
    {
      method: "post",
      path: "/public/careers/acme/jobs/not-a-number/apply",
      body: {},
    },
    { method: "post", path: "/public/intake/not-a-number", body: {} },
  ];

  it.each(publicRoutes)(
    "does NOT require auth on $method $path",
    async (c: PublicCase) => {
      const res = await call(c);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    },
  );
});
