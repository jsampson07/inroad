# Architecture Reference

> For external readers: this is a living decision log of architectural and implementation choices from active development — organized by topic with alternatives considered, not a finished system design doc.

*Companion to `product_discovery_summary.md`, which remains the source of truth for product scope, MVP feature set, tech stack, and the eval rubric. This document covers the architectural and implementation decisions made when translating that scope into a concrete backend design. Organized by topic, not by when each decision was made.*

---

## 1. Repository Structure

**Decision:** Single monorepo with `backend/` and `frontend/` as top-level siblings, rather than two separate repos.

**Reasoning:** For a solo developer building a full-stack resume project, one clone and one README beats context-switching between repos. Nothing is deployed independently or owned by a separate team, so the usual reason to split (independent CI/CD, separate ownership) doesn't apply.

**Alternative considered:** Separate frontend/backend repos — the more common pattern in real organizations with independent deploy pipelines and team ownership. Rejected as pure overhead at this scale, but worth knowing as the "why" if asked in an interview.

---

## 2. Backend Folder Structure

**Decision:** Layer-based structure under `backend/app/`: `core/`, `db/`, `models/`, `schemas/`, `routers/`, `services/`, `providers/`, `llm/`, with `alembic/` and `tests/` as siblings of `app/`.

```
backend/
├── alembic/
│   ├── versions/
│   └── env.py
├── alembic.ini
├── app/
│   ├── main.py
│   ├── core/          # config.py, security.py, deps.py
│   ├── db/             # base.py, session.py
│   ├── models/         # SQLAlchemy ORM, one file per entity
│   ├── schemas/         # Pydantic — API I/O and LLM structured-output schemas
│   ├── routers/         # thin — parse request, call a service, return response
│   ├── services/        # business logic
│   ├── providers/       # ContactProvider interface + implementations
│   └── llm/             # client.py, prompts.py
└── tests/
```

**Reasoning:** Standard, immediately legible FastAPI convention — important for an interviewer opening the repo cold. At 7 entities and one developer, the structure needs to be easy to navigate, not optimized for large-team change isolation.

**Alternative considered:** Feature/domain-based structure (`features/contacts/{router,service,model,schema}.py`, one folder per domain). This earns its keep in larger or multi-team codebases where localizing change to one feature matters. Rejected here because several services (e.g. `contact_discovery.py`) span multiple entities (`Company`, `Contact`, `RawProviderResult`) and don't map cleanly onto a single feature folder, and because layer-based is more legible at this scale.

### Sub-decisions within the folder structure

