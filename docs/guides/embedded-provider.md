# Integrate an embedded provider

This guide is for a provider whose product runs inside other companies' flows: a bank connection widget, an identity verification step, a payment form, or any component that a host site places in an iframe or opens in a popup. The provider runs the Foil SDK on its own origin, and an agent that is driving the host's page arrives in the provider's frame partway through a task. This guide covers how the protocol evaluates that frame, what policy a provider typically sets, how to apply per-host decisions, how disclosures work when two parties have them, and what happens at a third origin such as a bank's sign-in page. When you finish, agents in your frame are on the agent plane under your own policy, whether or not the host participates.

The guide assumes you have read [Integrate a site](site.md), since a provider is a site with respect to its own origin. Everything in that guide applies to your frame. This guide covers only what is different.

## How your frame is evaluated

The protocol evaluates each participating origin separately, under that origin's own policy, using one grant for the whole browser session. When your frame loads, your SDK sends telemetry from your origin, and if your policy admits agents, the response carries a challenge bound to your origin. The operator's browser answers it on your frame's telemetry with the same grant it is using for the host page. Foil verifies the chain against your policy and binds the session in your frame.

Three consequences follow.

- **The host's status does not matter.** If the host does not run Foil, or runs it without admitting agents, the agent presents nothing to the host and your frame is still evaluated under your policy. If the host does admit agents, the host's frame is evaluated under the host's policy and yours under yours, independently.
- **Your policy is the only policy that governs your frame.** The host cannot widen or narrow what an agent may do inside your component.
- **Your verification response is about your session.** When your server calls `GET /v1/sessions/{id}` for the session in your frame, it reads your policy's result, with the scopes your policy allowed and the evidence your policy required.

## Step 1: Decide what an agent may do in your frame

Most embedded components have a small number of steps, and the useful policy question is which steps an agent may perform and which the consumer must perform. For a bank connection widget the steps are usually selecting an institution, entering credentials or completing the institution's sign-in, and selecting which accounts to share. For an identity verification step they are entering details and presenting a document. The pattern that fits most providers is to admit agents to the steps that gather and select information and to require the consumer for the step that authenticates or attests.

Map each step to the nearest scope in the vocabulary and mark the consumer's steps for handoff.

| Step | Scope | Handoff |
| --- | --- | --- |
| Select an institution | `public:read` | No |
| Enter credentials or complete the institution's sign-in | `accounts:read`, marked for handoff | Yes |
| Select accounts to share | `accounts:read` | No |
| Confirm data-sharing terms | Gated by your disclosure bundle | Per bundle |

A step marked for handoff is one the agent may reach but not complete. The agent brings the consumer to it, the consumer completes it from their own device, and the session continues. For a credential step this is the correct design regardless of what the host allows: an agent should never hold the consumer's credentials for an institution, and a handoff is how the protocol expresses that.

## Step 2: Set your policy

Configure your policy as described in [Integrate a site](site.md), for your origin. A typical starting policy for an embedded provider is the following.

- Tier ceiling: read.
- Admitted agents: all vetted operators, with a deny list for exceptions.
- Handoff scopes: the scope you assigned to the credential or attestation step.
- Evidence for read: asserted.
- Disclosure bundle: your own data-sharing authorization, with `presentation: app` if you are willing to have it presented by the agent's application, or `presentation: site` if it must be completed in your frame.
- Disclosure of operator and agent names: enabled, so your fraud team can see them.

Observed evidence deserves a note. Observed evidence is a link to a live session at your origin for the same consumer. In most embedded flows the consumer has no prior session with you, so a delegation for your origin will usually carry asserted evidence only. Set evidence requirements accordingly: asserted for the steps you admit, and handoff for the step that needs the consumer. Do not require observed evidence for read tier in a frame the consumer has never visited on their own.

## Step 3: Apply per-host decisions

Your policy at Foil is one policy for your origin. Your own logic can be finer. You know which host a session belongs to, because your component is initialized with a token or a configuration that identifies the host, and the verification response tells you the session is on the agent plane and which agent it is. Combine the two on your server.

```ts
const session = await foil.sessions.get(sessionId);
const host = hostFor(componentToken);

if (session.decision.plane === "agent") {
  if (!host.settings.allowAgents) return deny("host_does_not_allow_agents");
  if (host.settings.agentTierCeiling === "observe" && scope !== "public:read") return deny("above_host_ceiling");
}
```

This lets you offer agent support as a per-host setting, admit agents only for hosts that have opted in with you, or apply different ceilings for different hosts, without any of that being visible to the protocol. Foil provides the plane, the agent, and the scopes under your policy. What you do with them per host is yours.

## Step 4: Handle disclosures when two parties have them

The host may have a disclosure bundle for its origin, and you may have one for yours. They are separate bundles on separate origins, and the agent's application presents each as part of the terms for that origin. A consumer who authorizes an agent at a host and at your component accepts two sets of terms, each recorded in its own delegation.

