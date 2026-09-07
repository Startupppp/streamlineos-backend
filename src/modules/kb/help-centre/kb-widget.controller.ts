import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiOkResponse } from "@nestjs/swagger";
import { Public } from "../../../common/auth/public.decorator";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { kbWidgetConfigSchema } from "./dto/kb-helpcenter-response.schemas";
import { z } from "zod";

const orgIdParams = z.object({ orgId: z.string().min(1) }).strict();

@Public()
@Controller("public/kb/widget")
export class KbWidgetController {
  constructor(
    @Inject(APP_CONFIG) private readonly appConfig: Pick<AppConfig, "APP_URL">,
  ) {}

  private get appUrl(): string {
    return this.appConfig.APP_URL.replace(/\/$/, "");
  }

  @Get(":orgId")
  @Validate({ params: orgIdParams })
  @ResponseSchema(kbWidgetConfigSchema)
  config(@Param("orgId") orgId: string): {
    orgId: string;
    helpCenterUrl: string;
    buttonLabel: string;
    primaryColor: string;
    position: string;
  } {
    return {
      orgId,
      helpCenterUrl: `${this.appUrl}/help/${orgId}`,
      buttonLabel: "Help",
      primaryColor: "#6366f1",
      position: "bottom-right",
    };
  }

  @Get(":orgId/script")
  @Validate({ params: orgIdParams })
  @ApiOkResponse({ schema: { type: "string" } })
  script(@Param("orgId") orgId: string, @Res() res: Response): void {
    const helpUrl = `${this.appUrl}/help/${encodeURIComponent(orgId)}`;
    const snippet = `(function () {
  if (document.getElementById('sleos-help-widget')) return;
  var btn = document.createElement('button');
  btn.id = 'sleos-help-widget';
  btn.textContent = 'Help';
  btn.setAttribute('aria-label', 'Open help center');
  btn.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'right:24px',
    'z-index:9999',
    'background:#6366f1',
    'color:#fff',
    'border:none',
    'border-radius:9999px',
    'padding:10px 20px',
    'font-size:14px',
    'font-weight:600',
    'cursor:pointer',
    'box-shadow:0 4px 14px rgba(99,102,241,0.4)',
    'transition:transform 0.15s ease,box-shadow 0.15s ease',
    'font-family:system-ui,sans-serif',
  ].join(';');
  btn.addEventListener('mouseover', function () {
    btn.style.transform = 'scale(1.05)';
    btn.style.boxShadow = '0 6px 20px rgba(99,102,241,0.5)';
  });
  btn.addEventListener('mouseout', function () {
    btn.style.transform = 'scale(1)';
    btn.style.boxShadow = '0 4px 14px rgba(99,102,241,0.4)';
  });
  btn.addEventListener('click', function () {
    window.open(${JSON.stringify(helpUrl)}, '_blank', 'noopener,noreferrer');
  });
  document.body.appendChild(btn);
})();`;

    res.type("application/javascript").send(snippet);
  }
}
