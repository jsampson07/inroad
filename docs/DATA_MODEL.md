# Data Model Reference

> For external readers: this is a living schema and Pydantic-shape decision log from active development — entity-by-entity rationale and migration conventions, not a frozen ERD handout.

*Companion to `product_discovery_summary.md`, which locks the 9 core entities and their relationships, and to `ARCHITECTURE.md`. This document covers how those entities are expressed as Pydantic schemas and how the first Alembic migration is structured.*

---

## 1. General Pydantic Schema Pattern

**Decision:** Most entities get up to three schema classes rather than one:

- **`XBase`** — fields common to both create and read variants, so they're defined once.
- **`XCreate`** — required input when the entity is first created. Never includes `id` or server-generated fields like `created_at`.
- **`XOut`** — safe/useful fields to return. Includes `id`, timestamps, and everything the frontend needs — nothing it shouldn't see. Uses `model_config = ConfigDict(from_attributes=True)` to read directly off ORM objects.

**Reasoning:** This is the practical mechanism behind the models/schemas boundary described in `ARCHITECTURE.md` §2 — different moments in an entity's life legitimately expose different fields, and `response_model=XOut` acts as an explicit allowlist so FastAPI can never accidentally serialize a DB-only column (e.g. a password hash) that happens to be reachable on the ORM object.

**Not every entity needs all three variants.** Several entities in this project are never directly created by a user-facing API call — they're populated as a *side effect* of another operation (a search, a generation run). Those get an `Out` schema and, where relevant, a different request schema entirely (see `COMPANIES`, `RAW_PROVIDER_RESULTS`, `GENERATED_EMAILS` below) — forcing every entity into a `Create` schema would misrepresent how it actually gets written.

---

## 2. Entity-by-Entity Schemas

### 2.1 USERS

```python
class UserBase(BaseModel):
    email: EmailStr

class UserCreate(UserBase):
    password: str

class UserOut(UserBase):
    id: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)
```

**Decision detail:** `UserCreate.password` (plaintext, in transit only) is deliberately named differently from the ORM's `password_hash` column. This is a small guard against a copy-paste bug that assigns the raw password straight into the hash column because the field names happened to match.

### 2.2 RESUMES

```python
class ResumeCreate(BaseModel):
    raw_text: str

class ResumeOut(BaseModel):
    id: int
    user_id: int
    raw_text: str
    extracted_data: "ResumeExtraction | None"
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

class ExperienceEntry(BaseModel):
    company: str
    title: str
    start_date: str
    end_date: str | None
    bullet_points: list[str]

class ProjectEntry(BaseModel):
    name: str
    description: str | None = None
    technologies: list[str] = []
    bullet_points: list[str] = []

class ResumeExtraction(BaseModel):
    skills: list[str]
    experience: list[ExperienceEntry]
    education: list[str]
    candidate_name: str | None = None
    projects: list[ProjectEntry] = []
```

**Assumption:** File parsing (PDF/docx → text) happens in the router/service before `ResumeCreate` is constructed, so this schema only ever handles text, never file bytes — keeping Pydantic's job "validate structured data" rather than "handle file I/O."

**Decision (gap filled):** The HTTP create path is **not** `POST /resumes` with a JSON `ResumeCreate` body. The live router accepts **multipart** `UploadFile` under the form field name `file` (`POST /resumes`), parses PDF/DOCX server-side (pypdf / python-docx), enforces a 2MB cap and a 50-character minimum on extracted text, then builds `ResumeCreate(raw_text=...)` internally before insert. `ResumeCreate` remains the internal/validated text shape; clients that send JSON `{raw_text}` will not match the endpoint. Limits and `user_message` copy are locked in `app/services/resume.py`.

**Decision (revision):** `candidate_name: str | None = None` and `projects: list[ProjectEntry] = []` (with `ProjectEntry`) were added after the original `ResumeExtraction` lock, following real dogfooding: generated emails never cited personal/academic/hackathon project work (no extraction field existed), and sign-offs had no candidate name (same gap). Defaults match the `EvalGates.no_unprompted_gap_admission` pattern so pre-existing `extracted_data` JSONB rows without these keys still deserialize without error. `candidate_name` is extracted from resume text (header/contact block), not a dedicated `USERS` profile field — see `OPEN_QUESTIONS.md`. `projects` are distinct from formal `experience` roles; work already presented inside a job entry should not be duplicated.

### 2.3 JOB_DESCRIPTIONS

Structurally identical to Resumes:

