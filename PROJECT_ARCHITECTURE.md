# ProjectX Architecture Guide

> Read-only reverse engineering based on the checked-in project and the supplied column inventory. No application code was changed. This document describes observed source paths and calls; it does not claim that the deployed Supabase project or policies were verified.

# 1. Project Overview

ProjectX is a multi-page real-estate marketplace prototype/site for browsing properties and maps, viewing property details, saving listings, contacting brokers, and managing listings and users through Broker, Employee, and Admin workspaces. The pages are mostly static HTML with utility-class styling and browser-side JavaScript. Supabase is the hosted authentication, database, file storage, realtime and Edge Function provider.

The key architectural fact is that there is no project-owned application server or REST API in this repository. Browser modules use the Supabase JS client and the configured public/anon key to query Postgres and Storage directly. A single Supabase Edge Function is called directly for staff-user creation; its implementation is external to this repository.

# 2. Tech Stack

- Static HTML pages, vanilla JavaScript (ES modules and inline scripts), shared `style.css`.
- Vite dev server/build and `@tailwindcss/vite`; Tailwind utility classes are extensively embedded in HTML.
- `@supabase/supabase-js` v2 for auth, PostgREST database access, Storage, Realtime and an Edge Function call.
- Leaflet 1.9.4 loaded from unpkg for map display and location pickers; map tiles/geocoding use OpenStreetMap/Nominatim paths in the code.
- Google Fonts / Material Symbols, Unsplash image URLs.
- `pptxgenjs` for a standalone script under `scripts/` that generates a presentation; not part of site runtime.
- Vercel static deployment rewrites in `vercel.json`.

# 3. Folder Structure

