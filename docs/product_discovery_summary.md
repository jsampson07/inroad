# Inroad: Targeted Outreach Platform — Product Discovery Summary

> For external readers: this is the locked product-scope and rationale document from active development — MVP boundaries, deferred features, and roadmap — not a marketing brief or finished product spec.

*A reference document for scope, decisions, and rationale — built to be re-read throughout development and referenced in interviews.*

---

## Target User

**Primary (v1):** You — a new-grad software engineer job seeker using direct outreach to bypass the ATS, and acting as the tool's own first real user and case study.

**Secondary (post-MVP, architected for but not built for yet):** Other new-grad / early-career job seekers who want the same direct-outreach advantage but lack the tooling or data literacy to do contact discovery and tailored personalization themselves.

---

## Core Problem Statement

New-grad job seekers trying to bypass the ATS via direct outreach face three compounding frictions:

1. **They often don't know who to contact.** The right point of contact may not even be a dedicated recruiter — especially at smaller companies — and they don't want to manually search LinkedIn or company sites to figure it out.
2. **Contact data from any single source is unreliable.** Emails are frequently stale, guessed, or belong to the wrong person entirely.
3. **Genuine personalization doesn't scale.** Writing outreach that's actually tailored to each company and role — not generic — takes more time than most job seekers have across many applications.

The result: job seekers send too few high-quality emails, or too many generic ones, with no reliable way to learn what's actually working.

---

## Value Proposition

Given just a company and a role, the tool:

- **Discovers** the most plausible point of contact using a flexible, tiered search strategy (dedicated recruiter → generalist recruiter/talent acquisition → hiring manager → founder/CEO as fallback for small companies), with a transparent, plain-language reason shown whenever it has to fall back.
- **Verifies** that contact's legitimacy — not role-relevance — across multiple data providers, with a clear confidence signal built from provider verification tier, cross-provider corroboration, employment-currency, domain sanity-checking, and name-collision handling.
- **Drafts** an outreach email grounded in a real structured comparison between the user's resume and the target job description — not a generic prompt — and automatically checks that draft against a quality rubric before showing it.
- **Hands off** the final email for the user to copy and send manually, from their own email client. The app never touches send infrastructure — a structural guarantee, not just a policy promise.
- **Logs** self-reported outcomes (sent / no response / replied / interview) tied to the specific contact-confidence tier and email eval score, so the user can see what's actually converting.

---

## MVP Feature Set (v1)

1. **Auth + user-scoped data model** — lightweight but real, built in from day one so extending to other users later doesn't require a rewrite.
2. **Company identification step** — user types a company name (not a domain); resolved via a lightweight external lookup (Clearbit Autocomplete) into a list of name+domain candidates the user must explicitly select from — never auto-resolved, even on a single match. Falls back to manual domain entry if no match is found or the lookup fails. Fires once per submitted search in v1, not live-as-you-type.
3. **Multi-provider contact discovery & resolution pipeline** (the hero problem):
   - Tiered title/role search strategy (not strict filtering)
   - Queries 2+ providers (Hunter.io, Apollo.io, Anymail Finder)
   - Normalizes schemas across providers into one model
   - Data-legitimacy confidence scoring (verification tier, cross-provider corroboration, employment-currency signal, domain check, name-collision handling)
   - Graceful degradation when a provider fails, rate-limits, or returns nothing
   - Caching to avoid redundant, costly lookups
4. **Resume + JD upload → structured extraction and match/gap analysis** (not raw text stuffed into a prompt). Extraction is its own user-triggered step; match/gap analysis is produced as part of email generation and returned on the generated-email response (`match_data`), not as a separate earlier preview UI.
5. **Grounded email generation with an automated rubric-based quality check** before the email is ever shown to the user
6. **Manual outcome logging** linked to the specific contact + generated email + its eval score
7. **Basic personal analytics view** — reply rate broken down by contact confidence tier and/or email eval score
8. **Copy-paste-only output** — no programmatic sending, no compose-link integration, no email account OAuth

