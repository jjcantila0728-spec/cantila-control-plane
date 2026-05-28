/* ============================================================
   CapacityAgent — watches the fleet's headroom (plan §4.9 —
   "Pre-warms additional nodes ahead of saturation").

   Reasons over `cp.getFleetCapacity()` (synthesised platform fleet
   + active BYO nodes) AND over the per-account BYO node list for
   lifecycle health (plan §5.5 — Bring-Your-Own-VPS):
     - Hot node           → loadPct ≥ HOT_LOAD_PCT  (75%)
     - Saturated node     → loadPct ≥ SATURATED_LOAD_PCT (90%)
     - Imbalanced region  → one region holds ≥ REGION_IMBALANCE_PCT
       (70%) of fleet instances while others sit idle
     - Under-utilised     → totals.loadPct < UNDER_UTILISED_PCT (25%)
     - BYO node offline   → a tenant-supplied node stopped heartbeating
     - BYO node stale     → offline for ≥ NODE_STALE_THRESHOLD (24 h)

   All proposals are DESTRUCTIVE — provisioning, rebalancing,
   reclaiming a node or retiring a tenant's row costs money and/or
   reshuffles traffic. Per §4.9 safety they queue for review;
   CapacityAgent never auto-applies in v1. Hints carry the natural
   follow-on commands so an operator can act without leaving the
   activity feed.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { id as makeId, now } from "../lib/ids";
import type { Agent, Observation, Proposal } from "./types";

const ACCOUNT = "acc_demo";
const HOT_LOAD_PCT = 75;
const SATURATED_LOAD_PCT = 90;
const REGION_IMBALANCE_PCT = 70;
const UNDER_UTILISED_PCT = 25;
/** Don't flag under-utilisation until the fleet actually carries some load —
 *  a clean dev instance with zero instances scheduled is not interesting. */
const MIN_INSTANCES_FOR_UNDER_FLAG = 4;

export class CapacityAgent implements Agent {
  readonly name = "capacity" as const;

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const fleet = await cp.getFleetCapacity();
    const out: Observation[] = [];

