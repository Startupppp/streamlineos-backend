import { PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import {
  classifyHandler,
  describeExposure,
  recordRouteClassification,
} from "./record-route-classification";
import { Public } from "./public.decorator";
import { Universal } from "./universal.decorator";
import { AuthorizedInService } from "./authorized-in-service.decorator";
import { RequirePermission } from "../../modules/access/require-permission.decorator";

class MixedController {
  @Public()
  openRoute(): void {}

  @Universal()
  memberRoute(): void {}

  @RequirePermission("settings:rbac:manage")
  gatedRoute(): void {}

  @AuthorizedInService("assertModuleAccessPolicy")
  standingRoute(): void {}

  undeclaredRoute(): void {}

  notARoute(): void {}
}
for (const name of [
  "openRoute",
  "memberRoute",
  "gatedRoute",
  "standingRoute",
  "undeclaredRoute",
]) {
  Reflect.defineMetadata(
    PATH_METADATA,
    name,
    Reflect.get(MixedController.prototype, name) as object,
  );
}

/** A class-level declaration must reach every handler that carries none itself. */
@AuthorizedInService("PortalJwtAuthGuard")
class PortalStyleController {
  inherits(): void {}
}
Reflect.defineMetadata(PATH_METADATA, "inherits", PortalStyleController.prototype.inherits);

function appWith(instances: object[]): INestApplication {
  const discovery = {
    getControllers: () => instances.map((instance) => ({ instance })),
  } as unknown as DiscoveryService;
  const scanner = new MetadataScanner();
  return {
    get: (token: unknown) => (token === DiscoveryService ? discovery : scanner),
  } as unknown as INestApplication;
}

interface TestOperation {
  operationId: string;
  description?: string;
  "x-exposure"?: string;
}

const documentFor = (
  operationIds: string[],
): { paths: Record<string, { get: TestOperation }> } => ({
  paths: Object.fromEntries(
    operationIds.map((operationId, i) => [`/p${i}`, { get: { operationId } }]),
  ),
});

describe("classifyHandler", () => {
  const proto = MixedController.prototype;
  const at = (name: keyof MixedController) =>
    classifyHandler(Reflect.get(proto, name) as object, MixedController);

  it("reads each of the four declarations", () => {
    expect(at("openRoute")).toEqual({ mode: "public" });
    expect(at("memberRoute")).toEqual({ mode: "universal" });
    expect(at("gatedRoute")).toEqual({
      mode: "permissioned",
      permission: "settings:rbac:manage",
    });
    expect(at("standingRoute")).toEqual({
      mode: "in-service",
      by: "assertModuleAccessPolicy",
    });
  });

  it("reports absence rather than guessing", () => {
    expect(at("undeclaredRoute")).toEqual({ mode: "undeclared" });
  });

  it("falls back to the class declaration", () => {
    expect(
      classifyHandler(PortalStyleController.prototype.inherits, PortalStyleController),
    ).toEqual({ mode: "in-service", by: "PortalJwtAuthGuard" });
  });

  it("agrees with the guard that an empty in-service name is not a declaration", () => {
    @AuthorizedInService("")
    class Unnamed {
      route(): void {}
    }
    expect(classifyHandler(Unnamed.prototype.route, Unnamed)).toEqual({ mode: "undeclared" });
  });
});

describe("recordRouteClassification", () => {
  it("stamps every operation whose handler it can find", () => {
    const document = documentFor([
      "MixedController_openRoute",
      "MixedController_gatedRoute",
      "MixedController_standingRoute",
    ]);
    const result = recordRouteClassification(appWith([new MixedController()]), document);

    expect(result).toEqual({ stamped: 3, undeclared: 0 });
    expect(document.paths["/p0"].get).toMatchObject({ "x-exposure": "public" });
    expect(document.paths["/p1"].get).toMatchObject({
      "x-exposure": "permissioned",
      "x-permission": "settings:rbac:manage",
    });
    expect(document.paths["/p2"].get).toMatchObject({
      "x-exposure": "in-service",
      "x-authorized-in-service": "assertModuleAccessPolicy",
    });
  });

  it("records an undeclared route as undeclared rather than omitting it", () => {
    const document = documentFor(["MixedController_undeclaredRoute"]);
    const result = recordRouteClassification(appWith([new MixedController()]), document);

    expect(result).toEqual({ stamped: 1, undeclared: 1 });
    expect(document.paths["/p0"].get).toMatchObject({ "x-exposure": "undeclared" });
    expect(document.paths["/p0"].get.description ?? "").toContain("UNDECLARED");
  });

  it("ignores a method that carries no route metadata", () => {
    const document = documentFor(["MixedController_notARoute"]);
    expect(recordRouteClassification(appWith([new MixedController()]), document)).toEqual({
      stamped: 0,
      undeclared: 0,
    });
  });

  it("appends to an existing description instead of replacing it", () => {
    const document = documentFor(["MixedController_memberRoute"]);
    document.paths["/p0"].get = {
      operationId: "MixedController_memberRoute",
      description: "Returns the caller's own profile.",
    };
    recordRouteClassification(appWith([new MixedController()]), document);
    const description = document.paths["/p0"].get.description ?? "";
    expect(description).toContain("Returns the caller's own profile.");
    expect(description).toContain("universal");
  });
});

/**
 * The stamping joins on `operationId`, which nothing in our code produces —
 * Nest's own operationIdFactory does. If that format is not
 * `Controller_method`, every lookup misses, `stamped` is 0 and the feature lands
 * inert while every unit test above still passes. So build a real document.
 */
describe("against a real Nest application and a real OpenAPI document", () => {
  it("stamps operations produced by SwaggerModule.createDocument", async () => {
    const { Controller, Get } = await import("@nestjs/common");
    const { Test } = await import("@nestjs/testing");
    const { DiscoveryModule } = await import("@nestjs/core");
    const { SwaggerModule, DocumentBuilder } = await import("@nestjs/swagger");

    @Controller("widgets")
    class WidgetsController {
      @Get("open")
      @Public()
      open(): string {
        return "";
      }

      @Get("gated")
      @RequirePermission("crm:leads:view")
      gated(): string {
        return "";
      }

      @Get("forgotten")
      forgotten(): string {
        return "";
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [WidgetsController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("t").setVersion("1").build(),
      );
      const result = recordRouteClassification(app, document);

      expect(result.stamped).toBe(3);
      expect(result.undeclared).toBe(1);

      const operations = Object.values(document.paths).flatMap((methods) =>
        Object.values(methods as Record<string, { "x-exposure"?: string }>),
      );
      expect(operations.map((o) => o["x-exposure"]).sort()).toEqual([
        "permissioned",
        "public",
        "undeclared",
      ]);
    } finally {
      await app.close();
    }
  });
});

describe("describeExposure", () => {
  it("names the key on a permissioned route, so the document is actionable", () => {
    expect(describeExposure({ mode: "permissioned", permission: "hr:employees:view" })).toContain(
      "hr:employees:view",
    );
  });

  it("names the checker on an in-service route", () => {
    expect(describeExposure({ mode: "in-service", by: "assertModuleAccessPolicy" })).toContain(
      "assertModuleAccessPolicy",
    );
  });
});
