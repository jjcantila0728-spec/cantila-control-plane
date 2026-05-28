/* ============================================================
   ImageProvider — text-to-image port + adapters.

   Cantila's build agents need to generate logos, hero images,
   icons and short animations. The actual generation provider
   varies (Replicate / Fal / OpenAI / Stability), so we keep the
   call-site agnostic behind a tiny port. The default adapter is
   `StubImageProvider`, which emits deterministic placeholder SVG
   data URIs — every flow keeps working when no provider creds
   are configured.

   `ReplicateImageProvider` is the real adapter; it lazy-imports
   `node-fetch` style network calls only when invoked.
   ============================================================ */

import { randomBytes } from "crypto";

export interface GenerateImageInput {
  prompt: string;
  /** Pixel dimensions; provider may snap to nearest supported size. */
  width?: number;
  height?: number;
  /** "logo" / "hero" / "icon" / "og" — guides provider preset selection. */
  preset?: "logo" | "hero" | "icon" | "og" | "illustration";
  /** Aspect-ratio hint when width/height aren't supplied. */
  aspect?: "1:1" | "16:9" | "4:5" | "3:1";
}

export interface GenerateImageResult {
  /** Data URI or remote URL the asset table will store. */
  dataUrl: string;
  /** Best guess at mime — providers vary between PNG/JPEG/SVG. */
  mimeType: string;
  width: number;
  height: number;
  /** Which provider produced it ("stub" / "replicate" / "fal" / ...). */
  provider: string;
}

export interface GenerateAnimationInput {
  prompt: string;
  mode: "lottie" | "css" | "video";
  /** Used by the lottie/css modes to constrain length. */
  durationMs?: number;
}

export interface GenerateAnimationResult {
  /** Lottie: serialised JSON. CSS: CSS source text. Video: data URL or URL. */
  content: string;
  mode: "lottie" | "css" | "video";
  mimeType: string;
  provider: string;
}

export interface ImageProvider {
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
  generateAnimation(input: GenerateAnimationInput): Promise<GenerateAnimationResult>;
}

/* ---------- stub adapter (always available) ---------- */

const STUB_PALETTE = [
  ["#ff7a18", "#1a0e08"],
  ["#7c3aed", "#0a0b16"],
  ["#10b981", "#03110d"],
  ["#f43f5e", "#180609"],
  ["#0ea5e9", "#03101a"],
];

function pickPalette(seed: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const palette = STUB_PALETTE[Math.abs(hash) % STUB_PALETTE.length];
  return [palette[0], palette[1]];
}

