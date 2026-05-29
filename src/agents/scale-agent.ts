/* ============================================================
   ScaleAgent — keeps each project's instance count inside its
   [minInstances, maxInstances] bounds and surfaces capacity
   hints (plan §5.2 — auto-scaling).

   Reasoning signals — checked in this priority order:
     - `desiredInstances` outside [min, max] → re-clamp (SAFE auto-apply).
     - Project is `crashed` AND `desiredInstances > min` → propose a
       scale-down nudge (low confidence, DESTRUCTIVE — operator
       might want capacity ready for the recovery deploy).
     - Project is `sleeping` AND `desiredInstances > min` → propose
       scale-down (medium confidence, DESTRUCTIVE — sleeping projects
       don't need extra replicas).
     - Project is `live` + sustained CPU >= 70% across the recent
       window + at min → propose scale-up (medium confidence,
       DESTRUCTIVE — the real load-driven signal, replacing the older
       "deploy frequency as proxy" heuristic that fired before the
       data plane exposed real metrics).
     - Project is `live` + sustained CPU < 15% + above min →
       propose scale-down (low confidence, DESTRUCTIVE — the unused
       capacity counterpart).

   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { id as makeId, now } from "../lib/ids";
import type { Agent, Observation, Proposal } from "./types";
import type { ProjectMetricSample } from "../domain/types";
import { ownerAccountId } from "../lib/owner-account";

const ACCOUNT = ownerAccountId();
/** Sustained-load thresholds. `MIN_SAMPLES` keeps the agent from acting
 *  on a single spike — sustained means N consecutive samples above /
 *  below the line. The numbers match the §15.2 ScaleAgent follow-up:
 *  real CPU-driven scale, not deploy-frequency proxy. */
const HOT_CPU_PCT = 70;
const COLD_CPU_PCT = 15;
const SUSTAINED_SAMPLES = 3;

/** Compute the average CPU over the most-recent `n` samples. */
function recentAvgCpu(samples: ProjectMetricSample[], n: number): number | null {
  if (samples.length < n) return null;
  const slice = samples.slice(-n);
  const sum = slice.reduce((acc, s) => acc + s.cpuPct, 0);
  return sum / slice.length;
}

