/* ============================================================
   Tiny HTML crawler the SeoAgent uses to audit the live public
   face. No DOM parser dependency — uses focused regex against
   the HTML head + body chunks since the agent only needs:

   - <title>
   - <meta name="description">
   - <link rel="canonical">
   - <meta property="og:title|og:description|og:image">
   - JSON-LD <script type="application/ld+json"> payloads
   - <img> tags (count, presence of alt attribute)
   - <h1>..<h6> ordering
   - <a href="..."> for internal-link graph

   Regex parsing is fragile for general HTML but adequate here:
   Next.js emits well-formed, server-rendered HTML and the agent
   tolerates parse misses (a "could not extract" is just an
   observation, not a crash).
   ============================================================ */

export interface PageSnapshot {
  path: string;
  fetchedAt: string;
  status: number;
  title?: string;
  description?: string;
  canonical?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  jsonLdTypes: string[];
  /** Number of <img> tags vs. how many had a non-empty alt attribute. */
  images: { total: number; withAlt: number; withEmptyAlt: number };
  /** Sequence of heading levels in document order — [1, 2, 2, 3, 2, ...]. */
  headings: number[];
  /** Internal links collected from <a href="/..."> — relative paths only. */
  internalLinks: string[];
  /** Raw body byte length — used as a cheap "did the page render" check. */
  bytes: number;
}

function matchFirst(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  return m?.[1]?.trim();
}

function matchAll(html: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    if (m[1]) out.push(m[1].trim());
  }
  return out;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractJsonLdTypes(html: string): string[] {
  const types: string[] = [];
  const re =
    /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const payload = safeParseJson(m[1]);
    if (!payload) continue;
    if (Array.isArray(payload)) {
      for (const p of payload) {
        const t = (p as { "@type"?: string })["@type"];
        if (typeof t === "string") types.push(t);
      }
    } else if (typeof payload === "object" && payload !== null) {
      const t = (payload as { "@type"?: string })["@type"];
      if (typeof t === "string") types.push(t);
    }
  }
  return types;
}

function extractImages(html: string): {
  total: number;
  withAlt: number;
  withEmptyAlt: number;
} {
  let total = 0;
  let withAlt = 0;
  let withEmptyAlt = 0;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    total += 1;
    const tag = m[0];
    const altMatch = tag.match(/\salt=("[^"]*"|'[^']*'|\S+)/i);
    if (altMatch) {
      const v = altMatch[1].replace(/^["']|["']$/g, "");
      if (v.length === 0) withEmptyAlt += 1;
      else withAlt += 1;
    }
  }
  return { total, withAlt, withEmptyAlt };
}

function extractHeadings(html: string): number[] {
  const out: number[] = [];
  for (const m of html.matchAll(/<h([1-6])\b[^>]*>/gi)) {
    out.push(Number(m[1]));
  }
  return out;
}

function extractInternalLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\shref=["'](\/[^"'#?]*)["']/gi)) {
    const href = m[1];
    if (href.startsWith("//")) continue;
    out.add(href);
  }
  return [...out];
}

/** Fetch + parse one page. Returns null on network failure (the SeoAgent
 *  treats null as "page unreachable" — its own observation kind). */
export async function snapshotPage(
  origin: string,
  path: string,
): Promise<PageSnapshot | null> {
  const url = `${origin}${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Cantila-SeoAgent/1.0 (+https://cantila.app)",
        Accept: "text/html",
      },
      // Short timeout so a hung page doesn't wedge the brain tick.
      signal: AbortSignal.timeout(15_000),
    });
    const html = await res.text();
    return {
      path,
      fetchedAt: new Date().toISOString(),
      status: res.status,
      title: matchFirst(html, /<title>([^<]+)<\/title>/i),
      description: matchFirst(
        html,
        /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
      ),
      canonical: matchFirst(
        html,
        /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i,
      ),
      ogTitle: matchFirst(
        html,
        /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
      ),
      ogDescription: matchFirst(
        html,
        /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i,
      ),
      ogImage: matchFirst(
        html,
        /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
      ),
      jsonLdTypes: extractJsonLdTypes(html),
      images: extractImages(html),
      headings: extractHeadings(html),
      internalLinks: extractInternalLinks(html),
      bytes: html.length,
    };
  } catch {
    return null;
  }
}
