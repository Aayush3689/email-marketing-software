# FastConnect — Project Context & Engineering Guide

FastConnect is a self-hosted email infrastructure, transactional mail, webmail, and Kit-inspired email marketing platform built as a TypeScript/Node + React monorepo backed by PostgreSQL, Redis, RabbitMQ, Dovecot, and a Rust MTA (`mail-engine`).

## Repository Layout

### Apps (`apps/`)
- `apps/api` (`@mail/api`, Express 5, port `4000`): REST API (`/v1/*`, `/admin/v1/*`, `/healthz`, `/readyz`).
  - Routes (`apps/api/src/routes/`): `auth.ts`, `domains.ts`, `emails.ts`, `mailboxes.ts`, `credentials.ts`, `campaigns.ts`, `marketing-platform.ts`, `webhooks.ts`, `analytics.ts`, `admin.ts`, `health.ts`.
  - PostgreSQL stores (`apps/api/src/stores/`): `pg-stores.ts`, `pg-marketing-platform-store.ts` (and `InMemory*` stores inside routes for fast isolated integration tests).
- `apps/web` (`@mail/web`, Vite + React 19 + TanStack Query v5 + Tailwind v4, port `5173`): Customer Developer Console (`OverviewView.tsx`, `DomainsView.tsx`, `CredentialsView.tsx`, `CampaignsView.tsx`, `WebhooksBillingView.tsx`).
- `apps/mail` (`@mail/webmail`, port `5174`): Webmail frontend.
- `apps/admin` (`@mail/admin`, port `5175`): Super Admin dashboard.

### Shared Packages (`packages/`)
- `packages/shared-types` (`@mail/shared-types`): Canonical domain, campaign, marketing, analytics, and API DTO types.
- `packages/validation` (`@mail/validation`): Zod request schemas and normalizers.
- `packages/ui` (`@mail/ui`): Shared primitives (`Button`, `Input`, `Badge`, `Card`, `AppDialog`, `AppSwitch`, `EmptyState` in `packages/ui/src/components/primitives.tsx`) and theme tokens in `packages/ui/src/styles/theme.css`.

### Services & Rust MTA (`services/`, `crates/`)
- `services/mail-engine` + `crates/*` (Rust 2021 workspace, `unsafe_code = "forbid"`): SMTP inbound/outbound, `crates/dkim` (fail-closed DKIM signing, versioned multi-KEK ring), `crates/delivery-engine`, `crates/bounce-handler`, `crates/queue-engine`, metrics/health on `:9100`.
- `services/mailbox-service` (`@mail/mailbox-service`, port `4100`) and `services/scheduler` (`@mail/scheduler`).

### Database, Infra & Docs
- `migrations/`: Sequential SQL migrations (`0001_initial_schema.sql` through `0006_dkim_hardening.sql`). Apply with `scripts/migrate.sh` or `psql`.
- `infrastructure/docker/docker-compose.yml`: Defines `postgres`, `redis`, `rabbitmq`, `dovecot`, `api`, `scheduler`, `mailbox-service`, `mail-engine`, `web`, `mail`, `admin`, `prometheus`, `grafana`, `nginx`.
- `docs/`: Architecture, schema, security, roadmap, and deployment docs.

---

## Core Architecture & Product Modules

### 1. Email Marketing & Audience Platform (`apps/web/src/components/marketing/`, `0005_kit_email_marketing.sql`)
- **Single Normalized Audience**: Contacts are stored once (`contacts` + `tags` + `subscriber_tags` + `custom_fields` + `segments`). Never duplicate contacts per list/campaign or fork tag tables.
- **Centralized Tag Sync**:
  - Frontend tag selectors (`TagSelector.tsx`: `useCentralTags()`, `TagMultiSelect`, `TagSingleSelect`) share `queryKey: ['tags']` and call `invalidateAllTagDependents(qc)` on mutations.
  - Subscribers view (`SubscribersSection.tsx`) includes a collapsible right-side Tag Management Sidebar (desktop grid + mobile drawer) backed by `tagId` batch actions (`POST /v1/subscribers/bulk`).
  - Dynamic segments (`SegmentsBuilderSection.tsx`), CSV import (`ImportExportAndSuppressions.tsx`), automations (`SequencesAutomationsGrowthSections.tsx`), and broadcast audience filters (`BroadcastComposerWorkspace.tsx`) resolve central tags via `tagId` / `tags` store so tag renames propagate automatically.
- **Full-Width Broadcast Composer & Autosave**:
  - Broadcast creation/editing opens full-width `BroadcastComposerWorkspace.tsx` (persisted across refresh via `sessionStorage`), not a modal.
  - `useBroadcastDraftAutosave.ts` + pure helpers `marketingDraftHelpers.ts` implement debounced sequential server saves, offline detection, per-draft `localStorage` recovery, and optimistic concurrency via `expectedUpdatedAt`.
  - Backend `PATCH /v1/campaigns/:id` returns HTTP `409` `{ error: { code: 'DRAFT_CONFLICT', details: { latestCampaign } } }` on stale updates and `409` `CAMPAIGN_LOCKED` on non-editable statuses.
  - `POST /v1/campaigns/:id/send-test` routes via `submitTransactionalEmail` without `campaignId` or `campaign_recipients` rows so test emails stay isolated from broadcast analytics.

### 2. DKIM & Deliverability Invariants
- Never modify DKIM fail-closed behavior to silently fall back to unsigned sending (`mail-engine` / `crates/dkim`).
- Never log or expose private DKIM keys, KEK secrets, API secrets, SMTP credentials, or `.env` values.

---

## Strict Coding & TypeScript Conventions

1. **TypeScript Compiler Settings (`tsconfig.base.json`)**:
   - `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"module": "NodeNext"`.
   - Always use `.js` extensions on relative TS imports.
   - Never pass explicit `undefined` to optional props/fields; use conditional spreads (`...(val ? { val } : {})`).
2. **Design System Tokens (`packages/ui/src/styles/theme.css`)**:
   - Both light and dark themes must remain supported. Always use `--color-*` tokens (`--color-bg`, `--color-surface`, `--color-surface-muted`, `--color-border`, `--color-border-strong`, `--color-text`, `--color-text-muted`, `--color-accent`, `--color-accent-fg`, `--color-brand`, `--color-brand-soft`, `--color-danger`, `--color-success`, `--color-warning`) — never invent `--bg-*`, `--fg-*`, or `--accent`.
3. **API Error Envelope**:
   - API errors follow `{ error: { code, message, details?, requestId } }`. In `@mail/web`, `ApiError.extra` holds `payload.error` (so structured payloads like `latestCampaign` live under `err.extra?.details`).

---

## Verification & Deployment Commands

### Local Development & CI Checks (Node >=22.0.0, npm >=10.0.0)
Always run after changes and ensure zero errors before committing/pushing:
```bash
npm run build && npm run typecheck && npm run test && npm run lint
```

### EC2 Production Updates
EC2 checkout path: `/opt/apps/mail-service/current/email-marketing-software`
```bash
git pull origin main
sudo docker compose --env-file .env -f infrastructure/docker/docker-compose.yml \
  up -d --no-deps --build api web
sudo docker compose --env-file .env -f infrastructure/docker/docker-compose.yml \
  exec -T nginx nginx -s reload
```
(Add changed services like `mail-engine`, `scheduler`, `mailbox-service`, `mail`, `admin`, or run migrations if `migrations/` changed.)
