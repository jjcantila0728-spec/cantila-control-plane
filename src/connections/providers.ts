/* ============================================================
   Cantila Connections — the server-side provider catalog.

   Renders the `Add connection` screen in the Console: pick a
   provider, fill the form for its auth kind (OAuth button or
   API-key fields). Server-driven so adding a provider is a
   single entry, not per-provider UI code.

   Phase A ships API-key / basic providers only. Phase C adds
   OAuth (`oauth` block populated, callback wiring lands then).
   ============================================================ */

import type { ConnectionAuthKind } from "../domain/types";

export interface ProviderApiKeyField {
  key: string;
  label: string;
  /** When true, the Console masks the value and the field is
   *  flagged as secret on submit so it lands in the secrets manager. */
  secret: boolean;
  /** Plain-text helper rendered under the field. */
  hint?: string;
}

export interface ProviderOAuth {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Process env that holds the OAuth client id. Resolved server-side at
   *  the moment the start URL is minted, so the publishable Console
   *  bundle never sees client ids. */
  clientIdEnv: string;
  clientSecretEnv: string;
}

export interface ProviderApiKeyAuth {
  fields: ProviderApiKeyField[];
  /** Optional health probe used by `POST /v1/connections/:id/test`. The
   *  control plane calls this URL with the secret(s) and treats a 2xx as
   *  healthy. */
  testUrl?: string;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  /** Short single-line description for the catalog grid. */
  blurb: string;
  /** Glyph shown on the catalog tile when no icon URL is set. */
  glyph: string;
  /** Optional remote icon (lands in Phase C alongside richer chrome). */
  iconUrl?: string;
  authKinds: ConnectionAuthKind[];
  oauth?: ProviderOAuth;
  apiKey?: ProviderApiKeyAuth;
}

/** Phase C catalog — the starter five plus ten OAuth + API-key providers
 *  covering the most common workflow integrations (plan §4.11). */