    for (const node of fleet.nodes) {
      if (node.loadPct >= SATURATED_LOAD_PCT) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "node_saturated",
          detail: `${node.nodeId} at ${node.loadPct}% (${node.instances}/${node.capacity} instances)`,
        });
      } else if (node.loadPct >= HOT_LOAD_PCT) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "node_hot",
          detail: `${node.nodeId} at ${node.loadPct}% (${node.instances}/${node.capacity} instances)`,
        });
      }
    }

    if (fleet.totals.instances > 0) {
      for (const region of fleet.regions) {
        const share = fleet.totals.instances
          ? Math.round((region.instances / fleet.totals.instances) * 100)
          : 0;
        if (
          share >= REGION_IMBALANCE_PCT &&
          fleet.regions.length > 1
        ) {
          out.push({
            at: now(),
            agent: this.name,
            kind: "region_imbalance",
            detail: `${region.region} holds ${share}% of fleet instances (${region.instances}/${fleet.totals.instances})`,
          });
        }
      }
    }

    if (
      fleet.totals.instances >= MIN_INSTANCES_FOR_UNDER_FLAG &&
      fleet.totals.loadPct < UNDER_UTILISED_PCT
    ) {
      out.push({
        at: now(),
        agent: this.name,
        kind: "fleet_under_utilised",
        detail: `Fleet at ${fleet.totals.loadPct}% — ${fleet.totals.instances} instances across ${fleet.totals.nodes} nodes`,
      });
    }

    // BYO node lifecycle observations (plan §5.5). A heartbeat sweep on
    // the control plane already flipped the row to `offline`; the brain
    // surfaces it as an observation so the operator sees it in the
    // agent feed alongside platform-fleet signals.
    const byo = (await cp.listAccountNodes(ACCOUNT)).filter(
      (n) => n.kind === "byo",
    );
    for (const node of byo) {
      if (node.status === "offline") {
        const stale = cp.isStaleByoNode(node);
        out.push({
          at: now(),
          agent: this.name,
          kind: stale ? "byo_node_stale" : "byo_node_offline",
          detail: stale
            ? `${node.label} offline since ${node.lastHeartbeatAt ?? "?"} (${hoursAgo(node.lastHeartbeatAt)}h)`
            : `${node.label} (${node.id}) stopped heartbeating`,
        });
      }
    }

    return out;
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const fleet = await cp.getFleetCapacity();
    const out: Proposal[] = [];

    // 1. Saturated or hot node → propose pre-warming a sibling. The brain
    //    can't actually provision; this is queued so the operator confirms
    //    spend before a node spins up.
    const hot = fleet.nodes.filter((n) => n.loadPct >= HOT_LOAD_PCT);
    for (const node of hot) {
      const saturated = node.loadPct >= SATURATED_LOAD_PCT;
      out.push({
        id: `prop_${makeId("cap").slice(3)}_warm_${node.nodeId}`,
        at: now(),
        agent: this.name,
        kind: "pre_warm_node",
        title: saturated
          ? `Pre-warm a sibling for ${node.nodeId} — node at ${node.loadPct}%`
          : `Pre-warm a sibling for ${node.nodeId} — node at ${node.loadPct}%`,
        body: saturated
          ? `${node.nodeId} is carrying ${node.instances}/${node.capacity} instances (${node.loadPct}%). New deploys to ${node.region} will land on it and the next blue/green swap won't have a hot spare. Provision one more node in ${node.region} so traffic has somewhere to spill before the next scale-up.`
          : `${node.nodeId} is at ${node.loadPct}% (${node.instances}/${node.capacity}). It's not saturated yet but headroom is thin — bringing up one more node in ${node.region} now is cheaper than racing capacity during an incident.`,
        confidence: saturated ? "high" : "medium",
        actionClass: "destructive",
        hints: [
          {
            label: "Provision a node",
            hint: `# in your fleet IaC\nterraform apply -target=hcloud_server.${node.region}_${(fleet.regions.find((r) => r.region === node.region)?.nodes ?? 1) + 1}`,
          },
        ],
        execute: async () => ({
          ok: true,
          detail:
            "Acknowledged — node provisioning is an out-of-band IaC change; brain can't apply.",
        }),
      });
    }

    // 2. Region imbalance → rebalance hint. Low confidence — moving live
    //    instances across regions is disruptive (latency, sticky sessions).
    if (fleet.totals.instances > 0 && fleet.regions.length > 1) {
      const hottest = fleet.regions.reduce((a, b) =>
        a.instances > b.instances ? a : b,
      );
      const share = fleet.totals.instances
        ? Math.round((hottest.instances / fleet.totals.instances) * 100)
        : 0;
      if (share >= REGION_IMBALANCE_PCT) {
        const others = fleet.regions
          .filter((r) => r.region !== hottest.region)
          .map((r) => r.region)
          .join(" or ");
        out.push({
          id: `prop_${makeId("cap").slice(3)}_rebal_${hottest.region}`,
          at: now(),
          agent: this.name,
          kind: "rebalance_region",
          title: `Rebalance ${hottest.region} — holding ${share}% of the fleet`,
          body: `${hottest.region} carries ${hottest.instances} of ${fleet.totals.instances} instances (${share}%). A single-region outage takes most of the surface with it. Migrate a few high-traffic projects to ${others || "another region"} on their next deploy.`,
          confidence: "low",
          actionClass: "destructive",
          hints: [
            {
              label: "Move a project's region",
              hint: `# cantila CLI doesn't expose region migration yet; for now,\n# recreate the project in the new region and re-attach domains.`,
            },
          ],
          execute: async () => ({
            ok: true,
            detail:
              "Acknowledged — region rebalance is a multi-step operator decision.",
          }),
        });
      }
    }

    // 3. Under-utilised fleet → ack-only reminder to shrink before billing.
    if (
      fleet.totals.instances >= MIN_INSTANCES_FOR_UNDER_FLAG &&
      fleet.totals.loadPct < UNDER_UTILISED_PCT
    ) {
      out.push({
        id: `prop_${makeId("cap").slice(3)}_shrink`,
        at: now(),
        agent: this.name,
        kind: "shrink_fleet",
        title: `Shrink the fleet — total load at ${fleet.totals.loadPct}%`,
        body: `The fleet is carrying ${fleet.totals.instances} instances across ${fleet.totals.nodes} nodes (${fleet.totals.loadPct}% utilised). One or two nodes could be drained and decommissioned without affecting headroom — every idle node is a fixed monthly bill against a Hobby-margin product.`,
        confidence: "low",
        actionClass: "destructive",
        hints: [
          {
            label: "Drain and decommission",
            hint: `# drain instances off the lightest node, then\nterraform destroy -target=hcloud_server.<node>`,
          },
        ],
        execute: async () => ({
          ok: true,
          detail:
            "Acknowledged — fleet shrink is an operator decision (drain + IaC destroy).",
        }),
      });
    }

    // 4. Long-offline BYO nodes → propose `retire_stale_byo`. Low
    //    confidence and destructive — the agent on the tenant's box
    //    might come back; the operator decides whether to retire the
    //    row. Hint points at the `cantila nodes retire` command.
    //    Auto-applied? No — every BYO retire is operator-driven per
    //    §4.9 safety; the proposal is purely a tap on the shoulder.
    const byo = (await cp.listAccountNodes(ACCOUNT)).filter(
      (n) => n.kind === "byo" && cp.isStaleByoNode(n),
    );
    for (const node of byo) {
      out.push({
        id: `prop_${makeId("cap").slice(3)}_retire_byo_${node.id.slice(-8)}`,
        at: now(),
        agent: this.name,
        kind: "retire_stale_byo",
        title: `Retire stale BYO node ${node.label} — offline ${hoursAgo(node.lastHeartbeatAt)}h`,
        body: `${node.label} (${node.id}) has been offline for ${hoursAgo(node.lastHeartbeatAt)} hours. The agent has not heartbeat back. If the box is gone or being replaced, retire the row so the fleet rollup and CapacityAgent stop reasoning over a node that will never recover.`,
        confidence: "low",
        actionClass: "destructive",
        hints: [
          {
            label: "Retire the node",
            hint: `cantila nodes retire ${node.id}`,
          },
        ],
        execute: async () => ({
          ok: true,
          detail:
            "Acknowledged — BYO retire is an operator decision; brain queues but never auto-applies.",
        }),
      });
    }

    return out;
  }
}

/** Hours since the given ISO timestamp, rounded down. Returns 0 if the
 *  timestamp is missing — the proposal text reads sensibly either way
 *  ("offline 0h" still tells the operator a node just went offline). */
function hoursAgo(iso: string | undefined): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
}