- **`models/` and `schemas/` are separate packages.** SQLAlchemy models describe what's persisted in Postgres; Pydantic schemas describe what's allowed to cross a boundary (API request/response, or LLM structured output). Collapsing them risks leaking DB-only columns (e.g. a password hash) straight into API responses, since FastAPI will serialize whatever attributes it can reach on an object with no explicit `response_model` allowlist. It also breaks down for schemas with no backing table at all (`ResumeExtraction`, `EvalResult`, `MatchData`) — this isn't a gap, it's evidence those schemas are doing validation/boundary work rather than storage work. This is a correctness-adjacent convention, not pure style.
- **`providers/` is its own top-level package**, not nested inside `services/`. The multi-provider abstraction is the product's "hero problem," so giving it a dedicated package makes the interface/implementation seam visible in the repo layout itself.
- **Routers are thin, services are thick.** Routers parse the request, call a service function, and return the result — no business logic. This means services (e.g. `contact_discovery.py`, `generated_emails.py`) can be unit-tested directly, with no HTTP layer or test client involved, which matters given how much debugging is expected to happen in the discovery/reconciliation logic (per the roadmap's Phase 2 note) and in the generate→evaluate→persist orchestration.
- **`alembic/` sits next to `app/`, not inside it.** Migrations are infrastructure, not application code; `env.py` imports `app.db.base` to find model metadata, but the directory itself stays a sibling. This one is closer to pure convention — nothing breaks if nested differently, as long as `env.py`'s import path is correct.

---

## 3. LLM Client: Shared Thin Wrapper

**Decision:** A single `app/llm/client.py` wrapper (`LLMClient.complete(...)`) is called by all LLM-touching services rather than each service making its own direct call to the Anthropic API. There will eventually be **four** such services:

| Service | Role |
|---|---|
| `extraction.py` | Single-document structured extraction (resume → `ResumeExtraction`, JD → `JDExtraction`) |
| `matching.py` | Match/gap analysis comparing a `ResumeExtraction` to a `JDExtraction` → `MatchData` |
| `email_generation.py` | Grounded outreach draft from contact context + `MatchData` → `EmailDraft` |
| `eval.py` | Rubric-based judging of a generated email (`evaluate_email` / `refine` / `evaluate_with_retry`) |

`matching.py` is its own file because match/gap analysis is a **comparison between two already-extracted documents**, not a single-document extraction (so it does not belong in `extraction.py`) and not something `eval.py` should be responsible for producing (`eval.py` *consumes* `MatchData` as a verification reference — see `DATA_MODEL.md` §2.7).

`eval.py`'s `evaluate_with_retry` owns the silent single-retry hard-gate orchestration from `product_discovery_summary.md` (evaluate → on gate failure, `refine` once with `violation_detail` → evaluate again → return the second pass either way). `gate_passed` / the retry trigger is the AND of **three** Tier 1 booleans (`no_unsupported_claims`, `correct_contact_name_used`, `no_unprompted_gap_admission`) — the third was added after dogfooding; `eval_prompt` instructs the judge to treat gap-admission as a tone/strategy failure distinct from factual unsupported claims. `refine(email, feedback) -> EmailDraft` remains the standalone reusable primitive so the deferred v1.1+ interactive multi-turn refinement path is more calls / more triggers / a UI, not a rebuild.

**Decision (signature append):** After `evaluate_with_retry` returns the final `(email, eval_result)`, `generated_emails.py` deterministically appends a closing to `email.body` before persist: `"\n\nBest regards,\n{candidate_name}"` when `ResumeExtraction.candidate_name` is present, otherwise `"\n\nBest regards,"` with no fabricated name. This runs **after** evaluation so the judge never sees or grades the signature. Both `email_generation_prompt` and `refine_prompt` explicitly forbid model-authored sign-offs/closings/names — without that, a model-written closing would stack with the programmatic one (refine can also invent a closing while "completing" a revision even when the original draft had none).

**Decision (strip model-authored closing before signature append):** Immediately after `evaluate_with_retry` returns and **before** the programmatic signature append, `generated_emails.py` runs `_strip_trailing_closing(body, candidate_name)` — a deterministic, conservative strip of any model-authored trailing closing block. `evaluate_with_retry` continues to see the model's raw, unmodified output; the strip only touches the final draft that is about to be signed and persisted. Algorithm is **anchor-then-sweep**: (1) take the last ≤3 non-blank line indices as a bounded window; (2) search the *entire* window for exact standalone valediction matches via `_is_closing_line` and select the match with the **smallest physical line index** (earliest / furthest-back); (3) strip every line from that anchor through the end of the body — no per-line re-check of swept content; (4) if no phrase anchor exists but the single last non-blank line equals `candidate_name`, treat that name line as the anchor instead; (5) otherwise leave the body unchanged; (6) trim trailing blanks after the cut. Root cause (dogfooding, round 1): the generation/refine negative instruction ("do not include a sign-off") is not reliably followed by `claude-haiku-4-5`, so a model-written `"Best,"` stacked with the programmatic `"Best regards,\n{name}"`. Round 2 (continued dogfooding): a body ending `"Thanks,\nLooking forward to hearing from you."` — the earlier consecutive-bottom-up walk stopped at the first non-matching bottom line and never inspected `"Thanks,"` above it. Sweeping from the earliest confirmed valediction anchor removes the whole trailing block (prose after a sign-off word, stacked closings, optional name) without expanding the closing-phrase list — expanding that list would be whack-a-mole against unbounded model phrasing, the same reasoning that rejected a fixed enum for `EvalGates.violation_detail` in `DATA_MODEL.md` §2.7. A fourth eval hard gate for "no model-authored closing" was considered and **explicitly rejected**: a gate only detects/retries probabilistically via the same model that already ignored the instruction once, and does not guarantee the artifact the user copy-pastes is clean. The code-level strip is a guarantee, not a retry. Detection remains intentionally narrow (last 1–3 non-blank lines; exact standalone phrase match after trimming a single trailing comma/period; no mid-sentence substring matches) because a false positive that deletes real CTA content is worse than a rare false negative.

**Reasoning:** All four call sites share the same underlying shape: prompt in, Pydantic-validated JSON out. This shared shape is already known from the product doc (structured extraction, match analysis, grounded generation, rubric-based judging all follow the same pattern) — it isn't a guess about future needs, which is what would normally argue for waiting. A shared wrapper gives one place to swap models, add retry/timeout/backoff logic, and log token usage/cost across all call sites, and lets tests substitute a fake client (mirroring the `mock.py` provider pattern) instead of monkeypatching HTTP calls in multiple files.

**Alternatives considered:**
- *Each service hits the Anthropic API directly.* Simpler per-file, but duplicates request-building and response-parsing logic, and any fix (timeout, retry, logging) has to be applied in multiple places — a real risk of silent drift, not just a style cost.
- *Skip the wrapper for now, write direct calls, refactor once patterns are clear.* Reasonable when the shared shape is genuinely uncertain. Rejected here specifically because the shape is *already* certain (all call sites specified in the product doc as the same prompt-in/validated-JSON-out pattern), so deferring would mean paying refactor cost later for zero information gained in the meantime — and that refactor would land during Phase 3, the highest-iteration-pressure phase per the roadmap.

**Cost accepted:** An extra layer of indirection. If one call site later needs a meaningfully different call shape (e.g. multi-turn), the wrapper either grows conditional params or gets bypassed for that one case — worth watching for, but not a blocker today.

---

## 4. `ContactProvider` Interface

**Decision:** An abstract base class (`ABC` + `@abstractmethod`) in `app/providers/base.py`, implemented identically by `HunterProvider`, `ApolloProvider`, `AnymailProvider`, and `MockProvider`.

```python
class ContactProvider(ABC):
    name: str

    @abstractmethod
    async def search(
        self, company_domain: str, role_titles: list[str]
    ) -> ProviderSearchResult:
        ...
```

**Reasoning (ABC over Protocol):** All four implementations are owned in-repo (not third-party objects being typed structurally), Python should error at class-definition time if a subclass forgets to implement `search()`, and shared helper methods (e.g. retry timing) can live on the base class. Protocol (structural typing) is the right tool when typing objects you don't own; ABC is the right tool when you own every implementation and want enforced inheritance.

### 4.1 Expected failures use a status-result object, not exceptions

**Decision:** `ContactProvider.search()` never raises for rate limits, auth/network failures, or zero matches. It always returns a `ProviderSearchResult` with a `status` field (`SUCCESS`, `RATE_LIMITED`, `ERROR`). A successful call that finds zero candidates is still `SUCCESS` — there's no separate `NO_RESULTS` status, since an empty-but-successful call is meaningfully different from a call whose outcome is unknown (`RATE_LIMITED`/`ERROR`), and `len(candidates) == 0` already distinguishes it cheaply.

**Reasoning:** These failure modes are expected and frequent (especially on free-tier rate limits), not exceptional. Using exceptions as the primary branching mechanism for something that happens on a large fraction of calls would mean a different try/except around every provider call in the orchestrator. A status field turns "handle every provider's failure modes" into one small, reusable, testable branch shared by all four providers, and it preserves context (which tier, what the other providers said) that gets lost if an exception propagates up from deep in a call stack. Each provider implementation is responsible for catching its own HTTP/network exceptions internally and translating them into a status — exceptions are still reserved for genuinely unexpected failures (e.g. malformed data the provider library itself can't parse).

**UX implication:** `ProviderSearchResult.error_message` is internal/debug-only and is never serialized to the frontend. The orchestrator translates provider statuses into a separate, user-facing schema (e.g. `ContactDiscoveryResponse.fallback_reason`) with hand-written, plain-language copy — this is what implements the product doc's "transparent, plain-language reason shown whenever it has to fall back" requirement.

### 4.2 Tiering logic lives in the orchestrator, not the provider

**Decision:** The recruiter → generalist TA → hiring manager → founder/CEO fallback sequence is owned entirely by `contact_discovery.py`. Each call to `provider.search()` represents one tier's attempt, taking that tier's acceptable titles as input; the provider has no awareness that other tiers exist.

**Reasoning:** Tiering is a business strategy independent of which provider is being called. Baking it into each provider would triplicate the sequencing logic and couple it to provider-specific quirks.

### 4.3 Caching logic lives in the orchestrator, not the provider

**Decision:** No `ContactProvider` implementation has a database handle or any awareness that a cache exists. `contact_discovery.py` is the only module that reads or writes `COMPANIES`/`CONTACTS`.

**Reasoning:** Same responsibility-boundary logic as tiering — see Section 5 for the full caching design. Stated explicitly here so it doesn't creep back into a provider implementation later: a cache check inside e.g. `HunterProvider.search()` would be a sign the boundary slipped.

### 4.4 Supporting schemas

```python
class VerificationTier(str, Enum):
    VERIFIED = "verified"
    PATTERN_GUESSED = "pattern_guessed"
    CATCH_ALL = "catch_all"
    UNKNOWN = "unknown"

class ProviderStatus(str, Enum):
    SUCCESS = "success"
    RATE_LIMITED = "rate_limited"
    ERROR = "error"

class ProviderCandidate(BaseModel):
    name: str | None
    title: str | None
    email: str | None
    verification_tier: VerificationTier
    raw_response: dict

class ProviderSearchResult(BaseModel):
    provider_name: str
    status: ProviderStatus
    candidates: list[ProviderCandidate] = []
    error_message: str | None = None
```

`ProviderCandidate` deliberately mirrors the `RAW_PROVIDER_RESULTS` table's columns almost 1:1 (see `DATA_MODEL.md`) — it *is* what becomes a row in that table, one row per candidate. `VerificationTier` lives in a neutral shared location rather than being defined separately in `models/` and `schemas/`, since both the SQLAlchemy column and the Pydantic schema need to reference the same enum without risk of drift.

**Assumption (not fully re-confirmed — see uncertainties):** `search()` takes `company_domain: str` rather than a richer object (name + domain + LinkedIn URL). Domain was chosen because all three real providers key off it reliably, whereas name-based search is more collision-prone.

**This design is what makes mock-first development real, not a workaround.** Because `MockProvider` implements the exact same ABC and returns the exact same `ProviderSearchResult` shape as the real providers, `contact_discovery.py` genuinely cannot tell mock from real — it's a full peer implementation, not a stub with a different shape to swap out later.

### 4.5 Dev fixtures for live mock mode

**Decision:** When `CONTACT_PROVIDER=mock`, the discovery router factory (`_build_providers` in `app/routers/contact_discovery.py`) constructs `MockProvider(scripted=DEV_SCRIPTED_RESULTS)`, not a bare `MockProvider()`. The scripted map lives in `app/providers/mock_fixtures.py`. Bare `MockProvider()` (empty default for unscripted domains) remains correct for unit tests that inject their own scripts.

**Why a separate fixtures module:** Service-level tests already pass per-test `scripted=` maps and never exercise the router factory. Without wiring fixtures at the factory, every manual/live discovery call under mock mode returned zero candidates for every domain — contradicting Phase 0's locked "mock/fixture provider simulating realistic scenarios" strategy.

**Manual testing domains** (fictional; Clearbit often won't suggest them — use FRAME 1's manual name+domain fallback):

| Domain | Scenario |
|---|---|
| `acme.com` | Tier-1 verified recruiter hit. `tier_used=recruiter`, no `fallback_reason`, high confidence. |
| `globex.com` | Empty recruiter + talent-acquisition tiers, then a pattern-guessed hiring-manager hit. Exercises `fallback_reason` + lower `best_verification_tier`. |
| `empty.co` | All four tiers empty on purpose. `contact=null` with the exhausted-tiers `fallback_reason` (not-found path). |

Any other domain still gets the bare default (successful empty candidates) unless added to `DEV_SCRIPTED_RESULTS`. After a successful find, Postgres cache (§5) may short-circuit a re-search for that domain until the contact row is cleared.

---

## 5. Caching Strategy

**Decision:** The "cache" is not a separate technology — it is the `COMPANIES` and `CONTACTS` Postgres tables, queried in a particular order: check for an existing usable contact before calling any provider; write results back after providers respond and reconciliation runs.

```python
# read (cache check) — inside contact_discovery.py only
existing = db.query(Contact).join(Company).filter(
    Company.domain == company_domain
).first()
if existing and existing.best_verification_tier != VerificationTier.UNKNOWN:
    return existing  # cache hit, zero provider credits spent

# write (after providers respond + reconciliation)
db.add(new_contact)
db.commit()
```

**Reasoning:** "Cache" describes a pattern of use (check somewhere cheap before doing something expensive), not a required data structure. Postgres already gives you persistence across restarts, safety across multiple worker processes, and — critically, per the product doc's explicit design goal — true cross-user sharing (`COMPANIES`/`CONTACTS` are deliberately not user-scoped, "to enable cross-user credit savings"). An in-memory structure (e.g. a module-level dict) would fail on all three counts: it resets on every restart, isn't shared across worker processes, and is *more* isolated than user-scoped data, not less — the opposite of the stated goal.

**What makes the lookup actually fast:** `Company.domain` must carry a unique index. Without it, the "cache" still functions but stops paying off as the table grows, since Postgres would have to scan every row to find a match.

### 5.1 Redis: not adopted

**Decision:** No Redis or other dedicated cache technology is introduced. Postgres with an indexed lookup is the caching layer, including under a "design for other users" framing.

**Reasoning:**
- The product's multi-user design is already handled by the shared (non-user-scoped) `COMPANIES`/`CONTACTS` tables — that mechanism works identically whether there are 2 users or 200,000, because it was designed around shared *data*, not around request volume.
- Redis earns its place when the data store itself is a measured bottleneck under real request *volume* — a function of requests/sec, not total user count. Nothing about this product's usage pattern (deliberate, low-frequency outreach searches, not a high-throughput consumer app) suggests that threshold is close, and no load testing has shown otherwise.
- Redis adds a second stateful system with its own failure modes and a real cache-invalidation problem (a `CONTACTS` write with no matching Redis invalidation silently produces stale reads) — trading a single source of truth for a new class of consistency bug, in exchange for solving a problem that hasn't been observed.
- If the pipeline does have a real bottleneck, it's far more likely to be third-party provider rate limits (Hunter's 50 credits/month, etc.) or LLM latency — not an indexed point-lookup on `Company.domain`. Redis wouldn't address the actual scarce resource.
- Demonstrating the judgment to *not* add infrastructure ahead of evidence is itself part of the product doc's stated differentiator (reasoned "why I didn't build X" decisions) — this mirrors the Gmail OAuth and `SEARCHES` table deferrals already locked in the product doc.

**Trigger condition for revisiting:** A measured (not hypothetical) load test showing Postgres query latency on the cache lookup becoming a real bottleneck. Because caching logic is fully isolated to `contact_discovery.py` (per Section 4.3), introducing Redis later would be a localized change to one module, not a rewrite — deferring costs effectively nothing.

**Alternative considered and rejected:** Adding Redis preemptively "because it's proven and fast" or because a hypothetical future user count might need it. Rejected as optimizing for an unmeasured bottleneck, at real ongoing cost (a new service to run, monitor, and keep consistent).

---

## 6. Error Translation Pattern (general, beyond `ContactProvider`)

**Decision:** Internal status/error detail (provider statuses, raw exception messages) and user-facing explanation are always distinct objects. The orchestrator layer is responsible for translating the former into hand-written, plain-language copy in the latter — never passing an internal error string through to the API response directly.

**Reasoning:** Keeps debugging information (logs, `error_message` fields) separate from product-quality copy the user actually sees, and is what allows the discovery-fallback UX ("no dedicated recruiter found, showing the hiring manager instead") to read as a designed product feature rather than an exposed internal state.

---

## 7. Company Name Resolution

**Decision:** A separate, thin service — e.g. `app/services/company_resolution.py` — resolves a user-typed company *name* into a domain, ahead of `contact_discovery.py`. It is deliberately **not** a `ContactProvider` implementation.

**Reasoning:** This service resolves company identity, not person/contact data — a different problem than anything §4 was designed around. It has no tiering (§4.2), no shared credit budget with Hunter/Apollo/Anymail, and fires once per submitted search rather than once per discovery-pipeline tier. Forcing it into the `ContactProvider` ABC would blur a boundary that's currently clean: `ContactProvider` implementations all answer "who is the contact at this known company," while this service answers a prior question, "which company is this, exactly." Its output (a resolved `company_domain`) feeds into the existing pipeline completely unchanged — `ContactDiscoveryRequest` and everything downstream of it are untouched by this addition.

**Mechanism:** Wraps a single call to Clearbit's Autocomplete API (`https://autocomplete.clearbit.com/v1/companies/suggest`), a free, keyless endpoint that returns candidate `{name, domain}` pairs (its `logo` field was deprecated to `null` in September 2025 and isn't used here). The service follows the same status-result pattern as §4.1 — it does not raise for zero matches or provider failure, and returns a result object the frontend can render directly:

