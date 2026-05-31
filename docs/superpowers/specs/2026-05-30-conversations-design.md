# Multi-conversation Chat History (sub-projects A+B) — Design

**Date:** 2026-05-30
**Repos:** `cantila-control-plane` (A: model + endpoints) and `cantila-console` (B: thread-list UI)
**Status:** Approved design — ready for implementation
**Predecessor:** the rich chat UX (sub-project C) shipped 2026-05-30. This adds the multiple-conversations history the chat was designed to host.

## Goal

Give each project **multiple chat conversations** (like ChatGPT/Claude): list, switch, rename, delete, start new — accessed via a **slide-over history panel** in the chat column. Existing single-thread history is preserved as a default conversation. Surfaces `createdAt` so per-message **timestamps** render (closing the C follow-up).

## Current state

`ProjectMessage` rows hang directly off a project (`role, agent, kind, content, metadata, createdAt`, index `[projectId, createdAt]`). Chat endpoints: `GET /v1/projects/:id/chat` (history), `POST …/chat` and `POST …/build` (SSE streams). No conversation concept.

## A — Backend (control-plane)

### Schema
- **New `Conversation` model:**
  ```prisma
  model Conversation {
    id        String   @id @default(cuid())
    project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
    projectId String
    title     String   @default("New chat")
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt
    messages  ProjectMessage[]
    @@index([projectId, updatedAt])
  }
  ```
- **`ProjectMessage` gains** `conversationId String?` + `conversation Conversation? @relation(fields: [conversationId], references: [id], onDelete: Cascade)` + `@@index([conversationId, createdAt])`. Nullable so pre-existing rows keep working until backfilled.
- **Migrations (idempotent, in `boot-migrations.ts`):**
  - `CREATE TABLE IF NOT EXISTS "Conversation" (...)` with the columns above + FK.
  - `ALTER TABLE "ProjectMessage" ADD COLUMN IF NOT EXISTS "conversationId" TEXT;`
  - The supporting indexes `IF NOT EXISTS`.
  (Prisma schema is the source of truth; the boot-migration mirrors it so the prisma-baselined prod path gets the table/column without a 500.)

### Backfill — `ensureDefaultConversation(projectId)`
Idempotent. If the project has no conversation yet, create one (title "Main") and `UPDATE "ProjectMessage" SET "conversationId" = <id> WHERE "projectId" = ? AND "conversationId" IS NULL`. Returns the default conversation id. Called by the list endpoint and by chat/build when no `conversationId` is supplied, so legacy history appears intact under "Main".

### Control-plane methods
- `listConversations(projectId)` → `{ id, title, createdAt, updatedAt, messageCount, lastPreview }[]` (ensures default first; ordered by `updatedAt` desc).
- `createConversation(projectId, title?)` → the new conversation (title defaults "New chat").
- `renameConversation(projectId, cid, title)` → updated row | null (404 if not found / wrong project).
- `deleteConversation(projectId, cid)` → ok | null (cascade deletes its messages).
- Thread `conversationId` through the existing message-persist path used by chat/build so streamed rows carry it; on the **first user message** of an untitled conversation, set `title` to the truncated prompt; bump `updatedAt` on each new message.
- `getChat(projectId, conversationId?)` → messages for that conversation (default conversation when omitted).

### Endpoints (`src/index.ts`, behind `assertProjectAccess`, zod-validated)
| Method & path | Purpose |
|---|---|
| `GET /v1/projects/:id/conversations` | list (ensures default) |
| `POST /v1/projects/:id/conversations` | create `{ title? }` → 201 |
| `PATCH /v1/projects/:id/conversations/:cid` | rename `{ title }` |
| `DELETE /v1/projects/:id/conversations/:cid` | delete (cascade) |
| `GET /v1/projects/:id/chat?conversationId=…` | scoped history (default when omitted) |
| `POST /v1/projects/:id/chat` / `…/build` | accept `conversationId` in body; attach streamed rows to it |

Errors: 404 project/conversation not found; 400 bad body. Deleting the last conversation is allowed; the list endpoint re-ensures a default on next load.

## B — Frontend (console)

### API client (`src/lib/api.ts`)
Add to `builderApi`: `listConversations(projectId)`, `createConversation(projectId, title?)`, `renameConversation(projectId, cid, title)`, `deleteConversation(projectId, cid)`; extend the chat-history loader to accept `conversationId`, and `chatStream`/`buildStream` to send `conversationId` in the POST body. Types: `ApiConversation { id, title, createdAt, updatedAt, messageCount, lastPreview }`.

### Components
- **`chat/HistoryPanel.tsx`** (new) — a slide-over (right or left) over the chat. Lists conversations (title + relative last-activity from `updatedAt`), highlights the active one, supports select, inline **rename**, **delete** (confirm), and **＋ New chat**. Closes back to the full chat.
- **`ProjectChat.tsx`** (modified) — add `conversationId` + `conversations` state and a slim **top bar**: ☰ history toggle · current conversation title · **＋ New chat**.
  - On mount: `listConversations`; pick the last-active id from `localStorage` (`cantila:chat-conv:<projectId>`) or the first (default). Load that conversation's history.
  - Switch: set active id, load its history, persist.
  - **New chat:** clear to an empty thread with `conversationId = null` (pending); on first send, `createConversation` then stream with the new id, and refresh the list (auto-title follows from the backend).
  - Streaming/regenerate/edit all pass the active `conversationId`.
- **Timestamps:** `ChatMessage` now renders the message `createdAt` (the C follow-up) — the history payload already carries it; thread it through `projectMessagesToChat`.

### Data flow
1. mount → `listConversations` (backend ensures "Main") → choose active → `getChat(conversationId)` → render.
2. send → if `conversationId` null, `createConversation` → use its id → `runStream(mode, text, conversationId)`; else stream directly. Backend attaches rows + auto-titles + bumps `updatedAt`.
3. history panel actions call the CRUD endpoints and refresh the list; deleting the active conversation falls back to the top of the list (or a fresh default).

## Error handling
- Conversation list/load failure → show the existing single-thread fallback (load `/chat` with no id → default) + a small error note; never blank the chat.
- Rename/delete failure → toast/inline error, list refetch.
- Deleting the active conversation → switch to the most-recent remaining (or new default).
- Migration/backfill: all idempotent; `ensureDefaultConversation` is safe to call repeatedly and concurrently (guard on "no conversation exists" then create; a unique race just yields two — acceptable, or dedupe by created order).

## Testing
- Control-plane `node:test` (`npx tsx --test`): `ensureDefaultConversation` idempotency + null-row backfill (in-memory store); create/rename/delete; chat persist attaches `conversationId` + auto-titles; `listConversations` ordering + counts. Typecheck clean except pre-existing `fleet`.
- Console: no runner — `npm run lint` + `npm run build` + manual: list/switch/new/rename/delete; new-chat lazily creates on first send; timestamps render; last-active persists; legacy history appears under "Main".

## Files
**Control-plane — new:** `Conversation` in `prisma/schema.prisma`; boot-migration entries; tests.
**Control-plane — modified:** `src/core/control-plane.ts` (conversation methods + thread `conversationId` through chat/build persistence + `getChat`), `src/index.ts` (routes + zod), `src/domain/boot-migrations.ts`, `src/domain/types.ts` + stores (Conversation + `ProjectMessage.conversationId`).
**Console — new:** `src/components/chat/HistoryPanel.tsx`.
**Console — modified:** `src/lib/api.ts`, `src/components/ProjectChat.tsx`, `src/components/chat/ChatMessage.tsx` (+ `projectMessagesToChat` for `createdAt`).
