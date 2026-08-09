# Progress Snapshot

> For external readers: this is a living, session-overwritten implementation snapshot from active development — verified against the codebase each session, not a polished changelog or finished status report.

*Overwritten each session, not appended to. Reflects verified state as of the session ending 2026-08-09 — Hunter free-plan `DOMAIN_SEARCH_LIMIT` fix (100 → 10).*

---

## Implemented so far

### Verified working (functionally exercised, not just present)

- **Hunter free-plan Domain Search limit fix (this session):**
  - `DOMAIN_SEARCH_LIMIT` hardcoded to `10` (free-plan hard cap). Prior value `100` caused HTTP 400 `pagination_error` on every live search. Comment corrected — no settings/env field (same "no configurability ahead of need" pattern as Redis §5.1).
  - Regression test `test_pagination_error_400_returns_error`: mocks the real `pagination_error` body, asserts `ProviderStatus.ERROR` / empty candidates / populated `error_message`, and asserts outbound `limit == 10` so an accidental bump fails in CI before a live-key check.
  - **Live re-probe (`google.com`, `CONTACT_PROVIDER=hunter`, same discover service path):** request `limit=10` → **HTTP 200**, `raw_candidate_count=10`. Title filter: recruiter / talent_acquisition / hiring_manager → **0 matches**; founder tier → **2 matches** (`Director of Business Development`, `Key Account Director` — substring hit on `cto` inside `Director`, not a true CTO title; `Chief Technology Officer` did **not** match `cto`). Discovery returned a contact with `tier_used=founder` and the exhausted-earlier-tiers fallback copy. **Live-key validation for the limit bug: passes** (no longer 400). Google still may not surface genuine recruiter/HR titles in the first free-plan page — empty tiers 1–3 are expected data, not a regression of this fix. The founder false-positive via `cto`⊆`Director` is a pre-existing substring-heuristic quirk, not introduced here and not changed this session.
  - Hunter unit tests: 13 passed (was 12).
- **Hunter structured logging (earlier on this branch):** request/response/title-match INFO logs + `app` logger wiring in `main.py` — still in place; that observability is what found the limit bug.
- **Prior product slices (carried forward — developer-dogfooded earlier; not re-verified this session):** FRAME 1 escape hatch, `/history` stage badge + chronological timeline, toast + fade-and-remove, SENT gate + retract cascade, `/analytics`, FRAME 6 Mark as Sent.

### Present, but not yet exercised by anything

- **Router-level HTTP TestClient suites** for analytics / Slice 2a — still service-level / pure-function only.
- **Widening `RAW_PROVIDER_RESULTS` writes** to all raw Hunter emails / failed searches — gap documented earlier on this branch; explicitly deferred, not part of this fix.

### Not started

- **Automatic No-Response supersession** on later Reply/Interview (deferred — `OPEN_QUESTIONS.md`).
- **Apollo/Anymail providers**, **refresh-token rotation / cookie transport / rate-limiting**, **public/live deployment**, **`GENERATED_EMAILS.user_id` denormalization**, **resume picker reuse**, **regenerate-email control**, analytics cross-tab / date-range (deferred — see `OPEN_QUESTIONS.md`).
- **Title-match heuristic hardening** (e.g. `cto` matching inside `Director`) — observed on live Google founder tier; not in scope for this limit-only fix.

---

## Deviations from `ARCHITECTURE.md` / `DATA_MODEL.md`

*Carry-forward notes from prior sessions that still apply; full historical list trimmed where superseded by docs.*

1. **Enum location:** `app/core/enums.py`. **`DeclarativeBase`** in `db/base.py`. Alembic model registration in `alembic/env.py`.
2. **`extracted_data` is JSONB** (omitted from §3.5 list). **9 tables.** bcrypt + SHA-256 refresh; access 30m / refresh 30d; PyJWT.
3. **`AppException` client key is `user_message`.** Resume HTTP create is multipart `file`, not JSON `ResumeCreate`.
4. **`JOB_DESCRIPTIONS.user_id`** via migration `97807b9a3c89`. Discovery path `POST /contacts/discover`.
5. **LLM defaults:** `claude-haiku-4-5`, `llm_max_retries=1`, `max_tokens=4096`, `LLMExtractionError` → 502.
6. **`MatchData` lives in `app/schemas/generated_email.py`.** No dedicated match HTTP endpoint.
7. **`EvalGates.violation_detail`** + **`no_unprompted_gap_admission`** post-lock revisions; Out shapes strip `violation_detail`.
8. **`generated_emails.py`** is the DB orchestrator; always-insert-never-overwrite. `eval_score` = unweighted mean of five dimensions. Now also owns `list_generated_emails_for_analytics`.
9. **sessionStorage key `discoveryFlow`:** home flow only; `/history` and `/analytics` deliberately have none.
10. **`ResumeExtraction` revision:** `candidate_name` + `projects`/`ProjectEntry`. Deterministic post-eval signature append + `_strip_trailing_closing`.
11. **`OUTCOMES.user_id` denormalized** (migration `75ea1b948b2a`); **`voided`** added (migration `c4f8e2a91b07`); **one non-voided SENT** partial unique index (migration `e8a3c71f2049`) + create-time gate + SENT retract cascade — see `DATA_MODEL.md` §2.8 / `OPEN_QUESTIONS.md`.
12. **Hunter `DOMAIN_SEARCH_LIMIT=10`** (free-plan hard cap). Was 100 → free-plan 400; fixed this session.

**Doc/code check this session:** `OPEN_QUESTIONS.md` pagination + observability entries updated (limit fixed); `ARCHITECTURE.md` §4.6 notes the bug logging surfaced is now fixed; `DATA_MODEL.md` / `product_discovery_summary.md` prior gap notes left as-is + no-change for this limit fix.

---

## What's next

1. **Optional follow-up:** title-match heuristic (`cto` ⊆ `Director` false positive) if dogfooding shows bad founder-tier picks; not blocking live-key use for smaller companies with real recruiter titles in the first page.
2. **Deferred:** `RAW_PROVIDER_RESULTS` completeness, automatic No-Response supersession, rate-limiting before public deploy.

---

## Test results (this session — actual suite output)

```
backend: pytest tests/providers/test_hunter_provider.py
→ 13 passed

Live in-process discover (google.com, CONTACT_PROVIDER=hunter, DOMAIN_SEARCH_LIMIT=10):
→ HTTP 200, raw_candidate_count=10
→ tiers 1–3: 0 title matches; founder: 2 matches (cto⊆Director substring)
→ contact present, tier_used=founder
```

**Not run this session:** full backend pytest suite, frontend tests, live LLM calls. Prior UI dogfood (FRAME 1 / `/history` / `/analytics`) preserved as developer-confirmed from earlier work, not re-run here.

---

## Doc notes from this session

- **`PROGRESS.md`:** overwritten for free-plan limit fix; live-key limit validation passes; Google founder false-positive noted, not fixed.
- **`ARCHITECTURE.md`:** §4.6 — logging outcome: limit bug found and fixed (`DOMAIN_SEARCH_LIMIT=10`).
- **`OPEN_QUESTIONS.md`:** pagination entry records fix (400 → real 200); observability entry notes bug closed; `RAW_PROVIDER_RESULTS` gap still deferred.
- **`DATA_MODEL.md` / `product_discovery_summary.md`:** prior diagnostics notes unchanged; no-change notes for this limit-only fix.