```python
class CompanySearchRequest(BaseModel):
    query: str  # raw user-typed company name

class CompanySearchCandidate(BaseModel):
    name: str
    domain: str

class CompanySearchResponse(BaseModel):
    candidates: list[CompanySearchCandidate]
```

**UX contract:**
- The user always explicitly selects a candidate — resolution is never automatic, even when exactly one candidate is returned. This closes off a wrong-but-plausible top hit silently flowing into the (comparatively expensive) discovery pipeline.
- Both "zero candidates returned" and "the Clearbit call itself failed" (timeout, rate-limited, network error) route to the same user-facing fallback: a "Haven't found what you're looking for?" affordance that lets the user type the domain in directly. Per the §6 error-translation pattern, the two cases can carry different internal log detail even though the user-facing action is identical.
- v1 fires this call once per submitted search (on-submit), not on every keystroke. Live, debounced typeahead is a deferred, frontend-only enhancement — see `product_discovery_summary.md`'s Deferred Features table — since it adds request-race handling (a stale in-flight response for an earlier keystroke arriving after a newer one) that on-submit avoids entirely, and Clearbit's real rate limits haven't been load-tested yet.

**Known limitation, accepted for v1:** Clearbit's Autocomplete dataset has a real coverage gap for very recently founded/launched companies (empirically confirmed — a company that publicly launched roughly seven weeks prior to testing did not resolve). This is expected to be rare for this product's actual usage pattern (most applicants target established companies with an existing job posting and careers page), and it's exactly what the manual-domain fallback exists to catch. Not treated as a blocker; worth revisiting only if real usage shows this gap hit often in practice.