- Root HTML files: independent user-facing pages and role workspaces. Vite builds these as multiple HTML entry points.
- `lib/`: shared Supabase client construction (`lib/supabase.js`).
- `assets/images/`: supplied screen images; no evidence they are required for core runtime.
- `scripts/`: one presentation generation script.
- `open-design/`: excluded from Vercel deployment by `.vercelignore`; no runtime imports found in the inventory.
- `.cursor/`: local debug artifact, excluded from app architecture.
- `node_modules/`: installed dependencies; not application source.
- `.env`: contains `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Values intentionally not reproduced.

# 4. Application Entry Points

- `index.html` is the default homepage. Vite serves it at `/` and also builds it as the `main` entry.
- `vite.config.js` enumerates the HTML pages as build inputs. There is no JavaScript SPA root or framework mount point.
- Most pages include `<script type="module" src="/auth.js">`. This imports `lib/supabase.js`, runs `checkAuth()`, wires common page behavior and supplies shared page/business logic.
- Several page-specific inline modules execute directly from their HTML: notably admin, employee, map, profile, login, setup and shared-filter.
- `signup.html` and `/signup` are rewritten to `login.html` by Vite middleware and Vercel rewrites. In the login page, `?mode=signup` or the `signup.html` route switches the form to account-creation mode.

# 5. Architecture

This is a static multi-page frontend with a shared, unusually large browser module, rather than a conventional client/server application. `auth.js` combines authentication/role checks, page initialization, listing CRUD, media handling, filters, inquiries, messaging, notifications, report submission, navigation, and shared helpers. Admin and Employee pages each have substantial inline Supabase logic of their own. Buyer-facing behavior is split between `auth.js` and inline scripts; `demo-data.js` is included on selected pages but appears not to populate their live grids.

There is no local router library. The app has native links/full navigation plus a custom fetch-and-swap navigation layer in `auth.js` (`ajaxLoadPage`, `syncHead`, `executeScripts`, `popstate`). Supabase is both the identity provider and the app data API. Database authorization ultimately depends on Supabase Auth/RLS and Storage policies, which are not included in the supplied schema excerpt and cannot be verified here.

State is split across the current DOM and module globals, Supabase session storage managed by Supabase JS, `localStorage`, database rows, and uploaded Storage objects. Examples include the selected role/user name, saved listing IDs, profile caches, referral ID, listing-media draft state, and current page context.

# 6. Frontend Flow

1. Browser requests an HTML page. Its HTML/CSS and any CDN resources load.
2. `auth.js` initializes current route information and imports the shared client. It parses referral query data into local storage, then calls `checkAuth()`.
3. `checkAuth()` reads the Supabase session; when signed in it reads `profiles.role` and saved IDs from `profiles.preferences`. It redirects or allows the page based on `roleAllowedPages` / `roleHomePage` in `auth.js`.
4. `initAppPage()` wires page-specific logic, shared navigation and role interactions. The page may also execute its own inline module directly.
5. User actions call functions in `auth.js` or inline page modules. Most data operations go straight through `supabase.from(...)`, `.auth`, `.storage`, or `.channel` to Supabase.
6. Returned data is used to update the DOM; some values are mirrored to localStorage. Realtime notification events cause re-queries and DOM updates.
7. Navigation often goes through `navigateTo()` and the custom `ajaxLoadPage()` fetch/swap lifecycle; other links and redirects perform full page loads.

The custom router executes scripts from newly fetched bodies and re-runs `initAppPage()`. This is a fragile lifecycle boundary: some scripts are also registered or attached directly, and their behavior depends on script execution order and page initialization flags.

# 7. Backend Flow

There is no backend folder, server entry point, controller/service/repository stack, or local API route. Browser → Supabase flow is typically:

`HTML event` → `auth.js` or page inline function → Supabase JS client → Supabase Auth/PostgREST/Storage/Realtime → result/error → DOM/localStorage.

Admin staff creation makes a `fetch` POST to the Supabase Edge Function `create-staff-user`, sending JSON and an authorization header. The Edge Function source and its internal validation are UNKNOWN here. Vercel serves static assets and URL rewrites; it does not implement business endpoints in the visible configuration.

# 8. Authentication

- Shared client: `lib/supabase.js` constructs a Supabase client from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- Signup/login UI: `auth.js` initializes the login/signup form. Signup calls `supabase.auth.signUp(...)`, then inserts a profile row into `profiles`; login calls `supabase.auth.signInWithPassword(...)`, reads/creates profile data and routes according to role. `login.html` contains referral lookup/CTA logic.
- Staff login uses `staff-login.html` with shared `auth.js`; the exact credential and role gate logic is in the login handlers in `auth.js` and the staff panels' own checks.
- Session validation is client-side through `supabase.auth.getSession()` and profile lookups. `checkAuth()` in `auth.js` does page allowlisting and role-home redirects. `admin-panel.html` and `employee-panel.html` independently call `checkAuth()` and require an exact role.
- Logout calls `supabase.auth.signOut()` and clears local `role` / `userName` values. `window.logout` in `auth.js`; Admin and Employee also have page-local logout logic.
- Supabase JS manages the auth session/token; app code also stores role and display information in localStorage. The bearer/session is sent through the Supabase client to Supabase endpoints.
- No password reset or OTP flow was found in the source inventory. Email confirmation behavior depends on Supabase project settings and was not verifiable.
- `setup.html` contains a browser-side first-Admin setup form that signs up through Supabase Auth and inserts an Admin profile. It has a direct Supabase URL/key literal in the page source (values omitted here); do not mistake that page for a secure server-only bootstrap.

Role authorization is partly frontend navigation/UI logic and partly expected Supabase policy enforcement. Frontend checks are not an adequate security boundary by themselves. Actual RLS and Storage policies were not supplied, so effective authorization is UNKNOWN.

# 9. Authorization / Roles

Roles observed in the app include `Guest`, `Buyer`, `Broker`, `Employee`, and `Admin`; Employee records also have `employee_type` in the supplied schema. `auth.js` maps roles to allowed pages/home pages and syncs the active role into localStorage. It contains a special Admin-as-role-switch behavior. `admin-panel.html` requires `Admin`; `employee-panel.html` requires `Employee`; the broker dashboard is initialized from shared broker logic. Employee code filters/assigns review work and has permitted status transitions. These browser checks gate interface access; server-side enforcement must come from Supabase policies/Edge Function validation, which are unavailable for inspection.

# 10. Database Structure

The user supplied column metadata for these tables. It did not include primary-key declarations, foreign-key constraints, unique constraints, indexes, triggers, views, or RLS policies. The following arrows mean “the app/schema has matching ID fields and code uses them together,” not a verified database foreign key.

```text
profiles.id ← listings.broker_id / created_by / verifier IDs
profiles.id ← inquiries.broker_id / buyer_id
profiles.id ← messages.buyer_id / broker_id / sender_id
profiles.id ← notifications.user_id
profiles.id ← custom_filters.broker_id
profiles.id ← listing_media.broker_id
profiles.id ← listing_referrals.broker_id
profiles.id ← listing_status_history.changed_by