If your bundle is marked `presentation: app`, the application presents it in the consumer's channel and the acceptance is recorded in the delegation for your origin. If it is marked `presentation: site`, the consumer completes it in your frame, from their own device, and the agent is handed off at that step. Choose based on whether your compliance team is willing to have your data-sharing authorization collected through a third party's interface. Many providers will start with `site` and move to `app` once they have seen the acceptance records.

## Step 5: Understand the third origin

A bank connection widget usually opens the institution's own sign-in page in a popup. That page is a third origin, and it is evaluated on its own terms.

- If the institution runs Foil and admits agents, the popup's telemetry carries a challenge for the institution's origin, the operator answers it with the same grant, and the institution's policy governs. Most institutions will mark sign-in for handoff, which means the consumer signs in from their own device.
- If the institution does not run Foil, the agent presents nothing to it. The institution sees a sign-in from a datacenter and applies whatever controls it has.

In both cases the design that works is the one from Step 1: the agent reaches the sign-in step and the consumer completes it. Your handoff at the credential step is what brings the consumer to the popup on their own device, where the institution sees its own customer.

## Step 6: Read your verification response

Your server reads the same response a site reads, for the session in your frame. The `scopes` are the ones your policy allowed. The `delegation` block is the delegation for your origin, with its own record. The `handoff` field is set when the agent has reached one of your handoff steps.

```json
{
  "decision": { "verdict": "allow", "plane": "agent" },
  "agent": {
    "id": "ag_9c4e",
    "operator": "op_7a1d",
    "grant": "g_71c",
    "scopes": ["public:read", "accounts:read"],
    "scopes_used": ["public:read"],
    "delegation": { "id": "dl_8e2", "asserted": { "terms": "t_c41", "acknowledged": ["share"], "channel": "web" }, "observed": null },
    "handoff": "accounts:read"
  }
}
```

When `handoff` is set, your frame should behave as it does for any consumer who has reached that step. When the consumer completes it, report the completion so the record reflects it.

## What the host sees

Nothing from your frame. The host's own frame is evaluated under the host's policy if the host participates, and not at all if it does not. Your verification responses, your delegation records, and your policy are yours. A host that wants to know whether agents are being admitted inside your component learns that from you, through whatever reporting you already provide, not from the protocol.

## Test it locally

The `aap` command in the reference implementation can hold two policies at once. Set one for a host origin and one for your origin, create a delegation for each, and verify the same session against both. The following assumes the store, keys, and operator certificate from the [command reference](../cli.md), and issues an agent whose ceiling includes the observe-tier scope used for institution selection.

```
aap agent issue --operator-cert operator.cert --operator-key operator.key.json --id ag_link --name link-agent \
    --key agent.key.json --scopes public:read,accounts:read --out agent.cert
aap policy set --origin host.example --tier read --evidence read=asserted
aap policy set --origin widget.example --tier read --evidence read=asserted --handoff accounts:read --disclose operator,agent
aap terms --agent-cert agent.cert --origin widget.example --scopes public:read,accounts:read
aap delegation create --agent-cert agent.cert --operator-cert operator.cert --agent-key agent.key.json \
    --origin widget.example --subject usr_1 --scopes public:read,accounts:read --intent "Connect a bank" \
    --acceptance acceptance.json --out widget-delegation.cert
aap challenge --origin widget.example --out widget-challenge.jwt
aap grant sign --agent-key agent.key.json --agent-cert agent.cert --delegation widget-delegation.cert \
    --session-ref sess_1 --intent "Connect a bank" --challenge widget-challenge.jwt --out widget-grant.jwt
aap present --grant widget-grant.jwt --delegation widget-delegation.cert --agent-cert agent.cert --operator-cert operator.cert --out widget-header.txt
aap verify --header-file widget-header.txt --origin widget.example --session fs_widget
aap session use fs_widget --scope public:read
aap session use fs_widget --scope accounts:read
```

The last command prints the handoff header, and `aap site session fs_widget` shows the `handoff` field set. Setting the host origin's tier to `none` and repeating the sequence for the host shows that the host frame receives no challenge while your frame is unaffected.

## Common mistakes

- **Expecting the host's policy to apply in your frame.** It does not. Your origin, your policy.
- **Requiring observed evidence in a frame the consumer has never visited.** There is no session to link. Use asserted evidence for the steps you admit and a handoff for the step that needs the consumer.
- **Admitting the credential step.** Mark it for handoff. An agent should not hold an institution's credentials, and the institution will not admit a datacenter sign-in anyway.
- **Blocking agents in your frame without a policy.** Without a policy, an agent in your frame is a bot, the host's task fails inside your component, and the host attributes the failure to you. A read-tier policy with a handoff at the credential step admits the agent to the steps it can do and brings the consumer in for the rest.
- **Looking for the host's delegation in your response.** Your response carries the delegation for your origin. The host's delegation is in the host's response.
