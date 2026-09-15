import { directory } from "../../lib/directory.ts";
import { requireType } from "../auth.ts";
import type { Router } from "../router.ts";

export function directoryRoutes(r: Router): void {
  r.add("GET", "/v1/directory", async (ctx) => {
    requireType(ctx.principal!, "operator");
    return directory(ctx.store);
  });
}
