import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { CrmMcpService, type McpContext } from "./crm-mcp.service";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { PartyService } from "../../party/party.service";
import { DealsService } from "../../deals/deals.service";
import { ActivitiesService } from "../../activities/activities.service";
import { ReportingService } from "../../reporting/reporting.service";
import { queryDescriptionSchema } from "../../reporting/dto/reporting.schemas";
import { REPORTING_REGISTRY, fieldsOf } from "../../reporting/compiler/registry";

describe("CrmMcpService", () => {
  let service: CrmMcpService;
  let accessService: { resolveUserPermissions: jest.Mock };
  let partyService: { listParties: jest.Mock; getParty: jest.Mock };
  let dealsService: { listDeals: jest.Mock; getDeal: jest.Mock };
  let activitiesService: { timeline: jest.Mock };
  let reportingService: { runAdHoc: jest.Mock };

  const context: McpContext = {
    userId: "usr_agent_123",
    orgId: "org_crm_test",
  };

  /**
   * What the resolver will answer, per key.
   *
   * `resolveUserPermissions` returns `Map<string, DataScope>` and says no by
   * answering `"none"`, not by omitting the key — so a test that wants a denial
   * can express either, and both are exercised below.
   */
  function grantScopes(entries: ReadonlyArray<[string, DataScope]>): void {
    accessService.resolveUserPermissions.mockResolvedValue(
      new Map<string, DataScope>(entries),
    );
  }

  beforeEach(async () => {
    accessService = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map<string, DataScope>()),
    };
    /*
     * Named for the methods these services actually have.
     *
     * They were `list`, `findOne` and `preview` — none of which exists on any of
     * the four. The handler probed for exactly those names and fell back when it
     * did not find them, so doubles shaped from the handler's imagination
     * satisfied the dead branch and the suite stayed green over six broken
     * tools. A double built from the caller rather than from the callee can only
     * ever confirm the caller. `the doubles are the real methods` below pins
     * these names to the real prototypes so they cannot drift again.
     */
    partyService = {
      listParties: jest.fn(),
      getParty: jest.fn(),
    };
    dealsService = {
      listDeals: jest.fn(),
      getDeal: jest.fn(),
    };
    activitiesService = {
      timeline: jest.fn(),
    };
    reportingService = {
      runAdHoc: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrmMcpService,
        { provide: AccessService, useValue: accessService },
        { provide: PartyService, useValue: partyService },
        { provide: DealsService, useValue: dealsService },
        { provide: ActivitiesService, useValue: activitiesService },
        { provide: ReportingService, useValue: reportingService },
      ],
    }).compile();

    service = module.get<CrmMcpService>(CrmMcpService);
  });

  describe("tool enumeration and boundaries", () => {
    it("exposes only CRM-owned tools, not payroll or inventory", () => {
      const toolNames = service.tools.map((t) => t.name);
      expect(toolNames).toContain("crm_list_parties");
      expect(toolNames).toContain("crm_get_party");
      expect(toolNames).toContain("crm_list_deals");
      expect(toolNames).toContain("crm_get_deal");
      expect(toolNames).toContain("crm_list_activities");
      expect(toolNames).toContain("crm_run_report");

      // Verify no payroll or inventory tools exist
      expect(toolNames.some((n) => n.includes("payroll"))).toBe(false);
      expect(toolNames.some((n) => n.includes("stock"))).toBe(false);
      expect(toolNames.some((n) => n.includes("inventory"))).toBe(false);
    });

    it("filters available tools based on the caller's actual permissions", async () => {
      // User only has deals read permission
      grantScopes([["crm:deals:read", "all"]]);

      const available = await service.getAvailableTools(context);
      const names = available.map((t) => t.name);

      expect(names).toEqual(["crm_list_deals", "crm_get_deal"]);
      expect(names).not.toContain("crm_list_parties");
      expect(names).not.toContain("crm_run_report");
    });
  });

  describe("tool execution and authorization", () => {
    it("allows deal listing when caller has crm:deals:read", async () => {
      grantScopes([["crm:deals:read", "all"]]);
      dealsService.listDeals.mockResolvedValue({
        items: [{ id: 1, name: "Big Enterprise Deal" }],
        total: 1,
      });

      const result = await service.executeTool(context, {
        name: "crm_list_deals",
        arguments: { limit: 20 },
      });

      expect(dealsService.listDeals).toHaveBeenCalledWith(
        "org_crm_test",
        "usr_agent_123",
        expect.objectContaining({ limit: 20 }),
        "all",
      );
      expect(result.content[0].text).toContain("Big Enterprise Deal");
    });

    it("refuses deal listing with 403 Forbidden when caller lacks crm:deals:read", async () => {
      grantScopes([["party:parties:view", "all"]]);

      await expect(
        service.executeTool(context, {
          name: "crm_list_deals",
          arguments: {},
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(dealsService.listDeals).not.toHaveBeenCalled();
    });

    /**
     * The resolver says no by returning `"none"`, not by leaving the key out.
     *
     * This check used to ask `resolved.has(key)`, which is true for a key
     * resolved to `"none"` — so a permission the resolver had explicitly denied
     * read as granted here, and only here: every `@RequirePermission` route goes
     * through `AccessService.holds`, which is `scopeFor(...) !== "none"`.
     */
    it("refuses a permission the resolver denied by scope rather than by absence", async () => {
      grantScopes([["crm:deals:read", "none"]]);

      await expect(
        service.executeTool(context, { name: "crm_list_deals", arguments: {} }),
      ).rejects.toThrow(ForbiddenException);

      expect(dealsService.listDeals).not.toHaveBeenCalled();
    });

    it("refuses party listing with 403 Forbidden when caller lacks party:parties:view", async () => {
      grantScopes([["crm:deals:read", "all"]]);

      await expect(
        service.executeTool(context, {
          name: "crm_list_parties",
          arguments: {},
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(partyService.listParties).not.toHaveBeenCalled();
    });

    it("throws NotFoundException on unknown tools", async () => {
      grantScopes([["*", "all"]]);

      await expect(
        service.executeTool(context, {
          name: "payroll_post_run",
          arguments: {},
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("executes crm_get_party with caller's orgId", async () => {
      grantScopes([["party:parties:view", "all"]]);
      partyService.getParty.mockResolvedValue({
        id: "pty_123",
        name: "Acme Corp",
      });

      const result = await service.executeTool(context, {
        name: "crm_get_party",
        arguments: { partyId: "pty_123" },
      });

      expect(partyService.getParty).toHaveBeenCalledWith("org_crm_test", "pty_123");
      expect(result.content[0].text).toContain("Acme Corp");
    });
  });

  /**
   * Every one of these fails against the version this replaces.
   *
   * The file cast all four services to `Record<string, Function>` and probed for
   * a `list`, a `findOne`, a `preview`. None exists, so only the fallbacks ran —
   * and the cast meant nothing checked what the fallbacks were passed. Six tools
   * disagreed with six services and it all compiled. These cases are written
   * against the real signatures, so they fail if the cast comes back.
   */
  describe("the arguments each tool actually sends", () => {
    it("sends the search term under the name the party service reads", async () => {
      grantScopes([["party:parties:view", "all"]]);
      partyService.listParties.mockResolvedValue({ data: [] });

      await service.executeTool(context, {
        name: "crm_list_parties",
        arguments: { search: "acme corp", limit: 20 },
      });

      /*
       * `search`, not `query`. The handler built `{ query: args.search }` and
       * both the schema and the service read `search`, so the term was dropped
       * and every agent search returned page one of the whole book.
       */
      expect(partyService.listParties).toHaveBeenCalledWith(
        "org_crm_test",
        expect.objectContaining({ search: "acme corp" }),
      );
    });

    it("refuses a missing partyId rather than looking up the string \"undefined\"", async () => {
      grantScopes([["party:parties:view", "all"]]);

      await expect(
        service.executeTool(context, { name: "crm_get_party", arguments: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);

      /*
       * The assertion that carries the finding. The old guard was
       * `String(args.partyId)` followed by a truthiness test, and
       * `String(undefined)` is `"undefined"` — truthy — so a missing id reached
       * the database as that literal string. Proving the throw would not show
       * that; proving the query was never built does.
       */
      expect(partyService.getParty).not.toHaveBeenCalled();
    });

    /**
     * The finding this branch was asked about, stated directly.
     *
     * `DealsService.getDeal` takes `(orgId, dealId)`. The call passed
     * `(orgId, userId, dealId, "global")`, so the second argument — the deal id
     * — received the caller's user id, and the two arguments after it went
     * nowhere. Under the probe's erased signature that compiled; typed, it does
     * not.
     */
    it("reads the deal by the id it was given, not by the caller's user id", async () => {
      grantScopes([["crm:deals:read", "all"]]);
      dealsService.getDeal.mockResolvedValue({ id: 412, name: "Renewal" });

      await service.executeTool(context, {
        name: "crm_get_deal",
        arguments: { dealId: 412 },
      });

      expect(dealsService.getDeal).toHaveBeenCalledWith("org_crm_test", 412);
      expect(dealsService.getDeal).not.toHaveBeenCalledWith(
        "org_crm_test",
        "usr_agent_123",
        expect.anything(),
        expect.anything(),
      );
    });

    /**
     * `Number.isNaN` was the whole guard, and it lets through everything a
     * `serial` primary key is not.
     *
     * `0`, `-3` and `1.5` are all numbers, so all three reached the database as
     * a deal id. A missing id was the only case it caught, which is why an
     * assertion on `{}` alone would pass against the version this replaces.
     */
    it.each([{}, { dealId: 0 }, { dealId: -3 }, { dealId: 1.5 }])(
      "refuses %p, which is not a deal id",
      async (args) => {
        grantScopes([["crm:deals:read", "all"]]);

        await expect(
          service.executeTool(context, { name: "crm_get_deal", arguments: args }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(dealsService.getDeal).not.toHaveBeenCalled();
      },
    );

    /**
     * `"global"` is not a `DataScope`.
     *
     * `applyScope` is exhaustive over the four members and emits a `false`
     * predicate for anything else, so passing the literal made `crm_list_deals`
     * answer every agent with an empty list — indistinguishable from an
     * organisation that has no deals. The scope the resolver actually returned
     * is what goes down now.
     */
    it("passes the caller's resolved DataScope to the deals list", async () => {
      grantScopes([["crm:deals:read", "own"]]);
      dealsService.listDeals.mockResolvedValue({ items: [], total: 0 });

      await service.executeTool(context, { name: "crm_list_deals", arguments: {} });

      const [, , , scope] = dealsService.listDeals.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
        string,
      ];
      expect(scope).toBe("own");
      expect(scope).not.toBe("global");
    });

    it("sends the deals filters the input type actually has", async () => {
      grantScopes([["crm:deals:read", "all"]]);
      dealsService.listDeals.mockResolvedValue({ items: [], total: 0 });

      await service.executeTool(context, {
        name: "crm_list_deals",
        arguments: { stage: "negotiation", offset: 40, limit: 10 },
      });

      const [, , query] = dealsService.listDeals.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
        string,
      ];
      expect(query).toMatchObject({ stage: "negotiation", offset: 40, limit: 10 });
      /* `page`, `pipelineId` and `stageId` are not fields of `ListDealsInput`; paging was impossible. */
      expect(query).not.toHaveProperty("page");
      expect(query).not.toHaveProperty("pipelineId");
      expect(query).not.toHaveProperty("stageId");
    });

    it("refuses an unanchored timeline instead of returning an empty page", async () => {
      grantScopes([["crm:activities:view", "all"]]);

      await expect(
        service.executeTool(context, { name: "crm_list_activities", arguments: {} }),
      ).rejects.toBeTruthy();

      /*
       * Without an anchor the service falls to `subject_id = ''`, which matches
       * nothing — so the old handler answered "this deal has no activity" to a
       * question nobody had asked about a deal. Again the assertion is that no
       * query was built, because an empty result and a refused call look
       * identical from the return value.
       */
      expect(activitiesService.timeline).not.toHaveBeenCalled();
    });

    it("pages the timeline on a cursor, which is how the timeline pages", async () => {
      grantScopes([["crm:activities:view", "all"]]);
      activitiesService.timeline.mockResolvedValue({ data: [], nextCursor: null });

      await service.executeTool(context, {
        name: "crm_list_activities",
        arguments: { dealId: 42, cursor: "c_abc", limit: 10 },
      });

      const [, query] = activitiesService.timeline.mock.calls[0] as [string, Record<string, unknown>];
      expect(query).toMatchObject({ dealId: 42, cursor: "c_abc", limit: 10 });
      /* `page` meant nothing to a keyset timeline; it silently pinned every call to page one. */
      expect(query).not.toHaveProperty("page");
    });

    it("builds a report description the reporting compiler would accept", async () => {
      grantScopes([["crm:reports:view", "all"]]);
      reportingService.runAdHoc.mockResolvedValue({ columns: [], rows: [], rowCount: 0 });

      await service.executeTool(context, {
        name: "crm_run_report",
        arguments: { source: "deals" },
      });

      const [, , description] = reportingService.runAdHoc.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];

      /*
       * Three independent errors lived here, under one erased signature:
       * `fields` where the description takes `select`, field names belonging to
       * no source, and no `limit` at all — which the schema requires and the
       * compiler refuses without. Every call to this tool 400ed, always had, and
       * no test noticed because the double was named `preview`, a method that
       * does not exist.
       *
       * Parsing under the real schema catches the shape; resolving each field
       * against the real registry catches the names. Asserting `select` is
       * merely non-empty would have passed on `["id", "name", "value"]`.
       */
      expect(() => queryDescriptionSchema.parse(description)).not.toThrow();

      const source = REPORTING_REGISTRY.get(String(description.source));
      expect(source).toBeDefined();
      const known = fieldsOf(source!);
      const projected = (description.select as { kind: string; field: string }[]).map((p) => p.field);
      expect(projected.length).toBeGreaterThan(0);
      for (const field of projected) expect(known.has(field)).toBe(true);
    });

    it("refuses a report source that is not in the registry", async () => {
      grantScopes([["crm:reports:view", "all"]]);

      await expect(
        service.executeTool(context, {
          name: "crm_run_report",
          arguments: { source: "payroll_runs" },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(reportingService.runAdHoc).not.toHaveBeenCalled();
    });

    /**
     * A source is a caller-supplied string, so it is looked up in a `Map`.
     *
     * `REPORTING_REGISTRY` is a `Map` for exactly this reason and says so: a
     * plain object reaches the prototype, so `"__proto__"` returns
     * `Object.prototype` and `"constructor"` a function — both truthy, so a
     * `if (!select)` guard treats them as a source that was found. Zod refused
     * the description a step later either way, so nothing was ever compiled from
     * them; the answer was a shape error rather than the list of real sources.
     */
    it.each(["__proto__", "constructor", "toString"])(
      "refuses the prototype name %p as a report source",
      async (source) => {
        grantScopes([["crm:reports:view", "all"]]);

        await expect(
          service.executeTool(context, { name: "crm_run_report", arguments: { source } }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(reportingService.runAdHoc).not.toHaveBeenCalled();
      },
    );

    it("names the real sources when it refuses an unknown one", async () => {
      grantScopes([["crm:reports:view", "all"]]);

      await expect(
        service.executeTool(context, {
          name: "crm_run_report",
          arguments: { source: "__proto__" },
        }),
      ).rejects.toThrow(/parties, deals, activities/);
    });
  });

  /**
   * The guard that stops the whole class coming back.
   *
   * The doubles in this file were named for methods none of these services has.
   * A double shaped from the caller can only ever confirm the caller, so the
   * suite was green across six broken tools. Pinning the names to the real
   * prototypes means a rename breaks this file rather than production.
   */
  describe("the doubles are the real methods", () => {
    const REAL: ReadonlyArray<[string, { prototype: object }, readonly string[]]> = [
      ["PartyService", PartyService, ["listParties", "getParty"]],
      ["DealsService", DealsService, ["listDeals", "getDeal"]],
      ["ActivitiesService", ActivitiesService, ["timeline"]],
      ["ReportingService", ReportingService, ["runAdHoc"]],
    ];

    it.each(REAL)("%s really has the methods this file doubles", (_label, ctor, methods) => {
      const own = Object.getOwnPropertyNames(ctor.prototype);
      for (const method of methods) expect(own).toContain(method);
    });

    it("and does not have the names the handler used to probe for", () => {
      /*
       * States the defect rather than the fix. `list`, `findOne` and `preview`
       * were the first branch of every probe; because none of them exists, every
       * first branch was unreachable and the fallback beneath it was the only
       * code that ever ran.
       */
      expect(Object.getOwnPropertyNames(PartyService.prototype)).not.toContain("list");
      expect(Object.getOwnPropertyNames(PartyService.prototype)).not.toContain("findOne");
      expect(Object.getOwnPropertyNames(DealsService.prototype)).not.toContain("list");
      expect(Object.getOwnPropertyNames(DealsService.prototype)).not.toContain("findOne");
      expect(Object.getOwnPropertyNames(ActivitiesService.prototype)).not.toContain("list");
      expect(Object.getOwnPropertyNames(ReportingService.prototype)).not.toContain("preview");
    });
  });

  /**
   * What a tool advertises must be something it reads.
   *
   * `crm_list_parties` offered agents a `standing` filter and `crm_run_report` a
   * `reportKey`; nothing read either. `crm_list_deals` offered `pipelineId` and
   * `stageId` against an input type that has neither. A caller who filters a
   * list and receives the unfiltered list back cannot tell that it happened —
   * which makes an advertised-and-ignored parameter worse than a missing one.
   *
   * Read off the source rather than by calling, because a handler that ignores a
   * property cannot be made to reveal that by any argument you pass it.
   */
  describe("every advertised input is read by its handler", () => {
    const source = readFileSync(join(__dirname, "crm-mcp.service.ts"), "utf8");

    /*
     * Comments are stripped first, and that is not fastidiousness. The handlers
     * carry a docblock naming `args.partyId`, `page` and `pipelineId` while
     * explaining what went wrong with them — so a search over raw text would
     * match this file's own explanation of the bug and report it fixed.
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    function handlerBody(tool: string): string {
      const start = code.indexOf(`case "${tool}":`);
      expect(start).toBeGreaterThan(-1);
      const rest = code.slice(start + tool.length + 8);
      const next = rest.search(/\n {6}(?:case "|default:)/);
      return next === -1 ? rest : rest.slice(0, next);
    }

    /*
     * The catalogue is read off the service the module built, not off a
     * hand-constructed one: a spec that constructs the class by hand breaks
     * every time that class gains a dependency, and it would be asserting
     * against a second definition of the catalogue.
     *
     * One `it` rather than `it.each`, because `it.each` needs its table when the
     * describe is defined and `service` does not exist until `beforeEach`.
     */
    it("reads every property it declares, for every tool", () => {
      expect(service.tools.length).toBeGreaterThanOrEqual(6);

      const unread: string[] = [];
      for (const tool of service.tools) {
        const body = handlerBody(tool.name);
        for (const prop of Object.keys(tool.inputSchema.properties))
          if (!body.includes(`args.${prop}`)) unread.push(`${tool.name}.${prop}`);
      }

      /* Named, so a failure says which parameter is a lie rather than just failing. */
      expect(unread).toEqual([]);
    });
  });
});
