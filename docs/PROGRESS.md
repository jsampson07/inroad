# Progress Snapshot

> For external readers: this is a living, session-overwritten implementation snapshot from active development — verified against the codebase each session, not a polished changelog or finished status report.

*Overwritten each session, not appended to. Reflects verified state as of the session ending 2026-08-08 — /history toast + fade-and-remove.*

---

## Implemented so far

### Verified working (functionally exercised, not just present)

- **/history toast + tab-specific fade-and-remove (this session, frontend-only):**
  - Single page-level toast on `HistoryPage` (one at a time; new success replaces; ~3s auto-dismiss). Event-type-specific copy for log (`Marked as …`) and retract (`Retracted: …`).
  - Fade-and-remove only when filter membership changes: first log on **Not yet logged**; last-outcome retract (incl. SENT cascade) on **Logged**. **All** never fades — badge/timeline update in place. Toast still fires on every tab.
  - Mechanism: mutation `onSuccess` uses in-memory outcome counts (pre-invalidate) to decide membership change → transient `leaving` set + CSS opacity fade (~280ms) → existing `OUTCOMES_QUERY_KEY` invalidation still drives real data removal; leaving id cleared after the transition. No toast/animation library.
  - Wiring: `HistoryListFeedbackContext` from `HistoryPage` into `LogOutcomeForm` / `RetractOutcomeButton`; helpers in `lib/historyFeedback.ts`.
- **Frontend tests run this session:**
  ```
  npm run test:run
  → Test Files  10 passed (10)
  → Tests  65 passed (65)
  ```
  New coverage: event-type toast text (all `OutcomeEventType` × log/retract); toast replace-not-stack; fade+remove on Not yet logged first log; fade+remove on Logged last retract; no fade on All for log/retract. Existing accordion / filter-reset / expand-fetch / SENT-gate / cascade-confirm tests still pass (retract empty-state waits account for fade duration).
  `npx tsc -b` clean.
- **Prior slices unchanged:** SENT gate + retract cascade (backend + form enablement), history expand accordion, `/analytics`, FRAME 6 Mark as Sent UX. No backend/schema/API changes this session.

### Present, but not yet exercised by anything

- **Manual browser dogfood** of toast timing/placement and fade timing on `/history` (Vitest covers class + removal; visual polish not checked against a running app).
- **Manual browser dogfood** of SENT gate / cascade confirm, expand animation, `/analytics` — still pending from prior sessions.
- **Router-level HTTP TestClient suites** for analytics / Slice 2a list/retract — still service-level / pure-function only.

### Not started

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

**Doc/code check this session:** `ARCHITECTURE.md` §8.6 extended with toast + fade-and-remove (extends, does not replace, the existing filter-interaction note). `DATA_MODEL.md` / `product_discovery_summary.md` explicitly marked no-change. `OPEN_QUESTIONS.md` unchanged — no new unresolved edge case surfaced (in-flight toast replaces; re-marking leaving resets the fade timer).

---

## What's next

1. **Manual browser dogfood** of `/history` toast + fade timing, SENT gate / cascade, expand animation, `/analytics`.
2. **Stretch — rate-limiting** before any public deploy.

---

## Test results (this session — actual suite output)

```
frontend: npm run test:run
→ Test Files  10 passed (10)
→ Tests  65 passed (65)

frontend: npx tsc -b
→ exit 0 (clean)
```

**Not run this session:** backend pytest, live LLM/provider calls, manual browser walkthrough.

---

## Doc notes from this session

- **`PROGRESS.md`:** overwritten for /history toast + fade-and-remove.
- **`ARCHITECTURE.md`:** §8.6 toast/snackbar + fade-and-remove subsection; clarifies underlying data/filter membership unchanged.
- **`DATA_MODEL.md`:** explicit no-change note (frontend UX only).
- **`product_discovery_summary.md`:** explicit no-change note (no MVP scope change).
- **`OPEN_QUESTIONS.md`:** left as-is — no genuine new open question.