**Alternative considered:** Checking whether Apollo (already a paid, budgeted provider for the core pipeline) exposes its own organization-search-by-name endpoint, avoiding a fourth external dependency entirely. Not ruled out — genuinely unverified against Apollo's actual API surface — just not pursued yet in favor of shipping with Clearbit first.

---

## 8. Frontend Architecture

**Decision:** Vite + React + TypeScript SPA under `frontend/`, with React Router for navigation, TanStack Query at the root for server-state, a thin shared `fetch` wrapper (`src/lib/apiClient.ts`) for HTTP, and React Context (`AuthContext`) for auth session state — not Redux/Zustand at this scale.

### 8.1 Routing

**Decision:** `react-router-dom` (`BrowserRouter`) with public `/login` `/signup` routes and a `ProtectedRoute` wrapper that redirects to `/login` when `!isAuthenticated`. Protected product routes: `/` (discovery/generate flow as accumulating frames on one page), `/history` (past emails + outcomes — see §8.6), and `/analytics` (reply-rate summary — see §10). Flow steps on `/` remain component state, **not** one route per frame.

**Reasoning:** At this scale there is no serious alternative worth debating — React Router is the default for React SPAs, and the protected-route pattern matches the JWT-gated backend without inventing a custom gate. Flow steps (search → role title → discovery → resume → JD → generate email) are component state on `/`, not URL segments: deep-linking mid-flow is not a v1 need, and keeping one route for that linear demo flow avoids inventing a multi-step URL scheme. `/history` and `/analytics` are separate routes because they are distinct browse/measure surfaces, not steps in that linear flow.

### 8.2 Server state: TanStack Query

**Decision:** Wrap the app in `QueryClientProvider` from `@tanstack/react-query` at the root (`main.tsx`). Feature-screen calls that are user-triggered side effects use `useMutation`; auth login/signup stay on Context + imperative `apiClient` calls (form submit, token side effects) rather than being forced through Query.

**Reasoning:** Manual `useEffect` + `useState` per API call duplicates loading/error/retry handling across every data-fetching component — a real maintenance cost once company resolution, discovery, uploads, and email generation all hit the network, not just a style preference. The root provider was installed in the auth-foundation slice so feature screens opt into `useQuery`/`useMutation` without a second wiring pass.

**Alternative considered:** Skip TanStack Query until the first feature screen needs caching. Rejected because the root provider is cheap and the duplicated-boilerplate cost shows up immediately across multiple API-calling screens.

### 8.2.1 `useMutation` for company search, contact discovery, document extract, email generation, and Mark as Sent

**Decision:** `POST /companies/search`, `POST /contacts/discover`, resume upload+extract, JD create+extract, `POST /generated-emails`, and FRAME 6's `POST /outcomes` (Mark as Sent) are wired with TanStack Query `useMutation`, **not** `useQuery`.

**Reasoning:** These are side-effecting, user-triggered actions (submit a search; spend discovery credits; spend LLM extract/generate credits; append an outcome event), not cacheable/refetchable reads. `useQuery` would imply background refetch, stale-while-revalidate, and remount-triggered re-execution — wrong for a Clearbit lookup that should fire once per submit, and actively harmful for discovery/extract/generate, which spend real, rationed credits. Mutation semantics (explicit `mutate`, no automatic refetch) match the product contract.

### 8.2.2 Discovery-flow sessionStorage persistence

**Decision:** Persist home-page flow state in `sessionStorage` under a single namespaced key `discoveryFlow`, storing one JSON object `{ company, discoveryResult, resume, jobDescription, generatedEmail, sentOutcomeLogged }`. Do **not** use `localStorage` for this payload. Do **not** persist the raw company-search candidate list. Document, email, and sent-outcome fields were added to this same key (not a sibling) so "Start new search" and rehydration stay one clear/one read — see §8.2.3–§8.2.4.

**What is persisted:**
- On successful company lock-in (candidate click or manual domain entry): `{ company: { name, domain }, discoveryResult: null, resume: null, jobDescription: null, generatedEmail: null, sentOutcomeLogged: false }` — written immediately, before `role_title` is entered, so a refresh during the role-title frame rehydrates there rather than back to company search.
- On discovery mutation completion (contact found **or** `contact: null` — both are valid completed outcomes): the full `ContactDiscoveryResponse` is written under the same object; document/email fields are cleared (new discovery starts a new pipeline).
- On successful resume/JD extract: the post-extract `ResumeOut` / `JobDescriptionOut` objects are written under `resume` / `jobDescription` (see §8.2.3).
- On successful email generation: the full `GeneratedEmailOut` is written under `generatedEmail` (see §8.2.4); `sentOutcomeLogged` resets to `false`.
- On successful Mark as Sent (`POST /outcomes` with `event_type: "sent"`): `sentOutcomeLogged` is set to `true` for the current `generatedEmail` (see §8.2.4). Cleared whenever `generatedEmail` is cleared or replaced.

**What is not persisted:** The candidate list from `POST /companies/search`. That call is free (keyless Clearbit) and idempotent; re-running it after a refresh is fine and cheaper than storing ephemeral suggestion UI.

**Why sessionStorage over localStorage:** A discovered contact's name/email is third-party PII, not just the user's own data. `sessionStorage` clears on tab close (bounded exposure); `localStorage` would leave it sitting indefinitely. This is a deliberate choice, not a default.

**Why discovery persistence is a cost/correctness concern:** `POST /contacts/discover` spends real, rationed provider credits. If a refresh silently re-triggered discovery, credits would burn on an accidental reload. Rehydrating the result frame from storage (no re-fetch) prevents that. On mount, the home page reads `discoveryFlow` once via a lazy `useState` initializer and lands directly on the correct frame — no flash of the company-search frame. "Start new search" clears both component state and the `sessionStorage` key.

**Why `sentOutcomeLogged` lives on the same object (not a sibling key):** Same one-clear/one-read reasoning as resume/JD/`generatedEmail` (§8.2.3–§8.2.4). The flag is meaningful only relative to the current `generatedEmail`; putting it on a separate key would invite drift on "Start new search" and on writers that clear/replace the email. It is a frontend UX guard against accidental duplicate Mark as Sent clicks after refresh — not a source of truth about server state (no `GET /outcomes` re-check).

### 8.2.3 Resume + JD upload/extract frames (FRAME 4–5)

**Decision:** After contact discovery (FRAME 3), the same `/` page continues with resume upload+extract, then JD paste+extract, then generate-email (FRAME 6 — see §8.2.4). No new routes.

