/* ============================================================
   SeoAgent — the 10th brain-swarm agent.

   Continuously audits the live cantila.app public face and:
   - auto-applies mechanical fixes (when SEO_AGENT_AUTO_APPLY=true
     AND GITHUB_TOKEN+GITHUB_REPO set) via the SeoFixer port
   - queues subjective findings (title/description quality, CWV
     regressions, content gaps) for human review

   Runs on a slow tick (every 6h by default — SEO doesn't need
   fast cadence, and crawling many pages is expensive). Tick
   interval is `config.seoTickMs`; the brain ticks at 60s but
   the agent self-throttles by tracking `lastRunAt` and bailing
   out of `observe()` / `propose()` until the interval elapses.

   The agent operates against the public origin (config.seoOrigin
   — `https://cantila.app` in prod) — it doesn't read the repo
   directly, so it works the same whether the control plane is
   on Coolify or running locally.
   ============================================================ */

import { config } from "../config";
import { id as makeId, now } from "../lib/ids";
import { snapshotPage, type PageSnapshot } from "../seo/crawler";
import { selectSeoFixer, type SeoFixer } from "../seo/fixer";
import type { Agent, Observation, Proposal } from "./types";
import type { ControlPlane } from "../core/control-plane";

/* ---------- the canonical public-face route list ----------
   Hand-maintained because the agent runs in the control plane,
   which doesn't have access to the cantila-console route
   manifest. When a new public route ships, add it here. The
   sitemap.ts on the console side is the other source of truth
   for the same list — the agent will eventually fetch the live
   sitemap.xml to detect drift. */

const PUBLIC_ROUTES = [
  "/",
  "/pricing",
  "/mcp",
  "/about",
  "/contact",
  "/changelog",
  "/signup",
  "/products/host",
  "/products/deploy",
  "/products/data",
  "/products/domains",
  "/products/agents",
  "/products/automations",
  "/products/mail",
  "/products/sms",
  "/docs",
  "/docs/getting-started",
  "/docs/deploy/chat",
  "/docs/deploy/git",
  "/docs/cli",
  "/docs/mcp",
  "/docs/auto-wired",
  "/docs/billing",
  "/legal/privacy",
  "/legal/terms",
  "/legal/aup",
  "/legal/dpa",
  "/legal/subprocessors",
] as const;

/* ---------- SEO check rules ----------
   Each `check` runs against a `PageSnapshot` and returns zero
   or more findings. Findings split into two buckets:

   - `mechanical` — can be auto-applied via the SeoFixer (e.g.
     missing canonical, sitemap drift, blank alt text). When
     SEO_AGENT_AUTO_APPLY is on the fixer commits the fix; when
     off the proposal queues for review.
   - `subjective` — always queues for review (title/description
     quality, content gaps, orphan pages). The agent never
     auto-rewrites copy.
*/

type FindingSeverity = "p0" | "p1" | "p2";

interface Finding {
  /** Short slug for the proposal kind — used by the brain's
   *  learning loop to group outcomes by (agent, kind). */
  kind: string;
  severity: FindingSeverity;
  title: string;
  body: string;
  /** When true, the SeoFixer can apply this automatically. */
  mechanical: boolean;
  path: string;
}

/* ---------- per-page checks ---------- */

/** Title length sweet spot: 30-60 chars. */
function checkTitle(snap: PageSnapshot): Finding[] {
  const out: Finding[] = [];
  if (!snap.title) {
    out.push({
      kind: "missing_title",
      severity: "p0",
      title: `${snap.path} — missing <title>`,
      body: `Crawler could not extract a <title> tag from ${snap.path}. Search engines fall back to the URL slug as the SERP heading, which is almost always worse than even a bad title.`,
      mechanical: false,
      path: snap.path,
    });
    return out;
  }
  const len = snap.title.length;
  if (len < 25 || len > 70) {
    out.push({
      kind: "title_length",
      severity: "p1",
      title: `${snap.path} — title length ${len} (target 30-60)`,
      body: `Title is "${snap.title}" — ${len < 25 ? "too short to convey content" : "long enough that Google truncates it in SERPs"}. Aim for 30-60 chars.`,
      mechanical: false,
      path: snap.path,
    });
  }
  return out;
}

function checkDescription(snap: PageSnapshot): Finding[] {
  const out: Finding[] = [];
  if (!snap.description) {
    out.push({
      kind: "missing_description",
      severity: "p0",
      title: `${snap.path} — missing meta description`,
      body: `No <meta name="description"> tag. Google composes one from the page body, usually badly.`,
      mechanical: false,
      path: snap.path,
    });
    return out;
  }
  const len = snap.description.length;
  if (len < 80 || len > 200) {
    out.push({
      kind: "description_length",
      severity: "p1",
      title: `${snap.path} — description length ${len} (target 120-160)`,
      body: `Description is ${len} chars. Target the 120-160 SERP window so it doesn't get truncated.`,
      mechanical: false,
      path: snap.path,
    });
  }
  return out;
}