function svgPlaceholder(prompt: string, w: number, h: number): string {
  const [fg, bg] = pickPalette(prompt);
  const label = prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt;
  const escaped = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const id = randomBytes(4).toString("hex");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${escaped}">
  <defs>
    <linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${fg}"/>
      <stop offset="100%" stop-color="${bg}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g${id})"/>
  <text x="50%" y="50%" font-family="ui-sans-serif, system-ui, Arial" font-size="${Math.round(Math.min(w, h) / 14)}" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${escaped}</text>
</svg>`;
}

function aspectToDims(aspect: GenerateImageInput["aspect"], preset: GenerateImageInput["preset"]): { w: number; h: number } {
  if (preset === "logo" || preset === "icon") return { w: 512, h: 512 };
  if (preset === "og") return { w: 1200, h: 630 };
  switch (aspect) {
    case "16:9": return { w: 1280, h: 720 };
    case "4:5":  return { w: 800, h: 1000 };
    case "3:1":  return { w: 1500, h: 500 };
    case "1:1":  return { w: 1024, h: 1024 };
    default:     return { w: 1280, h: 720 };
  }
}

function svgToDataUrl(svg: string): string {
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

export class StubImageProvider implements ImageProvider {
  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    const dims = input.width && input.height
      ? { w: input.width, h: input.height }
      : aspectToDims(input.aspect, input.preset);
    const svg = svgPlaceholder(input.prompt, dims.w, dims.h);
    return {
      dataUrl: svgToDataUrl(svg),
      mimeType: "image/svg+xml",
      width: dims.w,
      height: dims.h,
      provider: "stub",
    };
  }

  async generateAnimation(input: GenerateAnimationInput): Promise<GenerateAnimationResult> {
    if (input.mode === "css") {
      const [fg, bg] = pickPalette(input.prompt);
      const css = `/* Stub animation for: ${input.prompt} */
@keyframes cantila-stub-pulse {
  0%   { transform: scale(1);    background: ${fg}; }
  50%  { transform: scale(1.04); background: ${bg}; }
  100% { transform: scale(1);    background: ${fg}; }
}
.cantila-hero {
  animation: cantila-stub-pulse ${Math.max(800, input.durationMs ?? 1800)}ms ease-in-out infinite;
}`;
      return { content: css, mode: "css", mimeType: "text/css", provider: "stub" };
    }
    if (input.mode === "lottie") {
      // Minimal valid Lottie JSON: a single bouncing circle.
      const lottie = {
        v: "5.7.4",
        fr: 30,
        ip: 0,
        op: 60,
        w: 512,
        h: 512,
        nm: "cantila-stub",
        ddd: 0,
        assets: [],
        layers: [
          {
            ddd: 0, ind: 1, ty: 4, nm: "dot", sr: 1,
            ks: {
              o: { a: 0, k: 100 }, r: { a: 0, k: 0 },
              p: { a: 1, k: [
                { i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] }, t: 0,  s: [256, 256] },
                { i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] }, t: 30, s: [256, 200] },
                { t: 60, s: [256, 256] },
              ] },
              a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] },
            },
            ao: 0,
            shapes: [{ ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [180, 180] } }],
            ip: 0, op: 60, st: 0, bm: 0,
          },
        ],
      };
      return { content: JSON.stringify(lottie), mode: "lottie", mimeType: "application/json", provider: "stub" };
    }
    // video mode: emit a 1-frame SVG as a placeholder so the asset table
    // gets something inspectable.
    const svg = svgPlaceholder(`▶ ${input.prompt}`, 1280, 720);
    return { content: svgToDataUrl(svg), mode: "video", mimeType: "image/svg+xml", provider: "stub" };
  }
}

/* ---------- Replicate adapter (best-effort, optional) ---------- */

export class ReplicateImageProvider implements ImageProvider {
  private apiKey: string;
  private fallback: ImageProvider;

  constructor(opts: { apiKey: string; fallback?: ImageProvider }) {
    this.apiKey = opts.apiKey;
    this.fallback = opts.fallback ?? new StubImageProvider();
  }

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    try {
      // Replicate's "create-and-wait" path. We use Flux Schnell as a
      // sensible, low-latency default; deployments that want a different
      // model can wire a different adapter.
      const dims = input.width && input.height
        ? { w: input.width, h: input.height }
        : aspectToDims(input.aspect, input.preset);

      const resp = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          prefer: "wait",
        },
        body: JSON.stringify({
          input: {
            prompt: input.prompt,
            aspect_ratio: input.aspect ?? "16:9",
            output_format: "png",
          },
        }),
      });
      if (!resp.ok) throw new Error(`replicate ${resp.status}`);
      const body = (await resp.json()) as { output?: string | string[] };
      const out = Array.isArray(body.output) ? body.output[0] : body.output;
      if (!out) throw new Error("replicate: no output");
      return {
        dataUrl: out,
        mimeType: "image/png",
        width: dims.w,
        height: dims.h,
        provider: "replicate",
      };
    } catch {
      return this.fallback.generateImage(input);
    }
  }

  async generateAnimation(input: GenerateAnimationInput): Promise<GenerateAnimationResult> {
    // Video / animation generation is provider-heavy; we delegate to the
    // fallback for non-video modes and only attempt video when the user
    // is on a paying Replicate plan. Today: always fallback.
    return this.fallback.generateAnimation(input);
  }
}

/* ---------- factory ---------- */

export function buildImageProvider(): ImageProvider {
  const replicate = process.env.REPLICATE_API_TOKEN;
  if (replicate) {
    return new ReplicateImageProvider({ apiKey: replicate, fallback: new StubImageProvider() });
  }
  return new StubImageProvider();
}