**Frame order (locked):** FRAME 1 company search → FRAME 2 role title → FRAME 3 discovery result → FRAME 4 resume → FRAME 5 JD → FRAME 6 generate email. Resume stays before JD: resume creation does not need `company_id`, and JD creation does. Ordering JD first would not make `company_id` available any earlier — see below.

**Backend contracts verified against routers/services (not docs alone):**
- **Resume create:** `POST /resumes` is **multipart** with form field `file` (PDF/DOCX). Server parses via pypdf/python-docx into `raw_text`, then persists. Not a JSON `ResumeCreate{raw_text}` body — that Pydantic model is an internal post-parse shape only.
- **Resume extract:** `POST /resumes/{resume_id}/extract` → `ResumeOut` (overwrites `extracted_data`).
- **JD create:** `POST /job-descriptions` JSON `{ raw_text, company_id, role_title }` → `JobDescriptionOut`.
- **JD extract:** `POST /job-descriptions/{jd_id}/extract` → `JobDescriptionOut`.
- **JD read:** `GET /job-descriptions/{jd_id}` → `JobDescriptionOut` (ownership-filtered; available for refetch-by-id).
- **Resume upload validation (server):** only `.pdf`/`.docx`; 2MB cap (`user_message`: `"File too large"`); min 50 chars extracted text after parse (scanned-image style message). Frontend mirrors extension + 2MB checks client-side; the 50-char rule remains server-only (depends on parse).

**`company_id` source:** Frame 1's locked company is `{ name, domain }` only — no id. Discovery's `get_or_create_company` creates/finds the row server-side, but `ContactDiscoveryResponse` only exposes `company_id` on a found `contact`. The JD step therefore uses `discoveryResult.contact.company_id`. When `contact` is null, FRAME 3 does not offer Continue (cannot create a JD frontend-only without a backend change to return `company_id` on empty discovery).

**`useResumeForGeneration` isolation boundary:** How a `resume_id` is obtained for generation is isolated in `hooks/useResumeForGeneration.ts`. Current internals are Option 2 — fresh multipart upload + extract every search (`useMutation`, create then extract). Callers consume `resume` / `resumeId` / `obtainFromUpload`. A future saved-resume picker (Option 3) should swap this hook's internals only — see `OPEN_QUESTIONS.md`.

**Resume step (FRAME 4):** Displays full `ResumeExtraction` including `candidate_name` and `projects` (not only skills/experience/education). Surfacing `candidate_name` is a correctness concern: it feeds the programmatic email signature, so a mis-extraction is visible before copy-paste.

**JD step:** paste `raw_text` + `role_title` (collected on FRAME 5, not reused from the discovery role-title field), `company_id` from the contact; `useMutation` for create+extract. Displays `JDExtraction` (`required_skills`, `responsibilities`, `seniority_level`).

**sessionStorage extension:** Added `resume` and `jobDescription` fields on the existing `discoveryFlow` object (not a sibling key). Same third-party-PII / paid-action reasoning as discovery: extract endpoints spend LLM credits; refresh must rehydrate the confirmation UI without re-calling `/extract`. Full post-extract Out objects are stored (mirrors storing full `ContactDiscoveryResponse`). `GET /job-descriptions/{id}` remains available if a later slice prefers id-only storage + refetch. FRAME 6 extends the same key with `generatedEmail` — see §8.2.4.

### 8.2.4 Generate-email frame (FRAME 6)

**Decision:** After FRAME 5's JD `extracted_data` is non-null (and the user continues), the same `/` page shows FRAME 6 — an explicit **Generate Email** button wired with `useMutation` (not auto-fired on frame entry). Contact existence is already guaranteed by this point: JD creation required a non-null contact's `company_id`. No new routes. No `mailto:` / send affordance — copy-paste only.

**Trigger condition:** FRAME 5 confirmation after successful JD extract (`extracted_data != null`), then an explicit continue into FRAME 6. Generation itself is a second explicit click — same credit-conscious pattern as discovery/extract.

**Backend contract verified against `backend/app/routers/generated_emails.py` + `backend/app/schemas/generated_email.py` (not docs alone):**
- **Path/method:** `POST /generated-emails` (router prefix `/generated-emails` + `POST ""`).
- **Request (`GenerateEmailRequest`):** `{ contact_id, resume_id, job_description_id }` — `contact_id` from Frame 3 discovery result, `resume_id` from `useResumeForGeneration` (public interface unchanged), `job_description_id` from Frame 5 `JobDescriptionOut.id`.
- **Response (`GeneratedEmailOut`):** `id`, `contact_id`, `resume_id`, `job_description_id`, `subject`, `body`, `eval_score`, `eval_breakdown` (`EvalBreakdownOut`), `match_data` (`MatchData`), **top-level** `gate_passed`, `created_at`.
- **`eval_breakdown.gates`:** `EvalGatesOut` — `no_unsupported_claims` + `correct_contact_name_used` + `no_unprompted_gap_admission` only. `violation_detail` is stripped at the API boundary on this Out shape (POST and GET-by-id); the client must not fabricate or infer it.
- **`match_data` fields:** `skill_matches`, `experience_alignment`, `unmatched_jd_requirements`, `notable_resume_strengths`, `overall_match_summary` — matches `MatchData` in `DATA_MODEL.md` §2.7.
- **Company/contact mismatch (422):** `ValidationError` → `{ user_message, error_code }`. Live `user_message`: `"Contact and job description must belong to the same company. Contact is tied to company_id=…; job description is tied to company_id=…."` Frontend surfaces `ApiError.user_message` (and offers Retry on failure before any success).

**Result display:**
- Primary content: `subject` + `body`.
- **Copy to clipboard:** one action copies paste-ready `"Subject: …\n\n<body>"`. Core to the copy-paste-only product — no send / mailto.
- **`eval_score`** plus a clear visual indicator when `gate_passed` is false (flagged state) so gate failure is glanceable, not just a bare number.
- **`eval_breakdown.dimensions`:** the five 1–5 scores; **`eval_breakdown.gates`:** the three booleans only.
- **`match_data`:** `overall_match_summary` inline by default; remaining fields inside a collapsed-by-default `<details>` section — mirrors the discovery-frame `confidence_breakdown` precedent (`OPEN_QUESTIONS.md` Resolved → "UI-level exposure of confidence_breakdown").

**Single-shot design:** Once a result exists (successful mutation **or** sessionStorage rehydration), FRAME 6 shows the result only — no Generate button again. A failed attempt (before any success) may show Retry. Regenerating after a successful result is out of scope for v1 — see `OPEN_QUESTIONS.md` Explicitly deferred.

**Mark as Sent (outcome logging, Slice 1):** Once a result exists (same condition as above — live mutation success **or** sessionStorage rehydration), FRAME 6 shows an explicit **Mark as Sent** button next to Copy. Wired with `useMutation` calling `POST /outcomes` with `{ generated_email_id: <current email id>, event_type: "sent" }` — explicit click, no auto-fire, surfaces `ApiError.user_message` on failure with Retry available (same §8.2.1 pattern as generate/extract/discover). On success the button becomes a disabled confirmed state ("✓ Marked as sent"). That confirmed state is a **frontend UX guard** (`sentOutcomeLogged` on `discoveryFlow`) against accidental duplicate clicks — **backed by** the backend invariant of at most one non-voided SENT per email (partial unique index + `create_outcome` gate; see §9). A rare backend rejection (stale rehydration, manual API use) still surfaces `ApiError.user_message` the same way as other mutations on this page. Confirmed state is persisted so a refresh re-shows confirmed rather than inviting a duplicate attempt; no `GET /outcomes` re-check. Other event types and logging against past emails live on `/history` (Slice 2b — see §8.6); FRAME 6 stays current-email `sent` only.