listings.id ← listing_media.listing_id
listings.id ← listing_referrals.listing_id
listings.id ← listing_status_history.listing_id
listings.id ← inquiries.listing_id
listings.id ← messages.listing_id
```

Tables and purposes inferred from names/columns and code:

- `profiles`: application profile, role, contact/profile fields, JSON preferences, referral relation. `auth.js` queries profile by Auth user ID; profile page edits fields and avatar URL.
- `listings`: property record, status, price/intent/type, dimensions, coordinates, verification and assignment fields. Main CRUD table.
- `listing_media`: listing images/videos and ordering/cover metadata; used by listing editor and detail page.
- `inquiries`: buyer/broker contact messages, read state and broker reply.
- `messages`: buyer/broker conversation messages, sender and read fields.
- `custom_filters`: saved broker filters, JSON criteria, slug/public flag; shared-filter page loads by slug.
- `listing_status_history`: moderation/status changes and reasons.
- `notifications`: user notifications and read state; shared module subscribes to Postgres changes.
- `reports`: referenced by Admin/Employee moderation/report workflows. Its columns were not present in the supplied column dump.
- `listing_referrals`: referral code/click tracking shape; code use is limited/unclear.

The supplied dump included columns only and did not explicitly declare PKs. `id` fields are used as row identifiers in application filters. Several defaults are visible (e.g. timestamps, status, counters), but constraints/indexes cannot be established. One notable schema detail is `profiles.password`; the inspected application signup path uses Supabase Auth and did not show a need to write this field. Whether it is populated or protected is UNKNOWN.

# 11. API Map

All listed table operations are browser-to-Supabase PostgREST calls through the JS SDK, not local HTTP endpoints. Exact request/response serialization is Supabase-managed.

| Data/service | Operations visible in code | Main callers |
|---|---|---|
| `profiles` | select, insert, update, delete; equality and `in` filters; exact counts | `auth.js`, `profile.html`, `admin-panel.html`, `employee-panel.html`, `shared-filter.html`, `setup.html`, `login.html` |
| `listings` | select, insert, update, delete; filters by ID/status/owner/assignment; order; exact counts | `auth.js`, Admin/Employee inline modules, `map.html`, `shared-filter.html`, profile/details flows |
| `listing_media` | select, delete then insert; media URL metadata | `auth.js`, property detail flow |
| `inquiries` | select, insert, update read/reply; counts | `auth.js`, Admin, profile/details |
| `messages` | select and insert; conversation/read filtering | `auth.js` |
| `custom_filters` | select, insert, update/delete, slug lookup, criteria tests | `auth.js`, `shared-filter.html` |
| `listing_status_history` | insert audit row | `auth.js` |
| `notifications` | select, insert, update read state; realtime Postgres channel | `auth.js` |
| `reports` | select, insert, update | shared report submission, Admin and Employee panels |
| Storage `properties` | upload and public URL resolution | `auth.js` listing media upload |
| Storage `avatars` | upload, public URL resolution | `profile.html` |
| Edge Function `create-staff-user` | POST JSON with auth header | `admin-panel.html` |

No stable REST endpoint catalog exists in the repository. Query parameters primarily control page behavior (`id`, `intent`, `q`, `slug`, `mode`, `ref`); filtering details live in browser query builders. The Edge Function's exact accepted JSON schema is visible in Admin code but its server validation/response contract is external.

# 12. External Services

- **Supabase** — auth, Postgres API, Storage, Realtime, Edge Function. Used in `lib/supabase.js`, `auth.js`, page inline modules. Sends credentials/profile/listing/inquiry/message/media/report/notification data; receives rows, sessions, URLs and event notifications. Actual deployed policies/Edge Function code UNKNOWN.
- **OpenStreetMap / Nominatim / Leaflet** — maps, location search/geocoding and listing coordinates. Leaflet scripts/styles load from unpkg; tile and Nominatim request specifics are in `map.html` / `auth.js`.
- **Google Fonts** — Outfit and Material Symbols styles requested by most pages.
- **Unsplash / Google-hosted images** — external image assets used as page/listing imagery.
- **Vercel** — static deployment configuration and rewrites (`vercel.json`); no server functions configured in this repository.

# 13. Major Feature Flows

### Login, signup, role selection

Form action → `auth.js` login page initializer → `supabase.auth.signInWithPassword` or `.signUp` → profile select/insert (`profiles`) → store role/name and navigate to role home. Referral query `ref` is cached in localStorage and `login.html` loads inviter profile information. Supabase creates the authenticated session; role display/navigation state is separately cached locally.

### Buyer search and listing browse

Search interaction → `initBuyerHomePage()` / `initBuyerListingsPage()` in `auth.js` or inline map logic → URL filters/navigation; listings are fetched from Supabase in `auth.js` / `map.html`. Filters, sort/view state and result DOM are primarily client-side. `demo-data.js` defines one sample listing but its own seeding guard skips the pages that include it.

### Map search

User opens `map.html` → Leaflet map initialization → `loadListings()` directly selects active rows from `listings` → markers/cards and client filters update → location text search uses Nominatim/geocoding path → selecting marker/listing navigates to property details.

### Property details, save, contact

Listing link with `?id=` → `initBuyerDetailsPage()` in `auth.js` queries `listings`, broker profile, media and status history → renders detail page. Save toggles localStorage `savedProperties` and syncs IDs into `profiles.preferences`. Contact creates an `inquiries` row. Buyer/broker chat reads and inserts `messages`; the profile/dashboard UI refreshes message state.

### Broker listing CRUD and media

Broker opens dashboard → shared listing manager loads listing rows → create/edit modal collects fields and coordinates → `saveListingForm()` inserts/updates `listings`; media upload uses Supabase Storage bucket `properties`, then `saveListingMedia()` replaces `listing_media` rows → listing grid/dashboard refreshes. Delete calls `deleteListing()` against `listings`; database cascades cannot be assumed.

### Inquiries and chat

Broker loads inquiries → `renderInquiries()` selects `inquiries`; opening one marks read; reply updates `broker_reply` and `read`. Chat helpers in `auth.js` query and insert `messages`, with profile/listing reads to label conversations.

### Custom filters and sharing

Broker creates criteria → `saveCustomFilter()` writes JSON criteria to `custom_filters` with slug/public fields → share link copied through `copyShareLink()` → `shared-filter.html` resolves route/query slug, checks public/access context, loads criteria and queries matching `listings`. `testCustomFilter()` tests criteria from the manager.

### Admin operations

`admin-panel.html` local `checkAuth()` verifies session/profile role → count queries populate stats → inline functions load/delete profiles, moderate/delete listings, load reports and update related records → staff creation POSTs `create-staff-user` Edge Function. Admin screen writes are direct to Supabase, so effective permission depends on policies.

### Employee moderation and reports

`employee-panel.html` local `checkAuth()` gates Employee → review queue queries assigned/pending listings → permitted transitions update `listings` and invoke shared history/notification helpers where wired → report queue loads `reports` and related listing/profile labels → status/report updates go direct to Supabase.

### Profile and avatar

`profile.html` obtains session and profile, falls back to localStorage cache, and renders buyer/broker-specific views → update handlers write `profiles` → avatar upload stores to `avatars`, resolves public URL and updates profile/cache. Saved listings and notes also have localStorage behavior.

### Sell/valuation

`sell.html` displays a valuation/contact form; source inspection did not show a corresponding backend persistence/API flow. Treat it as a frontend form until verified at runtime.

### Notifications and reports

Shared `auth.js` inserts reports and status/notification rows; notification helpers load unread counts, update read flags and subscribe to `notifications` changes via Supabase Realtime. UI badges and lists are then refreshed.

# 14. Important Files

For each file: purpose; callers/dependents; key behavior.

- `auth.js` — shared app runtime used by most pages. Depends on `lib/supabase.js`, DOM IDs/classes, Leaflet where needed. Central functions include `checkAuth`, `initAppPage`, `initBuyer*Page`, listing manager functions, `saveListingForm`, inquiry/custom-filter managers, `ajaxLoadPage`, messaging, report, notification and geocoding helpers. Highest coupling and change risk.
- `lib/supabase.js` — shared client imported by `auth.js` and page modules. Depends on Vite `import.meta.env`. Failure to configure required env prevents database use/client construction.
- `index.html`, `properties.html`, `map.html`, `property-details.html` — buyer/public surfaces, load shared runtime; `properties` and `map` also include `demo-data.js`. Map has direct inline Supabase query and Leaflet setup.
- `broker-dashboard.html` — broker workspace shell and navigation; shared broker logic is largely in `auth.js`.
- `admin-panel.html` — Admin UI and a large inline Supabase implementation; stats, user/listing management, reports and staff creation.
- `employee-panel.html` — Employee UI and inline moderation/report operations.
- `login.html`, `staff-login.html`, `signup.html`, `setup.html` — auth entry and one-time Admin bootstrap. `setup.html` has separate direct client config.
- `profile.html` — profile, saved listings, avatar and profile data, directly integrated with Supabase and localStorage.
- `shared-filter.html` — public/shared filter resolver and listing display.
- `demo-data.js` — one hard-coded demo listing, card builders, and a seeding function. Included by `properties.html` and `map.html`, but its DOM-ready handler skips those pages; `index.html` does not include it. Static search found no call from `auth.js` to its exported helpers, so practical usage is unclear.
- `style.css`, `tailwind.config.js`, `design_system.json` — shared styles, Tailwind theme/plugin config and design reference.
- `vite.config.js`, `vercel.json`, `package.json` — dev/build multipage routing, deploy rewrites and runtime dependencies.
- `scripts/generate-estatepro-vs-99acres-ppt.js` — standalone presentation generator; separate from web app.

# 15. Dependency / Call Map

```text
HTML pages
 ├─ auth.js ─ lib/supabase.js ─ Supabase Auth / PostgREST / Storage / Realtime
 │   ├─ checkAuth → profiles.role/preferences → role routing
 │   ├─ initAppPage → page-specific buyer/broker handlers
 │   ├─ listings / media / inquiries / custom filters / messages / reports
 │   ├─ notifications / status history
 │   └─ ajaxLoadPage → fetch HTML → syncHead / executeScripts → initAppPage
 ├─ inline page modules ─ lib/supabase.js ─ Supabase tables
 └─ demo-data.js → sample card utility (apparent usage unclear)

