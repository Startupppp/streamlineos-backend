import { Controller, Get, Header, Param, Res } from "@nestjs/common";
import type { Response } from "express";

@Controller("public/kb/widget")
export class KbWidgetController {
  @Get(":orgId")
  getWidgetInfo(@Param("orgId") orgId: string) {
    return {
      orgId,
      url: `https://app.streamlineos.com/help/${orgId}`,
    };
  }

  @Get(":orgId/script")
  @Header("Content-Type", "application/javascript")
  getWidgetScript(@Param("orgId") orgId: string, @Res() res: Response) {
    const script = `(function(){
  var w=window;
  if(w.__slKb)return;
  w.__slKb=true;
  var base="https://app.streamlineos.com/help/${orgId}";
  var btn=document.createElement("button");
  btn.setAttribute("aria-label","Help");
  btn.style.cssText="position:fixed;bottom:24px;right:24px;z-index:9999;background:#4f46e5;color:#fff;border:none;border-radius:50%;width:52px;height:52px;font-size:22px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.2)";
  btn.textContent="?";
  btn.addEventListener("click",function(){window.open(base,"_blank","noopener,noreferrer");});
  document.body.appendChild(btn);
})();`;
    res.send(script);
  }
}