```python
class JobDescriptionCreate(BaseModel):
    raw_text: str
    company_id: int
    role_title: str

class JobDescriptionOut(BaseModel):
    id: int
    user_id: int
    company_id: int
    role_title: str
    raw_text: str
    extracted_data: "JDExtraction | None"
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

class JDExtraction(BaseModel):
    required_skills: list[str]
    responsibilities: list[str]
    seniority_level: str | None
```

**Decision:** A GET-by-id route now exists — `GET /job-descriptions/{jd_id}` → `JobDescriptionOut` (no schema change; the response shape already covered both pre- and post-extraction state via `extracted_data: JDExtraction | None`). Added to unblock frontend refetch-by-id after upload without either re-running paid `POST …/extract` or persisting raw JD text in browser storage. Ownership filtering reuses the existing `get_job_description_by_id` helper (id+user_id); see `OPEN_QUESTIONS.md` Resolved "JD read-access control".

**Decision (gap filled):** `JobDescriptionOut.user_id` is present on the live schema (`app/schemas/job_description.py`) and was omitted from this snippet previously. Added here so the documented Out shape matches the API response. JD create remains JSON `JobDescriptionCreate` (paste text) — not multipart — unlike resumes.

### 2.4 COMPANIES

```python
class CompanyOut(BaseModel):
    id: int
    name: str
    domain: str
    model_config = ConfigDict(from_attributes=True)
```

**Decision:** No `CompanyCreate`. A user never directly creates a `Company` row through an API call — the flow is: user submits a search request, and `contact_discovery.py` internally decides whether to reuse an existing row or insert a new one. The search input is its own schema:

```python
class ContactDiscoveryRequest(BaseModel):
    company_domain: str
    role_title: str
```

**Reasoning:** Not every table needs a `Create` schema mirroring a REST "create this resource" pattern — `COMPANIES` is populated as a side effect of searching, not as its own direct user action.

### 2.4.1 Company Name Resolution (pre-search step, no backing table)

```python
class CompanySearchRequest(BaseModel):
    query: str  # raw user-typed company name

class CompanySearchCandidate(BaseModel):
    name: str
    domain: str

class CompanySearchResponse(BaseModel):
    candidates: list[CompanySearchCandidate]
```

**Decision:** These schemas back a distinct endpoint that runs *before* `ContactDiscoveryRequest`, not a variant of it. A user types a company name; this endpoint returns candidates for the user to pick from (see `ARCHITECTURE.md` §7); whichever `domain` the user ends up confirming — from a candidate or from the manual-entry fallback — is what populates `ContactDiscoveryRequest.company_domain` in the very next request. No table backs `CompanySearchResponse` itself, for the same reason `ContactDiscoveryRequest` has none: this is a lookup, not a resource being created. `COMPANIES` is still the only table actually written to, and only later, inside `contact_discovery.py`, exactly as already designed.

### 2.5 RAW_PROVIDER_RESULTS

```python
class RawProviderResultOut(BaseModel):
    id: int
    company_id: int
    provider_name: str
    candidate_name: str | None
    candidate_title: str | None
    candidate_email: str | None
    verification_tier: VerificationTier
    raw_response: dict
    queried_at: datetime
    model_config = ConfigDict(from_attributes=True)
```

**Decision:** No user-facing `Create` — rows are populated internally from `ContactProvider.search()` output (see `ARCHITECTURE.md` §4.4). This schema exists mainly for internal/debug/admin use and as the explicit translation point between `ProviderCandidate` and the DB row, not for a public API route.

### 2.6 CONTACTS

```python
class ConfidenceBreakdown(BaseModel):
    verification_tier_score: float
    cross_provider_corroboration: bool
    employment_currency_signal: str   # "current" | "stale" | "unknown"
    domain_check_passed: bool
    name_collision_detected: bool

class ContactOut(BaseModel):
    id: int
    company_id: int
    name: str | None
    title: str | None
    email: str | None
    best_verification_tier: VerificationTier
    confidence_score: float
    confidence_breakdown: ConfidenceBreakdown
    model_config = ConfigDict(from_attributes=True)
```

**Decision:** `confidence_breakdown` is exposed through the API (not just the internal `confidence_score` float), and is **persisted** as a JSONB column on `CONTACTS` (see §3.5) rather than computed at read time.