**sessionStorage extension:** Added `generatedEmail: GeneratedEmailOut | null` and `sentOutcomeLogged: boolean` on the existing `discoveryFlow` key (not a sibling). Same paid-call rehydration reasoning as resume/JD (§8.2.2–§8.2.3): generation spends LLM credits (match + generate + eval, possibly silent internal retry); refresh must not re-call `POST /generated-emails`. `sentOutcomeLogged` is co-located so it clears/resets with the email it refers to (see §8.2.2).

### 8.3 API client and shared 401 handling

**Decision:** A single `request(path, options)` wrapper around `fetch` (not axios). Base URL from `import.meta.env.VITE_API_BASE_URL`. Attaches `Authorization: Bearer <access_token>` from localStorage when present. JSON bodies set `Content-Type: application/json`; `FormData` bodies are passed through without forcing that header (browser sets the multipart boundary). On non-2xx, throws an `ApiError` carrying the backend's `{user_message, error_code}` shape so UI code can surface `user_message` directly. On **401 when an Authorization header was actually sent**: clear both tokens from localStorage and `window.location.assign('/login')` — no refresh attempt.

**Reasoning:** One shared 401 path means callers never re-implement "session died" behavior. Refresh-on-401 is deliberately out of scope for this slice (redirect-to-login only); `POST /auth/refresh` exists on the backend but is unused here. The "Authorization was sent" guard matters because `/auth/login` also returns 401 for bad credentials — without it, a failed login would clear storage and force a full-page reload instead of showing `user_message` on the form.

**Backend contract verified against `app/routers/auth.py` / `app/schemas/auth.py`:**
- `POST /auth/signup` → `TokenPairOut` (201) — tokens returned immediately
- `POST /auth/login` → `TokenPairOut`
- `POST /auth/refresh` → `TokenPairOut` (body: `{refresh_token}`) — present, unused on 401
- `POST /auth/logout` → 204 (body: `{refresh_token}`) — client logout calls this, then clears localStorage

### 8.4 Token storage: localStorage

**Decision:** Persist `access_token` and `refresh_token` in `localStorage`.

**Reasoning / tradeoff:** Matches the backend's current JSON-body refresh transport (no httpOnly cookie). Any XSS that can run script in the origin can read those tokens — that is the concrete risk this choice accepts. This does **not** reopen or flip the deferred cookie-transport decision; it is the client-side half of the same simplicity choice. See `OPEN_QUESTIONS.md` ("Refresh-token transport") for the revisit trigger, which is no longer purely theoretical now that localStorage is the live storage mechanism.

### 8.5 Brand assets

**Decision:** Product brand is **Inroad** (full first-contact form: "Inroad: Targeted Outreach Platform"). The logo mark source of truth is `frontend/src/assets/logo.svg` — a capital-"I" monogram on a rounded-square ("squircle") badge. The persistent logged-in header (`AppHeader` on `/`, `/history`, and `/analytics`) shows the mark + "Inroad" wordmark with an always-visible "Targeted Outreach Platform" caption, plus main nav links (Search → `/`, History → `/history`, Analytics → `/analytics`); login/signup use the full form as the page heading with the mark above it.

**Color palette:** Taken from existing `frontend/src/index.css` tokens — badge fill `--accent` (`#1f6b5a`), letter fill `--bg` (`#f7f6f4`). No new brand palette was invented for the mark.

**Favicon generation:** Raster PNGs are produced from the master SVG with **sharp** (libvips), chosen because the frontend is already a Node/Vite toolchain — no Python cairo stack required. Script: `frontend/scripts/generate-favicons.mjs`, run via `npm run generate-favicons`. `sharp` is a frontend `devDependency` only. Re-run after redesigning `logo.svg`; the PNG/SVG outputs under `frontend/public/` are committed static assets (not generated at app runtime).

**Favicon file set** (linked from `frontend/index.html`, SVG first with PNG fallback):
- `frontend/public/favicon.svg` (copy of the master mark)
- `frontend/public/favicon-16x16.png`
- `frontend/public/favicon-32x32.png`
- `frontend/public/apple-touch-icon.png` (180×180)

### 8.6 Outcome history view (`/history`)

**Decision:** A dedicated protected route `/history` (`HistoryPage`) lists past `GENERATED_EMAILS` rows, shows which have logged outcomes, lets the user log **any** `OutcomeEventType` against any row, and retract mistaken logs. This is the Slice 2b frontend consumer of Slice 2a's `GET /generated-emails` + `POST /outcomes/{id}/retract`, plus the existing `GET /outcomes` / `POST /outcomes`. FRAME 6's Mark as Sent remains a separate surface (current-email-only `sent`) and is unchanged.

**Routing / nav:** Wrapped in the same `ProtectedRoute` as `/`. `AppHeader` gained Search / History / Analytics `NavLink`s (previously brand + page-local actions only — no shared layout wrapper; each page still mounts `AppHeader` itself). Analytics was added in the §10 slice; History was the first nav link beyond brand+actions.

**No sessionStorage (deliberate contrast with §8.2.2):** `/history` does **not** persist list or detail state in `sessionStorage`. On `/`, `discoveryFlow` exists specifically to avoid re-spending LLM/provider credits on refresh. `GET /generated-emails` and `GET /outcomes` are free, idempotent reads — refetching on mount/refresh is simpler and correct. Leaving that contrast undocumented would look like a forgotten feature; it is intentional.

**`useQuery` (first genuine read-only case — contrast with §8.2.1):** List fetches use TanStack Query `useQuery` (`listGeneratedEmails`, `listOutcomes`), not `useMutation`. §8.2.1's all-`useMutation` pattern covers side-effecting, credit-spending, user-triggered actions where automatic refetch would be harmful. Here the data is cacheable/refetchable server state with no credit cost, so `useQuery` (mount fetch, invalidate-on-mutation) is the right tool. Detail expand uses `useQuery` with `enabled: row.id === expandedId` for `getGeneratedEmailById`. Log / retract remain `useMutation` and invalidate the outcomes query key on success.

**Client-side outcome grouping (O(1) network, not O(n)):** On mount, fetch the full email list and the full (unfiltered) outcomes list once. Group outcomes by `generated_email_id` in memory — that map drives both the per-row stage badge (highest-tier label — see below) and the expanded-row timeline. Do **not** re-fetch outcomes per row; do **not** ask the backend to join outcome status onto `GET /generated-emails` (Slice 2a deliberately scoped that endpoint as single-purpose). Expand fetches full `GeneratedEmailOut` only when a row opens (list shape omits body / eval_breakdown / match_data).

**Filter:** Client-side only over already-fetched data — All / Logged / Not yet logged. **Default on page load: Logged** (hides emails with zero non-voided outcomes). No pagination (same scale reasoning as elsewhere).

**Row expansion:** Controlled accordion via a single page-level `expandedId: number | null` on `HistoryPage` — not native `<details>`, not a Set, not per-row local open state. Clicking a row's toggle sets `expandedId` to that row's id (or `null` if it was already expanded), so at most one row is open by construction. Changing the All / Logged / Not yet logged filter resets `expandedId` to `null` so expand state does not leak across tabs. The panel animates open/closed with a CSS `grid-template-rows` + opacity transition (no animation library). Expanded content: subject/body + outcome timeline + log-any-event form + per-entry retract (inline two-click Confirm/Cancel, not `window.confirm()`).

