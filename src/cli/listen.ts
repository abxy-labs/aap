import type { Aap } from "../sdk/index.ts";

/** Receive webhook deliveries from the API on a local port and forward them to the developer's app. */
export async function listen(aap: Aap, forwardTo: string, events: string[]): Promise<void> {
  const target = forwardTo.startsWith("http") ? forwardTo : `http://${forwardTo}`;
  let endpointId: string | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.text();
      const sig = req.headers.get("aap-signature") ?? "";
      let type = "?";
      let id = "?";
      try {
        const evt = JSON.parse(body) as { type: string; id: string };
        type = evt.type;
        id = evt.id;
      } catch {
        // forward anyway
      }
      console.log(`${stamp()}  --> ${type} [${id}]`);
      try {
        const res = await fetch(target, { method: "POST", headers: { "content-type": "application/json", "aap-signature": sig, "aap-event-id": id }, body, signal: AbortSignal.timeout(10000) });
        console.log(`${stamp()}  <-- [${res.status}] POST ${target} [${id}]`);
      } catch (e) {
        console.log(`${stamp()}  <-- [error] POST ${target} [${id}] ${e instanceof Error ? e.message : String(e)}`);
      }
      return new Response("ok");
    },
  });
  const endpoint = await aap.webhookEndpoints.create({ url: `http://127.0.0.1:${server.port}/`, enabled_events: events, description: "aap listen" });
  endpointId = endpoint.id;
  console.log(`> Ready! You are using the ${aap.livemode ? "live" : "test"} mode. Your webhook signing secret is ${endpoint.secret} (^C to quit)`);
  console.log(`> Forwarding ${events.join(", ")} to ${target}`);
  const cleanup = async () => {
    if (endpointId) {
      try {
        await aap.webhookEndpoints.del(endpointId);
      } catch {
        // best effort
      }
      endpointId = null;
    }
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());
  await new Promise(() => undefined);
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}