---

## Deferred Features (with rationale)

| Feature | Why it's deferred |
|---|---|
| Gmail OAuth draft/compose integration | Draft-creation scopes typically also grant send capability — building this would downgrade "the app cannot send on your behalf" from a structural guarantee to a policy promise. Rejected for now on principled trust-model grounds; revisit only after everything else is solid. |
| `mailto:` "open in email client" link | Skipped even though nearly free, to keep zero exceptions to the copy-paste-only design. |
| Tracking pixels / unique links for automatic open detection | Reliability has degraded broadly due to privacy proxies and image-blocking clients, and covertly tracking a hiring manager's opens has questionable optics for this kind of tool. Manual self-logging used instead. |
| Scored "role-relevance" ranking metric | Would duplicate the resume↔JD matching engine's job and implies false precision. Transparent, rule-based tiered ranking is used instead; could extend the matching engine later if truly needed. |
| LinkedIn or additional data source integration | Out of scope for v1; current providers cover the core discovery/verification need. |
| **Apollo.io contact provider integration** | **Deferred past the current session**, not because the `ContactProvider` abstraction needs more de-risking — mock-first development already exercised the full orchestration (tiering, cache-then-search ordering, graceful degradation, name-collision handling) end to end via 8 passing service-level tests, independent of which provider sits behind the interface. A second real provider proves integration *breadth*, not correctness. Given a compressed 1-2 week timeline to a demoable build, getting the full pipeline (discovery → resume/JD → generated email, through a real frontend) working end to end once is higher priority than a third data source. Revisit once Hunter is integrated and the LLM layer + frontend are functional. |
| **Anymail Finder contact provider integration** | Same reasoning as Apollo, plus a scheduling constraint specific to this provider: its trial (14 days, no ongoing free tier after) is time-boxed, and Phase 0 always intended it to be activated once the rest of the pipeline was ready to validate against it in one focused pass — not early, and not while other major pieces (LLM layer, frontend) are still unbuilt. Activating it now would risk burning part of the window before there's a full pipeline to validate it against. |
| Multi-user growth features (invites, org/team accounts, admin views) | Real multi-tenancy beyond basic auth isn't needed until there's a second real user. |
| Iterative multi-turn self-critique/refinement UI | Single-pass eval check is v1; deeper iterative refinement is a natural v1.1+ extension. |
| Bulk/batch campaigns, browser extension | Adds real UI/infra complexity without serving the two hero problems. |
| A/B testing of email variants | Needs volume and outcome data that will only exist after v1 has been in real use for a while. |
| Mobile app | Not core to demonstrating the engineering this project is meant to showcase. |
| `SEARCHES` table (per-search contact ranking/tier + user-scoped search history) | Deferred until actually needed. Would capture, per search, why a contact ranked where it did for that specific role (distinct from the contact's stable, search-independent `confidence_score`), and would also enable layering user-scoped history on top of the shared `COMPANIES`/`CONTACTS` cache later without touching that cache's design. |
| Live typeahead company search (debounced, real-time suggestions as the user types) | v1 ships on-submit only — same lookup, same result UI, one call per search. Live typeahead needs debounce timing and request-race handling (a slower in-flight response for an earlier keystroke arriving after a newer one) that on-submit avoids entirely, and Clearbit's real rate limits are still unverified. Purely a frontend upgrade later, isolated from backend/schema. |
| Refresh-token rotation and reuse-detection | v1 ships access + refresh tokens without rotation (see tech-stack "Auth" decision below and `OPEN_QUESTIONS.md`'s "Resolved" section). The refresh token is DB-backed and revocable from day one specifically so rotation/reuse-detection can be added later as a purely additive change — mark the old row revoked, insert a new one — rather than a retrofit. Revisit only if session-hijacking risk becomes a real concern worth the added complexity. |
| Public / live deployment | Deliberately deferred while preparing a public-facing root README for resume/LinkedIn. A live link would expose unbounded login/signup attempts and unbounded LLM-cost spend with no rate controls. Revisit only after the login rate-limiting gap (and related abuse/cost controls) in `OPEN_QUESTIONS.md` is closed — that entry's existing trigger condition, actively evaluated this session, not a new decision. |

---

## Why This Is a Technically Substantial Resume Project

**The competitive reality, addressed head-on:** Contact-finder-plus-AI-email-generator tools already exist as commodity products. That's fine — recruiters don't reward novelty of idea, they reward depth of engineering. This scope is designed so the *idea* being common doesn't matter, because the substance is underneath:

1. **Full-stack breadth** — real auth and a multi-tenant data model from day one, a real backend API, a real frontend, real persistence. Not a script; a system.
2. **Resilience engineering** — a multi-vendor integration with graceful degradation, fallback logic, and cost-aware caching. This pattern generalizes far beyond this project, which makes it a strong, portable interview story.
3. **Data modeling & reconciliation** — normalizing conflicting schemas across third-party APIs, disambiguating name collisions, and building a transparent, explainable confidence model instead of hand-waving a single score.
4. **Applied LLM evaluation, not just LLM calling** — structured extraction, grounded generation, and rubric-based self-evaluation before output is shown. This is the actual differentiator between junior "AI wrapper" work and legitimate applied-AI engineering right now.
5. **Demonstrated product and security judgment** — several explicit, reasoned deferred-feature decisions (the Gmail OAuth trust tradeoff especially) are strong "why I *didn't* build X" answers, which read as more mature than most new-grad projects that only have "why I built X" answers.
6. **Real personal outcome data** — because you're the actual first user, you can speak to genuine before/after results instead of a hypothetical, which is a rare and credible impact story for a solo project.

---

## Prioritized Development Roadmap

**Phase 0 — Setup (before writing product code)**

*Provider access research (resolved):*
- Hunter.io: 50 credits/month on Free tier
- Apollo.io: 900 credits/seat/year (~75/month) on Free tier
- Anymail Finder: no ongoing free tier — one-time 14-day trial, 100 credits, then paid only (~$14–29/mo cheapest tier)

*Dev-data strategy (locked): Combined approach*
- Build the contact-provider layer behind an abstraction/interface from day one, with a mock/fixture provider simulating realistic scenarios (verified vs. guessed emails, cross-provider conflicts, name collisions, rate-limit/timeout failures). This is the primary mode for day-to-day development — not a workaround, but the correct way to build against any costly/rate-limited external dependency.
- Reserve real Hunter/Apollo free-tier credits for periodic checkpoint validation (confirming the real integration actually works), not routine iteration.
- Activate the Anymail Finder 14-day trial strategically, late in Phase 2, once the abstraction layer and the other two providers are already working — use the window for real end-to-end validation of the third integration, not general exploration. Confirm at signup whether a card authorization is required.
- Hold a small paid tier in reserve as a fallback only if mock-first development plus rationed real credits proves genuinely insufficient.

**Data model (locked):** Nine core entities plus a reconciliation layer — `USERS`, `RESUMES`, `JOB_DESCRIPTIONS`, `COMPANIES`, `RAW_PROVIDER_RESULTS`, `CONTACTS`, `GENERATED_EMAILS`, `OUTCOMES`, `REFRESH_TOKENS`. `REFRESH_TOKENS` (`user_id`, `token_hash`, `expires_at`, `revoked_at`) was added during Phase 1 planning as a direct consequence of the JWT auth-flow decision below and in `OPEN_QUESTIONS.md`'s "Resolved" section — it's what makes logout/revocation real in v1 and rotation a purely additive later change rather than a redesign. See `DATA_MODEL.md` §2.9 and §3.8 for the full schema and migration placement. Key decisions:
- `COMPANIES` and `CONTACTS` are a shared/global cache (not user-scoped) to enable cross-user credit savings. Not an irreversible choice — a thin `SEARCHES` join table (`user_id` + `contact_id` + `searched_at`) can be layered on top later for per-user history without touching the shared cache underneath.
- Raw per-provider responses are persisted in `RAW_PROVIDER_RESULTS` — **one row per person-candidate returned, per provider, per company query** (not one row per whole API call). This is forced by consistency with `verification_tier` living on this table: a single call can return multiple people with different tiers, so the row granularity has to be per-person. Each row carries a few structured, queryable fields (candidate name/title/email, verification_tier) plus the full unmodified `raw_response` JSON for audit fidelity. Separately from the reconciled `CONTACTS` record, this enables re-running improved reconciliation logic later without re-spending API credits, and gives a debuggable audit trail for the reconciliation pipeline.
- `verification_tier` (verified / pattern-guessed / catch-all / unknown) is a per-provider fact, so it lives primarily on `RAW_PROVIDER_RESULTS`. `CONTACTS.best_verification_tier` is a derived/summary copy (the best tier observed across corroborating providers), not an independent second source of truth — it feeds into `confidence_score` alongside cross-provider corroboration, employment-currency, and domain checks.
- Candidate-level fields (`candidate_name`, `candidate_title`, `candidate_email`) are persisted directly on `RAW_PROVIDER_RESULTS` rather than parsed from `raw_response` on every read. This is a deliberate duplication, not an oversight: normalization happens once, at ingestion (a relatively rare event given credit conservation), rather than being repeated on every reconciliation run, debug session, or reprocessing pass — data here gets read far more often than it's written. It also enables real indexed SQL filtering on these fields, which pure JSON-blob storage would forfeit.
- Resume-table row growth (even at high tailoring volume, e.g. one resume per application) is not a real concern at this project's realistic scale — an indexed `user_id` keeps lookups fast regardless of row count. If it were ever a UI clutter problem, that's solved with normal product patterns (search/sort/pagination), not a schema change.
- `OUTCOMES` is an append-only event log (not a single mutable status field), so a funnel (sent → replied → interview) can be tracked over time rather than overwritten — this is what makes the analytics feature meaningful.

**Tech stack (locked):**
- **Backend:** Python + FastAPI — chosen over Django/Flask/Node for genuine existing Python fluency, native async support (fits the concurrent multi-provider orchestration directly), and Pydantic models doing double duty as both API validation and structured-extraction schemas.
- **Database:** PostgreSQL + SQLAlchemy + Alembic — matches the relational data model; SQLAlchemy is the standard, most-hireable Python ORM.
- **Auth:** Hand-rolled JWT (bcrypt/passlib for hashing) — a deliberate build-vs-buy call, same logic as the Gmail OAuth decision: own the pieces core to the "full-stack, understood end to end" story rather than plugging in a vendor. Resolved during Phase 1 planning as access token (short-lived, stateless JWT, validated by signature/expiry alone) + refresh token (opaque random string, not a JWT, persisted hashed in a DB-backed `refresh_tokens` table so logout actually revokes it) — without rotation or reuse-detection in v1. See `OPEN_QUESTIONS.md`'s "Resolved" section for the full reasoning and `DATA_MODEL.md` §2.9 for the schema.
- **Frontend:** React + TypeScript, learned for real — closes a genuine credibility gap (prior TS/JS projects were fully AI-written and never read or understood), and directly serves the "full-stack breadth" pillar of the resume-impact case. Validated against current job-market data: Python and SQL are consistently top-tier in demand in 2026 postings, and React holds a commanding lead over Vue/Angular in frontend hiring — this stack maximizes job-posting applicability, not just project fit.
- **Note:** SQL is already genuine, existing knowledge (not a gap to close, unlike React/TS). Writing the analytics-view rollup queries as raw SQL is a reasonable low-cost default since aggregation-by-tier queries are often more precise via direct SQL than an ORM query builder — but it's optional practice, not a requirement; defaulting to the ORM everywhere, including analytics, is a fine fallback if it saves time.

**Eval rubric (locked):**
- **Tier 1 — Hard gates (binary, all must pass):** (1) no unsupported claims (every factual claim traceable to the resume / `match_data`), (2) correct contact name/title used, (3) no unprompted gap admission (the email must not proactively acknowledge, admit, apologize for, or hedge around any qualification/skill/experience gap relative to the JD — even when factually accurate). Gate 3 was added after a real dogfooding session (an end-to-end demo run in the user's own job search) produced a cold email that volunteered an experience gap; that failure is a tone/strategy problem, not a factual-accuracy one, so the existing unsupported-claims gate could not catch it. This is exactly the "real personal outcome data" differentiator above, happening in practice. Failure on any gate is disqualifying regardless of other scores — kept separate from graded dimensions rather than blended into one number, same principle as the earlier data-legitimacy/role-relevance split.
- **Tier 2 — Graded dimensions (e.g. 1–5 each, composited into `eval_score` only if gates pass):** role/company specificity, relevance alignment to the JD match data, tone & professionalism, conciseness, clear call-to-action.
- **Mechanism:** LLM-as-judge — a second call given the email + resume + JD + match data + rubric, returning structured scores via the same Pydantic-schema pattern used for extraction. Requires periodic manual spot-checking against the judge's scores early on to catch calibration drift — an unvalidated eval is its own form of vibe-coding. The same calibration caution applies to the third hard gate after this rubric expansion.
- **On hard-gate failure:** auto-retry once, silently, with the specific failure fed back as feedback; show the result either way (flagged if it still fails). Deliberately implemented as a standalone, reusable `refine(email, feedback) -> new_email` primitive — not inlined into the generation endpoint — so the deferred v1.1+ interactive multi-turn refine loop is a natural extension (more calls, more triggers, a UI) rather than a rebuild.
- **Data model note:** `GENERATED_EMAILS.eval_score` holds the Tier 2 composite; consider adding an `eval_breakdown` JSON field to persist the per-dimension scores and gate results, both for debugging and for the analytics view (correlating specific dimensions, not just one blended score, against reply rate).

**Phase 0 status: complete.** Product vision, MVP scope, data model, tech stack, and eval rubric are all locked. Next step is implementation planning/build.

**Roadmap revision (recorded this session):** The phase descriptions below were originally written assuming a ~6-week build cadence (2 weeks per phase, Phases 1-3). Actual remaining runway is now 1-2 weeks to a demo/resume-presentable state, which has compressed and reordered things. Worth flagging directly rather than quietly reshuffling: Phase 2's hero-problem orchestration logic (tiered discovery, confidence scoring, name-collision handling, graceful degradation, caching) was built and verified against `MockProvider` *before* Phase 1's "one real contact-provider integration working end to end" was ever completed — that Phase 1 commitment did not ship as originally scoped (see `PROGRESS.md` Deviations for the full note). The phase descriptions below are corrected to reflect actual current state and the forward plan, not the original estimate.

**Phase 1 — Foundation (mostly complete):** Auth, core data model, and the full hero-problem orchestration logic (tiered discovery, confidence scoring, name-collision handling, graceful degradation, caching) are built and verified — but validated so far only against `MockProvider`, not a real provider. Two items originally scoped for this phase did not ship and are folded into the immediate next steps rather than treated as done: a working real-provider integration, and a basic frontend shell.

**Phase 2 — Close the loop (current focus):** Company name resolution (`ARCHITECTURE.md` §7) backend is done (`POST /companies/search` via Clearbit Autocomplete — see `PROGRESS.md`). Hunter.io provider integration is done (`HunterProvider` behind `CONTACT_PROVIDER`, HTTP-mocked tests green; live-key checkpoint validation is manual). Apollo and Anymail Finder remain explicitly deferred past this phase (see Deferred Features table above). Next focus shifts to the LLM layer + frontend.

**Phase 3 — Personalization, eval, and a working frontend (biggest remaining risk):** The LLM layer lands in slices rather than one monolith. Structured resume/JD extraction, match/gap analysis (`matching.py`), grounded email generation (`email_generation.py`), and rubric-based judging with silent single-retry (`eval.py`) are built as pure LLM-calling services; `GENERATED_EMAILS` persistence plus `POST /generated-emails` (`generated_emails.py`) now makes the full generate→evaluate→persist loop HTTP-callable end to end via the API — not just at the service level. Frontend: auth foundation is built, and company resolution + contact discovery now ship as a three-frame state machine on the persistent `/` home route (on-submit Clearbit search, explicit candidate/manual lock-in, role-title → `POST /contacts/discover`, result/not-found with sessionStorage rehydration). Next frontend slice is resume/JD upload → extract → generated email on that same home page. That thin end-to-end flow is still the highest remaining risk before the app itself is demoable. Expect to lean on AI assistance more heavily on the frontend than on the backend/LLM logic — full line-by-line understanding of the frontend is not the goal for v1; a working, demoable, honestly-labeled-WIP app is.

**Phase 4 — Ongoing, in parallel with real use**
Outcome logging ships as soon as generation works, so real data starts accumulating immediately. The analytics view matures as you actually use the tool in your own job search — this phase can't be rushed, since it's bottlenecked by calendar time and real outreach, not code.

**Phase 5 — Stretch, only after Phases 1–4 are solid**
Apollo and Anymail Finder integrations (see Deferred Features table), then revisit the rest of the deferred list if time allows: iterative refinement, additional data sources, multi-user growth features, and only reconsider Gmail OAuth integration if the trust-model concern is resolved to your satisfaction.

**Working habit throughout:** after AI helps you implement any piece, explain out loud why it works and what the alternatives were before moving on. If you can't, that's the piece to slow down on.

---

## /history toast + fade-and-remove (2026-08-08)

**No change needed.** Confirmation toast and tab-specific fade-and-remove on the outcome history view are frontend UX polish on an already-scoped MVP surface (past emails + outcome logging/retract). No change to product scope, value proposition, eval rubric, or tech-stack choices.

## /history outcome-stage badge + chronological timeline (2026-08-08)

**No change needed.** Replacing the binary logged badge with highest-tier stage labels and rendering outcomes as a chronological connected timeline are presentation choices on the existing outcome-history MVP surface. No change to product scope, funnel semantics, value proposition, eval rubric, or tech-stack choices. (Automatic No-Response supersession when a later Reply/Interview is logged remains an explicitly deferred implementation item — see `OPEN_QUESTIONS.md`.)

## Manual company-domain escape hatch on candidate list (2026-08-08)

**No change needed.** A user-triggered link from non-empty company-search results into the existing manual name+domain fallback is frontend UX on an already-scoped company-lock-in path (Clearbit suggest + manual domain). No change to product scope, value proposition, eval rubric, or tech-stack choices.

## Hunter discovery diagnostics logging (2026-08-08)

**No MVP-scope change.** Observability-only: structured provider logging. **Doc/code fidelity note:** the locked data-model bullet above ("one row per person-candidate returned…") describes intended audit granularity; the live write path currently persists only title-filtered candidates on a successful tier hit (see `DATA_MODEL.md` session note). That gap is recorded for a later design pass — not fixed here, and not a product-scope change.

## Hunter free-plan Domain Search limit fix (2026-08-09)

**No change needed.** Aligning Domain Search `limit` with Hunter's free-plan cap of 10 is an implementation correction inside the existing provider contract — no change to product scope, value proposition, eval rubric, or tech-stack choices.