**Log-form SENT gate (in-memory):** The per-row log form derives enablement from the already-fetched outcomes group for that email — no extra fetch. Disable Sent when a non-voided Sent already exists; disable the other three event types unless a non-voided Sent exists. Mirrors the backend create-time gate (§9).

**Retract cascade confirm:** Retracting a Sent row when other non-voided outcomes exist for that email shows inline cascade copy ("Retracting 'Sent' will also retract all other logged outcomes…") before Confirm/Cancel — still the existing inline pattern, not `window.confirm()` or a modal. Plain retract confirm when Sent is alone (or when retracting a non-Sent row). Existing `OUTCOMES_QUERY_KEY` invalidation refetches the full list, so cascade-voided siblings disappear without extra client logic.

**Expected filter interaction after retract:** If retracting the last non-voided outcome for an email while the filter is Logged (the default), that email disappears from the visible list on refetch. Correct behavior — not a bug; no special-casing to keep it visible. Same after a SENT cascade retract that voids every remaining outcome for that email. **Underlying data behavior is unchanged by the visual fade below** — membership still follows non-voided outcome counts after `OUTCOMES_QUERY_KEY` invalidation; the fade is presentation only.

**Toast / snackbar (log + retract confirmation):** A single page-level toast on `HistoryPage` (one visible at a time — a new success replaces whatever is showing; no queue/stack). Auto-dismisses after ~3 seconds. Fires on every successful log or retract, on every filter tab, whether or not a fade-and-remove also runs. Copy is event-type-specific: log → `"Marked as Sent"` / `"Marked as Replied"` / `"Marked as Interview"` / `"Marked as No Response"`; retract → `"Retracted: Sent"` / `"Retracted: Replied"` / etc., using the retracted row's `event_type`. Plain presentational markup + a dismiss timer — no toast library.

**Fade-and-remove (tab-specific visual only):** Two trigger conditions only; every other tab/action combination updates the row's badge/timeline in place with no fade:

| Active filter | Action | Fade-and-remove? |
| --- | --- | --- |
| Not yet logged | First non-voided outcome logged (active count was 0 immediately before) | Yes |
| Logged | Retract that leaves zero non-voided outcomes (including SENT cascade that voids all siblings) | Yes |
| All | Log or retract | Never |
| Logged | Log (adds an outcome; row stays in Logged) | Never |
| Not yet logged | Retract | N/A in practice (unlogged rows have nothing to retract) |
| Logged | Retract that leaves ≥1 active outcome | Never |

Mechanism: at mutation `onSuccess`, before `OUTCOMES_QUERY_KEY` invalidation, compute whether the action changes the row's membership in the **currently active** filter from in-memory outcome counts (same grouping map as badges/timeline). If yes, add the email id to a transient local `leaving` set and apply a CSS opacity fade-out class (same no-library, plain-CSS-transition approach as the accordion). Invalidation still runs immediately and updates underlying query data as before; the leaving set keeps the row mounted through the transition. After the fade duration (~280ms, matching the accordion timing), clear the id from the leaving set so the already-refetched filter result removes it from the DOM. If membership does not change, skip the leaving set entirely — invalidate-on-success updates badge/timeline in place.

**Row badge (highest-tier stage, not binary logged/not):** The collapsed-row badge is no longer a binary "Logged" / "Not logged" label. It shows the **highest-tier non-voided outcome** for that email, with fixed precedence **Interview > Replied > No Response > Sent**; emails with zero non-voided outcomes still show **"Not logged"**. Lookup lives in `lib/outcomeStage.ts` (`highestTierOutcome` / `outcomeStageBadgeLabel`) — not inlined in the row — so the same rule can be reused later. Filter membership (Logged / Not yet logged) is unchanged: still based on whether any non-voided outcome exists, not on which stage the badge shows.

**Expanded outcome timeline (chronological connected flow):** The expanded panel replaces the plain vertical `<ul>` with a horizontal connected arrow-style timeline (`history-outcome-flow`). One node per non-voided outcome, ordered by `occurred_at` ascending (actual log chronology — not badge precedence order, not fetch insertion order). Each node keeps event label, formatted date, and its own `RetractOutcomeButton` (per-outcome retract is unchanged). **No Response** is an ordinary node in that sequence — no special branch, marker, or auto-void treatment when a later Replied/Interview exists (automatic No-Response supersession is deferred — see `OPEN_QUESTIONS.md`). Zero non-voided outcomes: same empty copy ("No outcomes logged yet.").

---

## 9. Outcomes: Append-Only Event Log (+ Narrow Retract)

**Decision:** `OUTCOMES` is exposed via a thin router (`app/routers/outcomes.py`) and a thick service (`app/services/outcomes.py`) — create, list, and a one-way retract action. Multiple rows for the same `generated_email_id` are expected for a funnel (sent → replied → interview over time), but **at most one non-voided SENT** per email. There is no general update/delete or un-retract path.

**Endpoints:**
- `POST /outcomes` — body `OutcomeCreate` `{ generated_email_id, event_type }` → `OutcomeOut` (201)
- `GET /outcomes` — optional `generated_email_id` query param → `list[OutcomeOut]` (non-voided only)
- `POST /outcomes/{outcome_id}/retract` — action-style state transition (same convention as `POST /resumes/{id}/extract`), sets `voided=true` → `OutcomeOut`. Idempotent if already voided. Retracting a non-voided SENT also voids every other non-voided outcome for that email in the same transaction.

Both create/list and retract require `get_current_user`. No pagination in v1 (same scale reasoning as resume row growth in `product_discovery_summary.md`).

**Ownership-verification patterns:**
- **Create:** `create_outcome` calls `get_generated_email_by_id(db, current_user, generated_email_id)` — the same Resume-join helper used by `GET /generated-emails/{id}` — before insert. Missing and wrong-owner emails both raise `NotFoundError` (non-distinguishing 404). After that check passes, `outcome.user_id = current_user.id` is set directly from the already-verified caller; it is never derived from client input and never inferred by re-walking the GeneratedEmail → Resume join.
- **Retract:** simpler — verifies `outcome.user_id == current_user.id` **directly** on the Outcome row. Re-walking the GeneratedEmail/Resume join would be redundant given the denormalized `user_id` already written at create time. Missing or wrong-owner → same non-distinguishing `NotFoundError`.

**Create-time SENT gate:** Before insert, `create_outcome` reads existing non-voided rows via `list_outcomes` (same CRITICAL DISCIPLINE). If `event_type == SENT` and a non-voided SENT already exists → `ValidationError` ("already marked as sent…"). If `event_type != SENT` and no non-voided SENT exists → `ValidationError` ("Mark this email as sent before…"). DB backstop: partial unique index `uq_outcomes_generated_email_id_nonvoided_sent` (migration `e8a3c71f2049`); concurrent SENT races that pass the app check raise `IntegrityError`, which is translated to the same already-sent `ValidationError` — never leaked as a 500.

**Retract cascade (SENT only):** When retracting a non-voided SENT, `retract_outcome` voids that row **and** every other non-voided outcome for the same `generated_email_id` in one transaction (siblings discovered via `list_outcomes`). Retracting a non-SENT row voids only that row. After a SENT cascade retract, re-logging Sent is a fresh insert (voided SENT rows do not block the partial unique index).