**Reasoning:** Exposing the full breakdown avoids re-introducing the "hand-waved single score" problem at the API boundary that the product doc explicitly designed the confidence model to avoid. Persisting it is cheap — written once at contact-creation/reconciliation time, read back as a normal column — and is strictly less read-time work than recomputing an aggregation from `RAW_PROVIDER_RESULTS` on every fetch. The one real cost: if reconciliation ever reruns for an existing contact, the persisted breakdown has to be recomputed and overwritten at that point, not left stale.

**Deferred, not decided:** Which subset of `confidence_breakdown` fields the frontend actually surfaces to the user is a UI-copy decision, not a schema decision — the schema intentionally exposes the full object; the frontend picks what to render.

### 2.6.1 ContactDiscoveryResponse (wraps ContactOut for the discovery endpoint only)

```python
class ContactDiscoveryResponse(BaseModel):
    contact: ContactOut | None
    fallback_reason: str | None
    tier_used: str | None
```

**Decision:** Per-search context (which tier hit, why earlier tiers were skipped) is
returned transiently by the discovery endpoint — never persisted, never added to
`ContactOut`. `ContactOut` stays the stable, search-independent resource; this mirrors
the same stable-vs-per-search boundary `product_discovery_summary.md` already draws
when explaining why `SEARCHES` is deferred. `contact` is nullable to represent every
tier being exhausted with zero candidates found.

### 2.7 GENERATED_EMAILS

```python
class EvalGates(BaseModel):
    """Internal judge/refine shape — includes violation_detail for refine()."""
    no_unsupported_claims: bool
    correct_contact_name_used: bool
    no_unprompted_gap_admission: bool = True
    violation_detail: str | None = None

class EvalGatesOut(BaseModel):
    """Client-facing gates — omits violation_detail (internal refine feedback)."""
    no_unsupported_claims: bool
    correct_contact_name_used: bool
    no_unprompted_gap_admission: bool = True

class EvalDimensions(BaseModel):
    role_company_specificity: int   # 1-5
    relevance_alignment: int
    tone_professionalism: int
    conciseness: int
    clear_cta: int

class EvalBreakdown(BaseModel):
    gates: EvalGates
    dimensions: EvalDimensions

class EvalBreakdownOut(BaseModel):
    """Client-facing breakdown — gates omit violation_detail."""
    gates: EvalGatesOut
    dimensions: EvalDimensions

class EvalResult(EvalBreakdown):
    """Raw shape returned by the LLM-judge call — before it's decided
    whether to trigger refine() and before it's persisted."""
    pass

class EmailDraft(BaseModel):
    subject: str
    body: str

class SkillMatch(BaseModel):
    jd_requirement: str
    matched: bool
    resume_evidence: str | None

class ExperienceAlignment(BaseModel):
    jd_responsibility: str
    resume_evidence: str | None
    strength: Literal["strong", "partial", "none"]

class MatchData(BaseModel):
    skill_matches: list[SkillMatch]
    experience_alignment: list[ExperienceAlignment]
    unmatched_jd_requirements: list[str]
    notable_resume_strengths: list[str]
    overall_match_summary: str

class GenerateEmailRequest(BaseModel):
    contact_id: int
    resume_id: int
    job_description_id: int

class GeneratedEmailOut(BaseModel):
    id: int
    contact_id: int
    resume_id: int
    job_description_id: int
    subject: str
    body: str
    eval_score: float
    eval_breakdown: EvalBreakdownOut
    match_data: MatchData
    gate_passed: bool
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

class GeneratedEmailListOut(BaseModel):
    """Display-focused list shape for a past-email picker — not a full row."""
    id: int
    subject: str
    contact_name: str | None
    contact_title: str | None
    company_name: str
    eval_score: float
    gate_passed: bool
    created_at: datetime
```

**Decision:** No `GeneratedEmailCreate` — like `COMPANIES`, this entity is the *output* of a flow (IDs in → match/generate/eval → a row out), not something a user POSTs as a ready-made email. The request body for that flow is `GenerateEmailRequest` below — not a create schema.

**Decision (gap filled):** `GenerateEmailRequest` was never defined in this document previously — §2.7 only specified `GeneratedEmailOut` and noted "no `GeneratedEmailCreate`" without naming the actual request body. That was a real documentation gap, not a rename: the endpoint takes `{contact_id, resume_id, job_description_id}` and the server owns generation, scoring, and persistence. Added here to match `app/schemas/generated_email.py` / `POST /generated-emails`.