export const PROVIDER_CATALOG: ProviderDescriptor[] = [
  /* ----- LLM + payments (API-key) ----- */
  {
    id: "openai",
    name: "OpenAI",
    blurb: "GPT-4, embeddings, image generation.",
    glyph: "AI",
    iconUrl: "https://cdn.simpleicons.org/openai",
    authKinds: ["api_key"],
    apiKey: {
      fields: [
        {
          key: "api_key",
          label: "API key",
          secret: true,
          hint: "From platform.openai.com — starts with `sk-`.",
        },
      ],
      testUrl: "https://api.openai.com/v1/models",
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    blurb: "Claude — sonnet, opus, haiku.",
    glyph: "Λ",
    iconUrl: "https://cdn.simpleicons.org/anthropic",
    authKinds: ["api_key"],
    apiKey: {
      fields: [
        {
          key: "api_key",
          label: "API key",
          secret: true,
          hint: "From console.anthropic.com — starts with `sk-ant-`.",
        },
      ],
      testUrl: "https://api.anthropic.com/v1/models",
    },
  },
  {
    id: "stripe",
    name: "Stripe",
    blurb: "Payments, subscriptions, billing.",
    glyph: "S",
    iconUrl: "https://cdn.simpleicons.org/stripe",
    authKinds: ["api_key"],
    apiKey: {
      fields: [
        {
          key: "api_key",
          label: "Secret key",
          secret: true,
          hint: "`sk_live_…` for production, `sk_test_…` for sandbox.",
        },
      ],
      testUrl: "https://api.stripe.com/v1/balance",
    },
  },

  /* ----- OAuth providers (Phase C) ----- */
  {
    id: "gmail",
    name: "Gmail",
    blurb: "Send mail, parse incoming threads, label messages.",
    glyph: "G",
    iconUrl: "https://cdn.simpleicons.org/gmail",
    authKinds: ["oauth"],
    oauth: {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
      clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
    },
  },
  {
    id: "slack",
    name: "Slack",
    blurb: "Post messages, react, listen to events.",
    glyph: "#",
    iconUrl: "https://cdn.simpleicons.org/slack",
    authKinds: ["oauth"],
    oauth: {
      authUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      scopes: ["chat:write", "channels:read", "users:read"],
      clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
      clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
    },
  },
  {
    id: "notion",
    name: "Notion",
    blurb: "Read/write pages, databases, comments.",
    glyph: "N",
    iconUrl: "https://cdn.simpleicons.org/notion",
    authKinds: ["oauth"],
    oauth: {
      authUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      scopes: [],
      clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
      clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
    },
  },
  {
    id: "github",
    name: "GitHub",
    blurb: "Repos, PRs, issues, releases.",
    glyph: "GH",
    iconUrl: "https://cdn.simpleicons.org/github",
    authKinds: ["oauth"],
    oauth: {
      authUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:org"],
      clientIdEnv: "GITHUB_OAUTH_CLIENT_ID",
      clientSecretEnv: "GITHUB_OAUTH_CLIENT_SECRET",
    },
  },
  {
    id: "airtable",
    name: "Airtable",
    blurb: "Read/write base records and views.",
    glyph: "A",
    iconUrl: "https://cdn.simpleicons.org/airtable",
    authKinds: ["oauth"],
    oauth: {
      authUrl: "https://airtable.com/oauth2/v1/authorize",
      tokenUrl: "https://airtable.com/oauth2/v1/token",
      scopes: ["data.records:read", "data.records:write"],
      clientIdEnv: "AIRTABLE_OAUTH_CLIENT_ID",
      clientSecretEnv: "AIRTABLE_OAUTH_CLIENT_SECRET",
    },
  },

  /* ----- transactional providers (API-key) ----- */
  {
    id: "sendgrid",
    name: "SendGrid",
    blurb: "Transactional email API.",
    glyph: "✉",
    iconUrl: "https://cdn.simpleicons.org/sendgrid",
    authKinds: ["api_key"],
    apiKey: {
      fields: [
        {
          key: "api_key",
          label: "API key",
          secret: true,
          hint: "`SG.…` from SendGrid Settings → API Keys.",
        },
      ],
      testUrl: "https://api.sendgrid.com/v3/scopes",
    },
  },
  {
    id: "twilio",
    name: "Twilio",
    blurb: "SMS, voice, programmable messaging.",
    glyph: "T",
    iconUrl: "https://cdn.simpleicons.org/twilio",
    authKinds: ["basic"],
    apiKey: {
      fields: [
        {
          key: "account_sid",
          label: "Account SID",
          secret: false,
          hint: "Twilio Console → Account → API Credentials.",
        },
        { key: "auth_token", label: "Auth Token", secret: true },
      ],
    },
  },

  /* ----- databases (basic / API-key) ----- */
  {
    id: "postgres",
    name: "PostgreSQL",
    blurb: "Connection string for any Postgres server.",
    glyph: "Pg",
    iconUrl: "https://cdn.simpleicons.org/postgresql",
    authKinds: ["api_key"],
    apiKey: {
      fields: [
        {
          key: "connection_string",
          label: "Connection string",
          secret: true,
          hint: "`postgresql://user:pass@host:5432/db?sslmode=require`",
        },
      ],
    },
  },
  {
    id: "mysql",
    name: "MySQL",
    blurb: "Connection string for any MySQL server.",
    glyph: "My",
    iconUrl: "https://cdn.simpleicons.org/mysql",
    authKinds: ["api_key"],
    apiKey: {
      fields: [
        {
          key: "connection_string",
          label: "Connection string",
          secret: true,
          hint: "`mysql://user:pass@host:3306/db`",
        },
      ],
    },
  },

  /* ----- connect any website with a login ----- */
  {
    id: "website",
    name: "Website login",
    blurb: "Connect any site with your username and password.",
    glyph: "🌐",
    authKinds: ["basic"],
    apiKey: {
      fields: [
        {
          key: "site_url",
          label: "Site URL",
          secret: false,
          hint: "e.g. `https://app.example.com` — the site you sign in to.",
        },
        { key: "username", label: "Username or email", secret: false },
        { key: "password", label: "Password", secret: true },
      ],
    },
  },

  /* ----- fallbacks ----- */
  {
    id: "webhook",
    name: "Webhook",
    blurb: "Outbound webhook URL with an optional signing secret.",
    glyph: "⇲",
    authKinds: ["api_key"],
    apiKey: {
      fields: [
        { key: "url", label: "Webhook URL", secret: false },
        {
          key: "signing_secret",
          label: "Signing secret",
          secret: true,
          hint: "Optional. Used to HMAC-sign each payload.",
        },
      ],
    },
  },
  {
    id: "http_basic",
    name: "HTTP Basic Auth",
    blurb: "Username + password for any HTTP API.",
    glyph: "K",
    authKinds: ["basic"],
    apiKey: {
      fields: [
        { key: "username", label: "Username", secret: false },
        { key: "password", label: "Password", secret: true },
      ],
    },
  },
  {
    id: "generic_api_key",
    name: "Generic API Key",
    blurb: "Any service with a single API-key header.",
    glyph: "·",
    authKinds: ["api_key"],
    apiKey: {
      fields: [
        {
          key: "header_name",
          label: "Header name",
          secret: false,
          hint: "e.g. `Authorization` or `X-API-Key`.",
        },
        { key: "api_key", label: "API key", secret: true },
      ],
    },
  },
];

export function getProvider(id: string): ProviderDescriptor | null {
  return PROVIDER_CATALOG.find((p) => p.id === id) ?? null;
}