**Why `user_id` is denormalized on `OUTCOMES` but not on `GENERATED_EMAILS`:** List/analytics reads filter `Outcome.user_id == current_user.id` with no join. That is the payoff of denormalizing for a locked per-user analytics read pattern. `GENERATED_EMAILS` still uses the Resume join for ownership (deferred denormalization — see `OPEN_QUESTIONS.md`). The divergence is deliberate; do not "fix" one to match the other without re-reading both decisions.

**CRITICAL DISCIPLINE — all OUTCOMES reads go through `app/services/outcomes.py`:** Every read of OUTCOMES (current `list_outcomes`, and analytics via that helper in §10) MUST go through this service module rather than a fresh ad-hoc query written elsewhere. That is what keeps the `voided=false` filter from being silently forgotten by a future read path. Stated in the module docstring as well as here — code, not just docs.

**Related — generated-email list (picker support):** `GET /generated-emails` → `list[GeneratedEmailListOut]` (ownership via the same Resume join as GET-by-id; joins Contact/Company for display fields; does **not** join outcome status). Documented in `DATA_MODEL.md` §2.7; lives in `app/services/generated_emails.py` / `app/routers/generated_emails.py`.

**Schemas:** `OutcomeCreate` / `OutcomeOut` in `app/schemas/outcome.py`. `OutcomeOut` omits `user_id` (auth-scoped reads) but includes `voided` so the retract response can confirm the resulting state (list responses still exclude voided rows, so `voided` there always reads `false`). `OutcomeEventType` is imported from `app/core/enums.py`.

---

## 10. Analytics: Reply-Rate Summary (Computed on Read)

**Decision:** MVP feature #7 — reply rate broken down by contact confidence tier and by email eval score — ships as `GET /analytics/summary` → `AnalyticsSummary`. No new tables, no migrations, no caching/precomputation. Aggregate fresh on every request.

**Endpoint:** `GET /analytics/summary` behind `get_current_user`. Thin router (`app/routers/analytics.py`) calls `get_reply_rate_summary` in `app/services/analytics.py`.

### 10.1 Pure compute / DB orchestration split

**Decision:** `analytics.py` mirrors the `eval.py` / `matching.py` precedent — a pure function `_compute_summary(outcomes, emails) -> AnalyticsSummary` with no DB session / no `current_user`, plus a thin DB-touching wrapper `get_reply_rate_summary(db, current_user)` that loads data and delegates.

**Reasoning:** Same testability reason as ARCHITECTURE.md §2 ("services are unit-testable without a DB/HTTP layer"). Reply-rate math has several easy-to-get-wrong edge cases (dedup, boundary buckets, null-vs-zero rates); exhaustive unit tests against the pure function catch those without a Postgres fixture.

### 10.2 Entity-read discipline

**Decision:**
- Outcomes come only from `outcomes.list_outcomes(db, current_user)` — analytics never queries `Outcome` directly. That keeps the `voided=false` filter from being silently forgotten (same CRITICAL DISCIPLINE as §9).
- Generated-email fields (id, `eval_score`, contact `best_verification_tier`) come only from a new helper `list_generated_emails_for_analytics` in `generated_emails.py` — analytics never queries `GeneratedEmail` or `Contact` directly. Same "one file owns reads of its entity" rule already enforced for OUTCOMES, now extended to GeneratedEmail.

Internal return shape is a frozen dataclass `GeneratedEmailAnalyticsFields` — not a client-facing Pydantic Out (never crosses the API boundary).

### 10.3 Locked numerator / denominator / bucketing / n= rules

**Numerator (replied):** an email counts once if it has ≥1 non-voided outcome with `event_type` in `{REPLIED, INTERVIEW}` **and** is also in the denominator. Dedup by `generated_email_id` — multiple REPLIED/INTERVIEW rows for the same email still count once. INTERVIEW alone (no separate REPLIED row) still counts as replied.

**Denominator (sent):** an email counts once if it has ≥1 non-voided `SENT` outcome. Dedup by `generated_email_id`. Do **not** use "every row in GENERATED_EMAILS" — a generated email the user never marked Sent is excluded from the overall total and from every breakdown bucket.

**Confidence-tier breakdown:** uses `Contact.best_verification_tier` directly (existing 4-value enum) — no numeric rebinning.

**Eval-score breakdown:** fixed buckets on `GeneratedEmail.eval_score` with locked boundary inclusivity (stated in code comments on `_eval_score_bucket`):
- `"<3"` = `[0, 3)` — includes 0, excludes 3.0
- `"3-4"` = `[3, 4)` — includes 3.0, excludes 4.0
- `"4+"` = `[4, 5]` — includes 4.0 and 5.0

**Two separate lists, not a cross-tab:** tier and eval-score breakdowns are independent. Cross-tabbing was explicitly rejected for v1 — it fragments an already-small sample into near-empty cells. Revisit once real volume exists (see `OPEN_QUESTIONS.md`).

**Sample size always shown; omit empty buckets:** every displayed rate shows its `n=` (sent count). A bucket with `sent == 0` is **omitted** from its breakdown list entirely (not shown as `n=0`). A bucket with `sent > 0` and `replied == 0` **is** shown, with `reply_rate=0.0` (real measured zero ≠ no data). The overall summary (`total_sent`, `total_replied`, `overall_reply_rate`) is always returned even when zero — it is the top-level fact, not a bucket.

**Null vs 0.0 for rates:** `overall_reply_rate` and any per-bucket `reply_rate` is `null`/`None` when that scope's sent count is 0 — never fabricate a `0.0` for "no data," only for "data that measured zero." Per-bucket rows are only emitted when `sent > 0`, so their `reply_rate` is never null in the response schema.

**Interaction with retract (expected, not a bug):** Retracting a non-voided
`SENT` **cascades** — every other non-voided outcome for that email is voided
in the same transaction (§9). The email therefore drops out of both
`sent_ids` and `replied_ids` (and every breakdown bucket) together; there is
no longer a lingering non-voided `REPLIED`/`INTERVIEW` row after a SENT
retract. Retracting only a non-SENT row leaves SENT (and analytics membership)
intact. Same "row can disappear from the default Logged filter on `/history`"
precedent (§8.6) applies when a cascade clears the last non-voided outcomes.

### 10.4 No caching

**Decision:** Aggregate fresh on every GET. No Redis, no materialized view, no precomputed summary table.

**Reasoning:** Same "don't add infra ahead of evidence" judgment already locked for Redis in §5.1. This endpoint's read volume is trivially low (personal analytics, not a high-throughput dashboard). Revisiting would require measured evidence that re-aggregation is a bottleneck — not a hypothetical preference for "analytics usually caches."

### 10.5 Frontend (`/analytics`)

**Decision:** Protected route `/analytics` (`AnalyticsPage`), same `ProtectedRoute` pattern as `/` and `/history`. `AppHeader` nav: Search / History / Analytics. `useQuery` (not `useMutation`) for `GET /analytics/summary` — free, idempotent read, same reasoning as `/history` §8.6. No `sessionStorage`. Types/API in `lib/analyticsTypes.ts` + `lib/analyticsApi.ts`. UI shows overall rate with `n=`, the two breakdown lists, a clear "no sent emails logged yet" empty state when `overall_reply_rate` is null, and a short caveat that early sample sizes are directional rather than statistically significant.

---