**Decision (gap filled — list shape):** `GeneratedEmailListOut` is a separate Out for the past-email picker list (`GET /generated-emails`), not a reuse of full `GeneratedEmailOut`. A list view is a different consumer than a single-record fetch (same XOut-per-moment pattern in §1) — full `body`, `eval_breakdown`, and `match_data` are not needed to identify which email to act on. Contact name/title and company name are joined from `CONTACTS` / `COMPANIES` at read time. Outcome status (e.g. "already marked sent") is deliberately **not** joined on this endpoint — keep it single-purpose; a future frontend can cross-reference `GET /outcomes` client-side. No pagination in v1 (same scale reasoning as resume row growth in `product_discovery_summary.md`).

**Decision (revision):** `EvalGates.violation_detail: str | None = None` was added after the original schema lock. It is free-form text (not a fixed violation-type enum) populated by the LLM judge only when at least one Tier 1 gate is `False`, naming the specific problem (e.g. which claim isn't traceable to `match_data`, or how the contact name/title was wrong). It exists solely to feed `refine(email, feedback)` — it is not persisted as its own column (it rides along inside the persisted `eval_breakdown` JSONB on `GENERATED_EMAILS`). A fixed enum was considered and rejected: gate failures are too situation-specific for a closed category list to stay useful as refine feedback without constantly expanding the enum.

**Decision (revision):** `EvalGates.no_unprompted_gap_admission: bool = True` (mirrored on `EvalGatesOut`) was added after the original two-gate schema lock, following a real dogfooding failure where a generated cold email factually admitted an experience gap — which passed `no_unsupported_claims` but is bad outreach strategy. Default `True` (not required) so pre-existing `eval_breakdown` JSONB rows from the 2-gate era still deserialize without error; those rows keep their originally computed `gate_passed` under the old definition and are **not** retroactively recomputed. `violation_detail` remains shared across all three gates — no per-gate detail field.

**Decision (API boundary fix):** Earlier docs claimed `violation_detail` "is never shown to the user," but `GeneratedEmailOut.eval_breakdown` was typed as the full internal `EvalBreakdown` / `EvalGates` — so FastAPI would have serialized `violation_detail` on every `GeneratedEmailOut` response (including the pre-existing `POST /generated-emails`). Fixed by introducing response-only `EvalGatesOut` / `EvalBreakdownOut` (no `violation_detail`) and pointing `GeneratedEmailOut.eval_breakdown` at `EvalBreakdownOut`. The internal `EvalGates` / `EvalBreakdown` / `EvalResult` shapes retain the field for judge → refine. The JSONB column may still contain `violation_detail`; the Out schema strips it at serialization time.

**Decision (GET-by-id ownership):** `GET /generated-emails/{generated_email_id}` scopes reads via a join — `GeneratedEmail` → `Resume` on `resume_id`, filter `GeneratedEmail.id` + `Resume.user_id == current_user.id`. There is no `user_id` column on `GENERATED_EMAILS` (confirmed on the ORM model). This is sufficient because `generate_and_persist_email` loads both `resume_id` and `job_description_id` through ownership-filtered helpers scoped to `current_user` at write time, so `resume.user_id == job_description.user_id` holds for every existing row by construction. Missing and wrong-owner rows both raise `NotFoundError` (non-distinguishing 404). A denormalized `user_id` column was considered and deferred — see `OPEN_QUESTIONS.md` "GENERATED_EMAILS.user_id denormalization".

**Decision:** `EmailDraft` is the ephemeral LLM structured-output shape for generation and refine (`subject` + `body` only). It is not a persisted entity and has no backing table — `GENERATED_EMAILS` stores subject/body as columns on the row written by `app/services/generated_emails.py`. Keeping draft I/O separate from `GeneratedEmailOut` avoids conflating "what the model just produced" with "what was saved and returned to the client."

**Decision:** Match/gap analysis is persisted as a `match_data` JSONB field on `GENERATED_EMAILS`, rather than left ephemeral (computed at generation time and discarded). This matches the same "persist for audit fidelity" tradeoff already accepted for `RAW_PROVIDER_RESULTS` in the product doc, and enables future analytics (e.g. reply rate vs. skill-match completeness) without needing a schema change later.

**`MatchData`'s role — this is important and was explicitly clarified during design:**
- `MatchData` is the *complete* comparison between resume and JD — every skill checked, every responsibility assessed, every gap named. Completeness here is what makes it useful for grounding and evaluation.
- It is **not** a template or checklist the generated email is expected to work through. The email is not validated against `match_data` field-by-field, and it should not mention most of what's in it — an email that recited every matched skill would read as a resume dump, not outreach.
- In the **generation prompt** (`email_generation.py`), `match_data` is passed in full as *guidance*: the model is instructed to select at most 2-3 of the strongest points and write around them naturally, not enumerate everything. `unmatched_jd_requirements` specifically exists as the disallow-list for generation — nothing in it should be mentioned, referenced, implied, or acknowledged (not merely "don't claim as strengths"); the email should read as entirely positive framing from the selected strengths.
- In the **eval/judge prompt** (`eval.py`), `match_data` plays a different role: a ground-truth *reference to verify against*. The Tier 1 hard gate ("no unsupported claims") checks whether every claim actually made in the email traces back to something in `match_data` — it doesn't check for completeness, only for the absence of false claims. This is why the rubric structurally does not reward or require resume-dumping: conciseness and specificity are separate graded dimensions, and the hard gate only ever checks precision, never recall.
- `overall_match_summary` is the one field meant for direct consumption in the generation prompt (the compressed framing/angle); the other fields are the selectable menu and the verification reference.

**Decision:** For v1, the LLM's selection of which 2-3 match points to feature in a given email is **free-form** — the model chooses based on its own judgment each time, rather than the pipeline pre-ranking `skill_matches` and constraining the model to the top-ranked items.

**Alternative considered:** Ranking matches by a relevance heuristic before prompting, and instructing the model to prefer top-ranked items. More debuggable/reproducible (clearer "why did it pick this one"), but more code in the matching step. Deferred — free-form is simpler to build, and inconsistent-but-plausible selection is treated as an acceptable v1 behavior to observe before deciding it's a real problem worth engineering around.

### 2.8 OUTCOMES

```python
class OutcomeEventType(str, Enum):
    SENT = "sent"
    NO_RESPONSE = "no_response"
    REPLIED = "replied"
    INTERVIEW = "interview"

class OutcomeCreate(BaseModel):
    generated_email_id: int
    event_type: OutcomeEventType

class OutcomeOut(BaseModel):
    id: int
    generated_email_id: int
    event_type: OutcomeEventType
    occurred_at: datetime
    voided: bool
    model_config = ConfigDict(from_attributes=True)
```

**Decision:** No `OutcomeUpdate` schema. `OUTCOMES` is an append-only event log per the product doc — the primary operations are "log a new event" and "read history." Correcting *which real event happened* (e.g. logging `replied` after `sent`) is still a new appended row, not a mutation of an existing one.

**Decision (narrow retract exception):** Append-only does **not** cover the case where *an event never happened at all* — e.g. an accidental "Mark as Sent" click. Appending a compensating event would invent a fake history entry for something that didn't occur; hard-deleting would erase the audit trail. The deliberate exception is a one-way soft-delete: `voided: bool` on the ORM (`NOT NULL`, default `false`; migration `c4f8e2a91b07`), flipped only by `POST /outcomes/{outcome_id}/retract` (false→true). No un-retract path — if someone retracts a real event by mistake, the correction is logging a fresh event, not reversing the retraction. No other field is mutable. This preserves the spirit of "we don't rewrite history" (row stays in Postgres; event payload is unchanged) while allowing genuine mistakes to be corrected. It is **not** a general update/delete surface and does **not** abandon the append-only principle for real events.

**Decision (correction — `OutcomeOut` includes `voided`):** An earlier note claimed `OutcomeOut` should omit `voided` because `list_outcomes` filters `voided=false`, so clients never see voided rows. That reasoning holds for list responses (where `voided` will always read `false`, which is correct and expected) but does **not** apply to `POST /outcomes/{id}/retract`, whose entire purpose is to change `voided` — its response is the one place a client most needs to confirm the resulting state, and there is no `GET /outcomes/{id}` to query it another way. `voided` is therefore included on `OutcomeOut`. Gap found during Slice 2a review; corrected in the same slice scope.

**Decision (`occurred_at` semantics):** Server-stamped only (`server_default=func.now()`); no client-supplied override on `OutcomeCreate`. Means when the event was logged, not necessarily when it happened in the real world. Deliberate v1 choice favoring log-order over precise elapsed-time — see `OPEN_QUESTIONS.md` Resolved "OUTCOMES.occurred_at: server-stamped vs. client-supplied backdating" for the one-way-door caveat and revisit trigger.

**Decision (revision):** The ORM model gained a denormalized `user_id` column (`FK → users.id`, `NOT NULL`, `index=True`) after the initial 9-table migration already created `OUTCOMES` without it. Reasoning: the analytics view (MVP feature #7 — per-user reply rate by confidence tier / eval score) is a **locked** primary read pattern, not a hypothetical future cost. Filtering `OUTCOMES` by `user_id` directly avoids a 3-table join (`Outcome → GeneratedEmail → Resume → User`) on every analytics query. This deliberately diverges from the `GENERATED_EMAILS.user_id` deferral — that table already shipped without denormalization and its join cost was unmeasured; `OUTCOMES` is new-to-API and the read pattern was known before the column was added. `user_id` is set server-side only (`current_user.id` after `get_generated_email_by_id` verifies ownership) — never taken from client input. `OutcomeOut` deliberately excludes `user_id` (implicit via auth scope), same allowlist principle as `RefreshTokenOut` excluding `token_hash`. `OutcomeEventType` lives in `app/core/enums.py` (shared with the ORM column), not redefined in the schema file — same pattern as `VerificationTier`. See `OPEN_QUESTIONS.md` "GENERATED_EMAILS.user_id denormalization" for the cross-reference that documents why the two tables made opposite calls.

**Decision (SENT uniqueness + create-time gate + retract cascade):** At most one non-voided `SENT` per `generated_email_id`, enforced by partial unique index `uq_outcomes_generated_email_id_nonvoided_sent` (`WHERE voided = false AND event_type = 'sent'`; migration `e8a3c71f2049`). This resolves the "Future interaction — uniqueness on SENT" note under the soft-delete Resolved entry in `OPEN_QUESTIONS.md`: the index **must** exclude voided rows so a legitimate retract can be followed by a fresh SENT insert. App-level create gates in `create_outcome` (via `list_outcomes`): (1) a second non-voided SENT → `ValidationError`; (2) any non-SENT event without an existing non-voided SENT → `ValidationError`. The unique index is also a race backstop (concurrent SENT inserts) — `IntegrityError` is translated to the same `ValidationError`, not leaked. Retract cascade: voiding a non-voided SENT also voids every other non-voided outcome for that email in the same transaction; retracting a non-SENT row does not cascade. Re-marking Sent after retract is a new row, not an un-void.

### 2.9 REFRESH_TOKENS

```python
class RefreshTokenOut(BaseModel):
    id: int
    user_id: int
    expires_at: datetime
    revoked_at: datetime | None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)
```

**Decision:** No `RefreshTokenCreate`, and no route ever returns `RefreshTokenOut` as part of a login/refresh response body. Like `COMPANIES` and `GENERATED_EMAILS`, this entity is populated as a side effect (of login or token refresh), not a direct user-facing create. `RefreshTokenOut` deliberately excludes `token_hash` entirely — the same allowlist principle that keeps `UserOut` from ever exposing `password_hash` in §2.1. This schema exists for potential internal/debug use (e.g. a future "list my active sessions" feature), not for the actual login/refresh response, which will need its own `TokenPairOut`-style schema (`access_token`, `refresh_token`, `token_type`) carrying the raw token values — that schema is built at auth-implementation time, not decided here.

**Reasoning:** Added during Phase 1 planning as a direct consequence of the JWT auth-flow decision (see `OPEN_QUESTIONS.md`'s "Resolved" section): the refresh token is deliberately an opaque random string, not a JWT, so it can be revoked before its natural expiry — logout only works if something persists to revoke. `token_hash` (not the raw token) is what's stored, mirroring the same reasoning as `UserCreate.password` vs. the ORM's `password_hash` column in §2.1 — never persist a secret in a form that's directly usable if the row leaks. `token_hash` carries a unique index for the same lookup-performance reasoning as `Company.domain` in `ARCHITECTURE.md` §5 — the refresh endpoint looks a presented token up by its hash on every call.

### 2.10 AnalyticsSummary (computed on read — no backing table)

```python
class ConfidenceTierBreakdown(BaseModel):
    tier: VerificationTier
    sent: int
    replied: int
    reply_rate: float  # never null — rows only emitted when sent > 0

class EvalScoreBucketBreakdown(BaseModel):
    bucket: Literal["<3", "3-4", "4+"]
    sent: int
    replied: int
    reply_rate: float  # never null — same guarantee as tier rows

class AnalyticsSummary(BaseModel):
    total_sent: int
    total_replied: int
    overall_reply_rate: float | None  # None when total_sent == 0
    by_confidence_tier: list[ConfidenceTierBreakdown]
    by_eval_score_bucket: list[EvalScoreBucketBreakdown]
```

**Decision:** These schemas back `GET /analytics/summary` only. They are **computed on every read** from existing `OUTCOMES` + `GENERATED_EMAILS` / `CONTACTS` data — **not persisted**, **no migration**, no new table. Same category as `CompanySearchResponse` / `ContactDiscoveryResponse`: response shapes with no backing storage. Aggregation rules (numerator/denominator, eval-score bucket boundaries, omit-empty-buckets, null-vs-0.0 rates) are locked in `ARCHITECTURE.md` §10 — this section only records the API shapes.

**Decision:** Tier and eval-score are two **separate** lists on `AnalyticsSummary`, not a cross-tabulated matrix. Cross-tabbing was explicitly rejected for v1 (see `ARCHITECTURE.md` §10 / `OPEN_QUESTIONS.md`).

---

## 3. Alembic Migration Plan

### 3.1 Single initial migration

**Decision:** All 9 tables are created in one initial migration, not split into one migration per table.

**Reasoning:** The general Alembic convention (one migration per logical change) exists to track incremental schema discovery over time. That doesn't apply here — the schema was fully locked (all entities, relationships, and field-level decisions above) before any migration is written. Splitting into 9 migrations would re-enact a design process that's already finished.

`REFRESH_TOKENS` (added during Phase 1 planning, after the original seven entities were locked) is still included in this same initial migration rather than treated as a later addition. The distinction that matters isn't *when* a table was decided, it's whether it was fully decided before the migration file gets written — `REFRESH_TOKENS`' schema was locked before any migration exists, exactly like the original seven; it just wasn't locked at the same moment they were.

**Where multiple migrations remain correct:** Genuinely later, uninformed-at-this-point additions — e.g. the deferred `SEARCHES` table from the product doc's deferred-features list — since that decision, by design, comes only after real usage informs whether it's needed.

**Additive migrations after the initial 9-table schema (recorded):**
- `97807b9a3c89` — add `user_id` to `job_descriptions` (ownership scoping identified after the initial migration existed).
- `75ea1b948b2a` — add `user_id` to `outcomes` (denormalization for the locked analytics read pattern; table already existed from the initial migration without this column). Same distinction as future entities like `SEARCHES`: the table was created before this need was identified, so the change is a second, additive migration against an already-existing table — **not** rewritten into the original initial migration.
- `c4f8e2a91b07` — add `voided` to `outcomes` (`NOT NULL`, default `false`; soft-delete for mistaken logs — see §2.8 retract exception). No index on `voided`: list/analytics already scope by indexed `user_id`, and a boolean alone is too low-selectivity to justify a standalone index.
- `e8a3c71f2049` — partial unique index `uq_outcomes_generated_email_id_nonvoided_sent` on `outcomes (generated_email_id) WHERE voided = false AND event_type = 'sent'` (at most one active SENT per email; see §2.8).

### 3.2 Naming convention

**Decision:** An explicit `NAMING_CONVENTION` dict is set on `MetaData` in `app/db/base.py` before any migration is generated:

```python
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}
metadata = MetaData(naming_convention=NAMING_CONVENTION)
Base = declarative_base(metadata=metadata)
```

**Reasoning:** Without this, Postgres/SQLAlchemy auto-generates constraint names that aren't guaranteed consistent across environments. A future hand-written migration (e.g. dropping a constraint) needs a predictable name to reference rather than one that has to be looked up directly in the database.

### 3.3 `env.py` setup

**Decision:** `target_metadata = Base.metadata` (with every model imported into `db/base.py` so autogenerate can see them), and the database URL is read from `settings` (`pydantic-settings`/env var) rather than hardcoded in `alembic.ini`.

**Reasoning:** `target_metadata` is what makes `alembic revision --autogenerate` possible at all. Reading the URL from settings matters once more than one database exists (local dev vs. deployed) — hardcoding risks pointing the migration tool at the wrong one.

### 3.4 Postgres enum handling

**Decision:** For every enum persisted as a column (`VerificationTier` on `RAW_PROVIDER_RESULTS` and `CONTACTS`; `OutcomeEventType` on `OUTCOMES`), the migration's `upgrade()` explicitly creates the Postgres native enum type, and `downgrade()` explicitly drops it after dropping the dependent table(s):

```python
def upgrade():
    verification_tier = sa.Enum(
        "verified", "pattern_guessed", "catch_all", "unknown",
        name="verification_tier"
    )
    verification_tier.create(op.get_bind())
    # ... op.create_table(...)

def downgrade():
    op.drop_table("raw_provider_results")
    sa.Enum(name="verification_tier").drop(op.get_bind())
```

**Reasoning:** Postgres implements enums as a genuine native type, not a `VARCHAR` with a constraint. `downgrade()` dropping the table does *not* drop the type — re-running `upgrade()` after a `downgrade()` without the explicit `drop()` fails with "type already exists." Autogenerate sometimes misses this in the generated `downgrade()`, so it must be manually checked, not trusted blindly.

**Note:** `ProviderStatus` (see `ARCHITECTURE.md` §4.4) is *not* one of these — it's a transient orchestration signal inside `contact_discovery.py`, never written to a column, so it has no migration footprint. `REFRESH_TOKENS` has no enum columns either — it's untouched by this section.

### 3.5 JSON columns use `JSONB`, not `JSON`

**Decision:** All JSON-shaped columns — `raw_response` (`RAW_PROVIDER_RESULTS`), `eval_breakdown` and `match_data` (`GENERATED_EMAILS`), and `confidence_breakdown` (`CONTACTS`) — use Postgres's `JSONB` type.

**Reasoning:** `JSON` stores an exact text copy (preserving formatting/key order) and re-parses on every read. `JSONB` stores a decomposed binary format — no formatting preserved, but indexable and faster to query. None of these columns need exact-formatting preservation, and some (e.g. `match_data`) may plausibly need to be queried into later for debugging/analytics. No scenario in this schema favors plain `JSON`. `REFRESH_TOKENS` has no JSON-shaped columns and is unaffected by this decision.

### 3.6 Foreign keys require explicit indexing

**Decision:** Every foreign key column is declared with `index=True` at the model level: `resumes.user_id`, `refresh_tokens.user_id`, `job_descriptions.user_id/company_id`, `raw_provider_results.company_id`, `contacts.company_id`, `generated_emails.contact_id/resume_id/job_description_id`, `outcomes.user_id/generated_email_id`.

**Reasoning:** Postgres automatically indexes primary keys and `unique=True` columns, but **not** foreign key columns. Columns like `generated_emails.contact_id` will be queried constantly (fetching a contact's emails, analytics joins) — without an explicit index, that's a sequential scan as tables grow. Autogenerate mirrors exactly what the SQLAlchemy models specify, so this must be decided at the model layer, not patched into the migration afterward.

### 3.7 Migration workflow

1. Write all 9 model files in `app/models/`, with `index=True` on every FK and `JSONB` on every JSON-shaped column decided upfront.
2. `alembic revision --autogenerate -m "initial schema"`.
3. **Manually review before running:** enum `drop()` calls present in `downgrade()`, every FK column indexed, `JSONB` (not `JSON`) picked up correctly, table creation order matches the dependency graph (`USERS`/`COMPANIES` first, `OUTCOMES` last).
4. `alembic upgrade head` against local Postgres.
5. Sanity check with `\d+ <table>` in `psql` to confirm enum types, JSONB columns, and FK indexes actually exist rather than assuming the generated file is correct.

### 3.8 Entity dependency order

```
USERS ─────────────┐
                    ├──> RESUMES
                    ├──> REFRESH_TOKENS
                    ├──> JOB_DESCRIPTIONS.user_id
                    └──> OUTCOMES.user_id
COMPANIES ──────────┼──> JOB_DESCRIPTIONS
                    ├──> RAW_PROVIDER_RESULTS
                    └──> CONTACTS
                              │
RESUMES + JOB_DESCRIPTIONS + CONTACTS ──> GENERATED_EMAILS
                                                  │
                                          GENERATED_EMAILS ──> OUTCOMES
```

Autogenerate performs this topological sort automatically via foreign keys; it isn't hand-ordered. Worth understanding independently so an incorrect autogenerate diff is recognizable rather than assumed correct.

---

## Brand / product naming (2026-08-05)

**No change needed.** The Inroad rebrand is product naming and static brand assets only — no entity, column, enum, JSONB shape, or migration changes. (The `outcomes.user_id` additive migration is a separate, later decision — see §2.8 / §3.1.)

## /history toast + fade-and-remove (2026-08-08)

**No change needed.** Toast confirmations and tab-specific fade-and-remove on `/history` are frontend presentation only — transient local leaving-set + CSS, plus invalidate-on-success already owned by the outcome mutations. No entity, column, enum, JSONB shape, endpoint, or migration changes.