export class ScaleAgent implements Agent {
  readonly name = "scale" as const;

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const projects = await cp.listProjects(ACCOUNT);
    const out: Observation[] = [];
    for (const p of projects) {
      if (
        p.desiredInstances < p.minInstances ||
        p.desiredInstances > p.maxInstances
      ) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "instances_out_of_bounds",
          detail: `${p.name} has desiredInstances ${p.desiredInstances} outside [${p.minInstances}, ${p.maxInstances}]`,
          projectId: p.id,
        });
      }
      if (p.minInstances === p.maxInstances && p.minInstances > 1) {
        // Not an action item — just a memory hook the brain can use to
        // explain "why isn't this project scaling automatically?" later.
        out.push({
          at: now(),
          agent: this.name,
          kind: "instances_pinned",
          detail: `${p.name} is pinned at ${p.minInstances} instances (min == max)`,
          projectId: p.id,
        });
      }
    }
    return out;
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const out: Proposal[] = [];
    const projects = await cp.listProjects(ACCOUNT);

    for (const project of projects) {
      // 1. Re-clamp out-of-bounds desiredInstances — SAFE, auto-applied.
      if (
        project.desiredInstances < project.minInstances ||
        project.desiredInstances > project.maxInstances
      ) {
        const target = Math.max(
          project.minInstances,
          Math.min(project.maxInstances, project.desiredInstances),
        );
        out.push({
          id: `prop_${makeId("scl").slice(3)}_clamp_${project.id}`,
          at: now(),
          agent: this.name,
          kind: "instances_clamp",
          title: `Re-clamp ${project.name} to ${target} instance${target === 1 ? "" : "s"}`,
          body: `desiredInstances (${project.desiredInstances}) is outside [${project.minInstances}, ${project.maxInstances}]. Snapping it back into bounds is mechanical and reversible.`,
          confidence: "high",
          actionClass: "safe",
          projectId: project.id,
          hints: [
            {
              label: "Scale via CLI",
              hint: `cantila scale ${project.id} --instances ${target}`,
            },
          ],
          execute: async (controlPlane) => {
            const result = await controlPlane.scale(project.id, {
              desiredInstances: target,
            });
            if (!result) return { ok: false, detail: "project not found" };
            if ("error" in result) {
              return { ok: false, detail: result.error };
            }
            return {
              ok: true,
              detail: `${result.slug}: desiredInstances → ${result.desiredInstances}`,
            };
          },
          // Post-check (plan §4.9): 5s after the re-clamp, confirm
          // desiredInstances is still inside [min, max]. A concurrent
          // scale call — another tick, a human, an external config sync —
          // could push it straight back out; that's the "execute returned
          // ok but the world reverted" case the learning loop must catch.
          verifyDelayMs: 5_000,
          verify: async (controlPlane) => {
            const current = await controlPlane.getProject(project.id);
            if (!current) {
              return { verified: false, detail: "project no longer exists" };
            }
            const inBounds =
              current.desiredInstances >= current.minInstances &&
              current.desiredInstances <= current.maxInstances;
            if (inBounds) {
              return {
                verified: true,
                detail: `${current.slug}: desiredInstances ${current.desiredInstances} held within [${current.minInstances}, ${current.maxInstances}]`,
              };
            }
            return {
              verified: false,
              detail: `${current.slug}: desiredInstances ${current.desiredInstances} drifted back outside [${current.minInstances}, ${current.maxInstances}] within 5s`,
            };
          },
        });
        continue;
      }

      // 2. Sleeping project with extra replicas — scale-down hint.
      if (
        project.status === "sleeping" &&
        project.desiredInstances > project.minInstances
      ) {
        const target = project.minInstances;
        out.push({
          id: `prop_${makeId("scl").slice(3)}_sleep_${project.id}`,
          at: now(),
          agent: this.name,
          kind: "scale_down_sleeping",
          title: `Scale ${project.name} down — sleeping with ${project.desiredInstances} replicas`,
          body: `Project is currently sleeping. Holding ${project.desiredInstances} idle replicas while no traffic arrives is wasted spend; dropping to ${target} preserves the floor and reclaims the rest.`,
          confidence: "medium",
          actionClass: "destructive",
          projectId: project.id,
          hints: [
            {
              label: "Scale via CLI",
              hint: `cantila scale ${project.id} --instances ${target}`,
            },
          ],
          execute: async (controlPlane) => {
            const result = await controlPlane.scale(project.id, {
              desiredInstances: target,
            });
            if (!result) return { ok: false, detail: "project not found" };
            if ("error" in result) {
              return { ok: false, detail: result.error };
            }
            return {
              ok: true,
              detail: `${result.slug}: ${project.desiredInstances} → ${result.desiredInstances} replicas`,
            };
          },
        });
        continue;
      }

      // 3. Crashed project with extras — keep recovery capacity ready
      //    (low confidence, ack-only).
      if (
        project.status === "crashed" &&
        project.desiredInstances > project.minInstances
      ) {
        out.push({
          id: `prop_${makeId("scl").slice(3)}_crash_${project.id}`,
          at: now(),
          agent: this.name,
          kind: "hold_capacity_crashed",
          title: `Hold capacity on ${project.name} during recovery`,
          body: `Project is crashed. Keeping ${project.desiredInstances} replicas in the LB pool means the next live deploy lands without a cold-start spike. No action recommended right now — the brain will reconsider after the next deploy.`,
          confidence: "low",
          actionClass: "destructive",
          projectId: project.id,
          execute: async () => ({
            ok: true,
            detail: "Acknowledged — held current capacity for recovery.",
          }),
        });
        continue;
      }

      // 4. Live + sustained high CPU + at min → scale-up (the real
      //    load-driven signal). Replaces the old "deploy frequency as
      //    proxy" heuristic (plan §15.2 ScaleAgent follow-up).
      if (
        project.status === "live" &&
        project.desiredInstances === project.minInstances &&
        project.maxInstances > project.minInstances
      ) {
        const samples = await cp.getProjectMetrics(project.id);
        const avg = recentAvgCpu(samples, SUSTAINED_SAMPLES);
        if (avg !== null && avg >= HOT_CPU_PCT) {
          const target = Math.min(
            project.maxInstances,
            project.desiredInstances + 1,
          );
          out.push({
            id: `prop_${makeId("scl").slice(3)}_hot_${project.id}`,
            at: now(),
            agent: this.name,
            kind: "scale_up_load",
            title: `Add headroom on ${project.name} — CPU ${avg.toFixed(0)}% sustained`,
            body: `Last ${SUSTAINED_SAMPLES} samples averaged ${avg.toFixed(1)}% CPU (threshold ${HOT_CPU_PCT}%) but the project is pinned at ${project.minInstances} replica${project.minInstances === 1 ? "" : "s"}. Bumping desiredInstances to ${target} gives the LB more capacity before users feel the pressure.`,
            confidence: "medium",
            actionClass: "destructive",
            projectId: project.id,
            hints: [
              {
                label: "Scale via CLI",
                hint: `cantila scale ${project.id} --instances ${target}`,
              },
            ],
            execute: async (controlPlane) => {
              const result = await controlPlane.scale(project.id, {
                desiredInstances: target,
              });
              if (!result) return { ok: false, detail: "project not found" };
              if ("error" in result) {
                return { ok: false, detail: result.error };
              }
              return {
                ok: true,
                detail: `${result.slug}: scaled up to ${result.desiredInstances} replicas (CPU ${avg.toFixed(1)}%)`,
              };
            },
          });
          continue;
        }
      }

      // 5. Live + sustained low CPU + above min → scale-down hint
      //    (low confidence — operators often hold capacity for spikes,
      //    so this is a tap on the shoulder, not a verdict).
      if (
        project.status === "live" &&
        project.desiredInstances > project.minInstances
      ) {
        const samples = await cp.getProjectMetrics(project.id);
        const avg = recentAvgCpu(samples, SUSTAINED_SAMPLES);
        if (avg !== null && avg < COLD_CPU_PCT) {
          const target = Math.max(
            project.minInstances,
            project.desiredInstances - 1,
          );
          out.push({
            id: `prop_${makeId("scl").slice(3)}_cold_${project.id}`,
            at: now(),
            agent: this.name,
            kind: "scale_down_idle",
            title: `Trim ${project.name} — CPU ${avg.toFixed(0)}% across recent samples`,
            body: `Last ${SUSTAINED_SAMPLES} samples averaged ${avg.toFixed(1)}% CPU (threshold ${COLD_CPU_PCT}%) but the project is holding ${project.desiredInstances} replicas. Dropping to ${target} reclaims unused capacity; operators may still want the headroom for spikes — low confidence.`,
            confidence: "low",
            actionClass: "destructive",
            projectId: project.id,
            hints: [
              {
                label: "Scale via CLI",
                hint: `cantila scale ${project.id} --instances ${target}`,
              },
            ],
            execute: async (controlPlane) => {
              const result = await controlPlane.scale(project.id, {
                desiredInstances: target,
              });
              if (!result) return { ok: false, detail: "project not found" };
              if ("error" in result) {
                return { ok: false, detail: result.error };
              }
              return {
                ok: true,
                detail: `${result.slug}: scaled down to ${result.desiredInstances} replicas (CPU ${avg.toFixed(1)}%)`,
              };
            },
          });
        }
      }
    }
    return out;
  }
}