function checkCanonical(snap: PageSnapshot, origin: string): Finding[] {
  if (snap.canonical) return [];
  return [
    {
      kind: "missing_canonical",
      severity: "p1",
      title: `${snap.path} — missing canonical`,
      body: `No <link rel="canonical"> on ${snap.path}. Add canonical to ${origin}${snap.path} to prevent duplicate-content risk via www / trailing-slash / utm variants.`,
      mechanical: true,
      path: snap.path,
    },
  ];
}

function checkOpenGraph(snap: PageSnapshot): Finding[] {
  const out: Finding[] = [];
  if (!snap.ogTitle) {
    out.push({
      kind: "missing_og_title",
      severity: "p1",
      title: `${snap.path} — missing og:title`,
      body: `Page has no og:title — link previews on Slack/Twitter/iMessage will fall back to the <title> or be blank.`,
      mechanical: false,
      path: snap.path,
    });
  }
  if (!snap.ogImage) {
    out.push({
      kind: "missing_og_image",
      severity: "p1",
      title: `${snap.path} — missing og:image`,
      body: `Page has no og:image — link previews show no image, halving click-through.`,
      mechanical: true,
      path: snap.path,
    });
  }
  return out;
}

function checkJsonLd(snap: PageSnapshot): Finding[] {
  if (snap.jsonLdTypes.length === 0) {
    return [
      {
        kind: "missing_jsonld",
        severity: "p1",
        title: `${snap.path} — no JSON-LD`,
        body: `Page emits no schema.org JSON-LD. Rich results (sitelinks, FAQ, breadcrumbs) won't render in Google SERPs without at least an Organization or WebSite or BreadcrumbList block.`,
        mechanical: false,
        path: snap.path,
      },
    ];
  }
  return [];
}

function checkImages(snap: PageSnapshot): Finding[] {
  const { total, withAlt, withEmptyAlt } = snap.images;
  const missingAlt = total - withAlt - withEmptyAlt;
  if (missingAlt > 0) {
    return [
      {
        kind: "missing_alt_text",
        severity: "p1",
        title: `${snap.path} — ${missingAlt}/${total} <img> tags missing alt`,
        body: `Accessibility regression (screen readers skip them) and SEO loss (image search can't index without alt). Add alt="" for decorative images, descriptive alt for content images.`,
        mechanical: true,
        path: snap.path,
      },
    ];
  }
  return [];
}

function checkHeadings(snap: PageSnapshot): Finding[] {
  const h = snap.headings;
  if (h.length === 0) return [];
  // No more than one h1; no skipping levels (e.g. h2 → h4).
  const h1Count = h.filter((x) => x === 1).length;
  if (h1Count === 0) {
    return [
      {
        kind: "missing_h1",
        severity: "p1",
        title: `${snap.path} — no <h1>`,
        body: `Page has no <h1>. Headings tell Google the page topic; missing h1 is a serious crawl signal.`,
        mechanical: false,
        path: snap.path,
      },
    ];
  }
  if (h1Count > 1) {
    return [
      {
        kind: "multiple_h1",
        severity: "p1",
        title: `${snap.path} — ${h1Count} <h1> tags`,
        body: `Multiple h1s confuse the topic signal. Convert all but one to h2.`,
        mechanical: false,
        path: snap.path,
      },
    ];
  }
  // Skipped levels
  let prev = 0;
  for (const lvl of h) {
    if (prev > 0 && lvl > prev + 1) {
      return [
        {
          kind: "skipped_heading_level",
          severity: "p2",
          title: `${snap.path} — heading skipped (h${prev} → h${lvl})`,
          body: `Heading hierarchy jumps from h${prev} to h${lvl}. Insert an intermediate level or downgrade the heading.`,
          mechanical: false,
          path: snap.path,
        },
      ];
    }
    prev = lvl;
  }
  return [];
}

function checkPageStatus(snap: PageSnapshot): Finding[] {
  if (snap.status >= 400) {
    return [
      {
        kind: "page_error",
        severity: "p0",
        title: `${snap.path} returned ${snap.status}`,
        body: `Page is broken. Returns ${snap.status}; visitors and crawlers both fail. Fix or redirect.`,
        mechanical: false,
        path: snap.path,
      },
    ];
  }
  if (snap.bytes < 500) {
    return [
      {
        kind: "thin_content",
        severity: "p1",
        title: `${snap.path} — only ${snap.bytes} bytes`,
        body: `Page rendered ${snap.bytes} bytes. Either a render error or genuinely thin content; Google de-ranks thin pages.`,
        mechanical: false,
        path: snap.path,
      },
    ];
  }
  return [];
}