Vite → HTML multi-entry build + Tailwind plugin + dev rewrites
Vercel → static files + signup/shared-filter rewrites
```

`auth.js` and `lib/supabase.js` are the most central shared dependencies. Admin/Employee/profile/map/shared-filter also have independent inline DB access, so changing a shared helper does not necessarily update all page behavior. The app repeats auth and CRUD patterns across these contexts.

# 16. Environment Variables

- `VITE_SUPABASE_URL` — Supabase project endpoint; used in `lib/supabase.js`; required for configured database/auth. The checked-in `.env` has a value, omitted here.
- `VITE_SUPABASE_ANON_KEY` — public/anon Supabase client key; used in `lib/supabase.js`; required. It is a browser-exposed public key by design; security depends on RLS/policies, not secrecy.
- `setup.html` also embeds its own Supabase URL/key literal rather than using the shared env-based client. Values intentionally omitted. This is duplicated configuration and can drift from `.env`.
- No other `import.meta.env` variables were found in application source. Vercel environment configuration and Supabase secrets are not visible in this repo.

# 17. Known Technical Debt

- Very large `auth.js` combines many unrelated features and global functions. This increases regression risk and makes lifecycle ordering hard to reason about.
- Important logic is duplicated between `auth.js` and inline Admin/Employee/profile/map/login scripts; role checks and data operations therefore have multiple implementations.
- A custom HTML-fetching router coexists with native links, history changes, inline scripts and direct event listeners.
- Data access is distributed among shared and page-inline code, with no local API/service boundary.
- Both `.env`-based and hard-coded Supabase client configuration exist (`setup.html`).
- UI state is spread across localStorage, globals, Supabase session, remote preferences and current DOM. Profile/saved data can have cache/remote divergence.
- Hard-coded sample cards/content coexist with live Supabase reads. `demo-data.js` looks likely stale or vestigial: it defines one sample and skips its own seeding on pages that import it, but runtime usage is not proven.
- Two role-panel implementations repeat stats/moderation/report patterns.
- Root README is only a short welcome line; there is no useful local setup or architecture documentation at baseline.

# 18. Potential Risks

- Frontend role checks and hiding routes cannot secure database rows. Without RLS inspection, cross-user access risks are UNKNOWN; confirm the live policies before relying on UI gates.
- Browser code uses an anon key, which is expected for Supabase, but overly broad policies would expose data. `setup.html` also places a client key literal in source.
- `profiles.password` exists in the supplied column list although the observed auth flow uses Supabase Auth; whether any password is stored there is UNKNOWN. Storing credentials in this table would be a serious concern; inspect actual data/policies before concluding it happens.
- User data and IDs in localStorage are editable by the browser user; do not treat them as trusted authorization.
- Listing/media replacement may delete then reinsert related rows; without transaction/cascade details, partial updates or orphaned storage files are possible.
- User-generated listing/profile/report content is rendered dynamically in many places. Some code escapes HTML (`escHtml`), but coverage is not proven everywhere; review individual sinks before changes.
- Direct external geocoding/tile/image/font requests disclose routine request metadata to those providers and depend on their availability.
- Custom SPA script re-execution and page initialization can lead to duplicate listeners or stale globals if lifecycle assumptions break.

# 19. Unclear / Needs Verification

- Supabase Auth settings, Postgres RLS policies, Storage bucket policies, deployed schema constraints/indexes/triggers and Edge Function source are not in the repository.
- The supplied schema is column metadata only; `reports` was referenced in code but absent from the supplied dump.
- No source-only proof of production hosting configuration, deployed environment variable names/values, or which pages are publicly exposed.
- Email confirmation, password reset, account deletion semantics, and Auth-to-profile triggers are not established.
- Runtime status of `demo-data.js` fallback paths, `sell.html` form submission, referral click accounting and `listing_referrals` is unclear.
- `setup.html` should be considered a bootstrap utility; whether it is still used, protected, or deployed is UNKNOWN.
- Dead-code classification: no page/function is labeled definitely unused from static appearance alone. `scripts/generate-estatepro-vs-99acres-ppt.js` is outside app runtime; `open-design/` has no imports and is excluded from deploy (probably non-runtime assets). Individual global helpers in `auth.js` and the screen images may be legacy/unused but require runtime/build confirmation.
- Project README does not specify exact operating commands/config setup; package scripts show `npm run dev`, `npm run build`, and `npm run preview`, but app behavior with missing credentials is not validated here.

# 20. Final Mental Model

Think of ProjectX as a set of HTML screens sharing a large browser-side coordinator (`auth.js`). The browser authenticates with Supabase, reads the user role, chooses a page, then performs most business operations directly against Supabase tables and buckets. Buyer, broker, employee, and admin workflows are UI variants over the same tables, with some logic centralized and some repeated inline. `lib/supabase.js` is the only common database-client factory; there is no local backend layer. The most important safety boundary is therefore the external Supabase policy configuration, which this source snapshot does not reveal.