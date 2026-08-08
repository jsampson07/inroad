# Progress Snapshot

> For external readers: this is a living, session-overwritten implementation snapshot from active development — verified against the codebase each session, not a polished changelog or finished status report.

*Overwritten each session, not appended to. Reflects verified state as of the session ending 2026-08-08 — FRAME 1 manual-entry escape hatch on non-empty company-search results.*

---

## Implemented so far

### Verified working (functionally exercised, not just present)

- **FRAME 1 manual-entry escape hatch (this session, frontend-only):**
  - When Clearbit returns ≥1 candidate, a "Can't find what you're looking for?" underlined text link (`.text-link`) renders beneath the candidate list in `HomePage.tsx`.
  - Clicking it calls `openManualFallback()` — same destination as the existing auto-routes: clears candidates, sets `showManualFallback`, prefills `manualName` from the search query. Reuses the existing `.manual-fallback` form + `handleManualConfirm` entirely (no duplicate manual-entry UI).
  - Zero-candidates and Clearbit-failure auto-routing unchanged.
  - Closes out the last item from the original five-branch `/history` + company-search UX roadmap.
- **Frontend tests run this session:**
  ```
  npm run test:run
  → Test Files  11 passed (11)
  → Tests  77 passed (77)
  ```
  New coverage: escape link present when candidates.length ≥ 1 (and manual frame not auto-shown); click transitions to manual frame and lock-in via "Use this company" works from this path. Existing zero-candidates / Clearbit-failure / manual-confirm tests left unmodified.
  `npx tsc -b` clean.
- **Prior slices unchanged:** /history stage badge + timeline, toast + fade-and-remove, SENT gate + retract cascade, `/analytics`, FRAME 6 Mark as Sent. No backend/schema/API changes this session.

### Present, but not yet exercised by anything

- **Manual browser dogfood** of the candidate-list escape link → manual domain confirm path (Vitest covers transition + lock-in).
- **Manual browser dogfood** of `/history` stage badge + timeline, toast/fade, SENT gate / cascade, `/analytics` — still pending from prior sessions.
- **Router-level HTTP TestClient suites** for analytics / Slice 2a list/retract — still service-level / pure-function only.

### Not started

- **Automatic No-Response supersession** on later Reply/Interview (deferred — `OPEN_QUESTIONS.md`).
- **Apollo/Anymail providers**, **refresh-token rotation / cookie transport / rate-limiting**, **public/live deployment**, **`GENERATED_EMAILS.user_id` denormalization**, **resume picker reuse**, **regenerate-email control**, analytics cross-tab / date-range (deferred — see `OPEN_QUESTIONS.md`).

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

**Doc/code check this session:** `ARCHITECTURE.md` §7 UX contract updated — three paths to the same manual-entry frame (two automatic, one user-triggered). `DATA_MODEL.md` / `product_discovery_summary.md` / `OPEN_QUESTIONS.md` explicitly marked no-change.

---

## What's next

1. **Manual browser dogfood** of FRAME 1 escape hatch, `/history` stage badge + timeline, toast/fade, SENT gate / cascade, `/analytics`.
2. **Deferred follow-up:** automatic No-Response supersession (backend void + frontend-visible effect) when trigger conditions in `OPEN_QUESTIONS.md` are met.
3. **Stretch — rate-limiting** before any public deploy.

---

## Test results (this session — actual suite output)

```
frontend: npm run test:run
→ Test Files  11 passed (11)
→ Tests  77 passed (77)

frontend: npx tsc -b
→ exit 0 (clean)
```

**Not run this session:** backend pytest, live LLM/provider calls, manual browser walkthrough.

---

## Doc notes from this session

- **`PROGRESS.md`:** overwritten for FRAME 1 candidate-list → manual-entry escape hatch; notes this closes the last item from the original five-branch `/history` + company-search UX roadmap.
- **`ARCHITECTURE.md`:** §7 UX contract — three entry paths to the same manual-entry frame (zero candidates, Clearbit failure, user-triggered link).
- **`OPEN_QUESTIONS.md`:** explicit no-change note (no new open/deferred question).
- **`DATA_MODEL.md`:** explicit no-change note (frontend presentation only).
- **`product_discovery_summary.md`:** explicit no-change note (no MVP scope change).