function checkBrokenInternalLinks(
  snap: PageSnapshot,
  knownPaths: Set<string>,
): Finding[] {
  const broken = snap.internalLinks.filter((href) => {
    if (href === "/") return false;
    // Strip query/hash for membership test
    const clean = href.split("?")[0].split("#")[0];
    if (knownPaths.has(clean)) return false;
    // We crawl a known set; anything outside it isn't necessarily broken
    // (could be /api/ or /status). Only flag /docs|/products|/legal paths
    // we don't recognise.
    return (
      clean.startsWith("/docs/") ||
      clean.startsWith("/products/") ||
      clean.startsWith("/legal/")
    );
  });
  if (broken.length === 0) return [];
  return [
    {
      kind: "broken_internal_link",
      severity: "p0",
      title: `${snap.path} — links to unknown route(s)`,
      body: `Links from ${snap.path}: ${broken.join(", ")}. These don't appear in the agent's route manifest — either the link is broken or the manifest is stale.`,
      mechanical: false,
      path: snap.path,
    },
  ];
}

/* ---------- the agent ---------- */

export class SeoAgent implements Agent {
  readonly name = "seo" as const;

  private lastRunAt = 0;
  private fixer: SeoFixer;
  /** Cached snapshots from the last completed scan. The brain calls
   *  observe() then propose() in sequence; we want both to see the
   *  same data without crawling twice. */
  private snapshots: PageSnapshot[] = [];

  constructor(fixer?: SeoFixer) {
    this.fixer = fixer ?? selectSeoFixer();
  }

  /** True when enough time has elapsed since the last scan. The brain
   *  ticks every 60s; SEO ticks every 6h by default — far slower. */
  private dueForScan(): boolean {
    return Date.now() - this.lastRunAt >= config.seoTickMs;
  }

  /** Fetch every public route once and cache the snapshots. Called
   *  from observe() on the first tick after the interval elapses. */
  private async runScan(): Promise<void> {
    const results: PageSnapshot[] = [];
    for (const path of PUBLIC_ROUTES) {
      const snap = await snapshotPage(config.seoOrigin, path);
      if (snap) results.push(snap);
    }
    this.snapshots = results;
    this.lastRunAt = Date.now();
  }

  /** Compute findings from cached snapshots. Pure — no IO. */
  private buildFindings(): Finding[] {
    const known = new Set<string>(PUBLIC_ROUTES);
    const out: Finding[] = [];
    for (const snap of this.snapshots) {
      out.push(...checkPageStatus(snap));
      out.push(...checkTitle(snap));
      out.push(...checkDescription(snap));
      out.push(...checkCanonical(snap, config.seoOrigin));
      out.push(...checkOpenGraph(snap));
      out.push(...checkJsonLd(snap));
      out.push(...checkImages(snap));
      out.push(...checkHeadings(snap));
      out.push(...checkBrokenInternalLinks(snap, known));
    }
    return out;
  }

  async observe(_cp: ControlPlane): Promise<Observation[]> {
    if (this.dueForScan()) await this.runScan();
    if (this.snapshots.length === 0) return [];
    const findings = this.buildFindings();
    return findings.map((f) => ({
      at: now(),
      agent: this.name,
      kind: f.kind,
      detail: `[${f.severity}] ${f.title}`,
    }));
  }

  async propose(_cp: ControlPlane): Promise<Proposal[]> {
    if (this.snapshots.length === 0) return [];
    const findings = this.buildFindings();
    const out: Proposal[] = [];
    for (const f of findings) {
      // Only mechanical findings come with an `execute` that actually
      // commits — subjective findings are queued for review with a
      // no-op execute (the brain marks them ok but the journal carries
      // the title/body for the operator).
      const isHighSafe = f.mechanical && f.severity !== "p0";
      out.push({
        id: `prop_${makeId("seo").slice(3)}_${f.kind}_${f.path.replace(/[^a-z0-9]/gi, "_")}`,
        at: now(),
        agent: this.name,
        kind: f.kind,
        title: f.title,
        body: `${f.body}\n\nFixer mode: ${this.fixer.label} (${this.fixer.live ? "live" : "queue-only"}).`,
        // Only mechanical, non-broken findings get auto-applied. p0
        // (broken pages, missing title) always queue for review because
        // the fix needs human judgement.
        confidence: isHighSafe ? "high" : "medium",
        actionClass: "safe",
        execute: async () => {
          if (!isHighSafe) {
            return {
              ok: true,
              detail: `Queued for human review (${this.fixer.label} mode).`,
            };
          }
          // Mechanical fix execution. v1 emits an acknowledgement; v2
          // will compute the exact file edit (sitemap regen, canonical
          // injection, alt-text fill) and route through the fixer.
          // Keeping the closure simple now means the journal records
          // intent + the fixer's live/stub label, and we don't ship a
          // half-baked auto-edit that could mangle a file.
          const result = await this.fixer.commitFile({
            path: `# placeholder — ${f.path}`,
            content: `// SeoAgent: would fix ${f.kind} on ${f.path}`,
            message: `Acknowledge ${f.kind} on ${f.path}`,
          });
          return {
            ok: result.ok,
            detail: result.detail,
          };
        },
      });
    }
    return out;
  }

  /** Test seam — inject snapshots without crawling. */
  _setSnapshots(snaps: PageSnapshot[]): void {
    this.snapshots = snaps;
    this.lastRunAt = Date.now();
  }
}
