# Progress Snapshot

> For external readers: this is a living, session-overwritten implementation snapshot from active development — verified against the codebase each session, not a polished changelog or finished status report.

*Overwritten each session, not appended to. Reflects verified state as of the session ending 2026-08-08 — /history outcome-stage badge + chronological timeline.*

---

## Implemented so far

### Verified working (functionally exercised, not just present)

- **/history outcome-stage badge + chronological timeline (this session, frontend-only):**
  - Collapsed-row badge no longer binary Logged/Not logged. Shows highest-tier non-voided outcome via fixed precedence **Interview > Replied > No Response > Sent**; empty → **"Not logged"**. Helper: `lib/outcomeStage.ts` (`highestTierOutcome` / `outcomeStageBadgeLabel`).
  - Expanded panel: horizontal connected arrow-style timeline (`history-outcome-flow`). Nodes ordered by `occurred_at` (chronological), not precedence or fetch order. Each node keeps label, date, and per-outcome `RetractOutcomeButton`. No Response has no special treatment. Empty state unchanged.
  - Auto-superseding No Response when a later Reply/Interview is logged: **explicitly deferred** (direction chosen; not built) — see `OPEN_QUESTIONS.md`.
- **Frontend tests run this session:**
  ```
  npm run test:run
  → Test Files  11 passed (11)
  → Tests  76 passed (76)
  ```
  New coverage: `outcomeStage` unit tests (single-tier labels, Sent+No Response → No response, Sent+No Response+Replied → Replied, Interview wins, chronological sort); HistoryPage badge multi-row labels; timeline node count/order + per-node retract recomputes badge (Interview → Replied) without fade. Existing SENT-gate / cascade / toast / fade-and-remove / accordion tests still pass.
  `npx tsc -b` clean.
- **Prior slices unchanged:** toast + fade-and-remove, SENT gate + retract cascade, history expand accordion, `/analytics`, FRAME 6 Mark as Sent. No backend/schema/API changes this session.

### Present, but not yet exercised by anything

- **Manual browser dogfood** of stage-badge labels and horizontal timeline layout/connectors on `/history` (Vitest covers labels, order, retract; visual polish not checked against a running app).
- **Manual browser dogfood** of toast/fade timing, SENT gate / cascade confirm, expand animation, `/analytics` — still pending from prior sessions.
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

**Doc/code check this session:** `ARCHITECTURE.md` §8.6 extended with badge precedence + chronological timeline. `OPEN_QUESTIONS.md` gained Explicitly deferred entry for automatic No-Response supersession. `DATA_MODEL.md` / `product_discovery_summary.md` explicitly marked no-change.

---

## What's next

1. **Manual browser dogfood** of `/history` stage badge + timeline, toast/fade, SENT gate / cascade, `/analytics`.
2. **Deferred follow-up:** automatic No-Response supersession (backend void + frontend-visible effect) when trigger conditions in `OPEN_QUESTIONS.md` are met.
3. **Stretch — rate-limiting** before any public deploy.

---

## Test results (this session — actual suite output)

```
frontend: npm run test:run
→ Test Files  11 passed (11)
→ Tests  76 passed (76)

frontend: npx tsc -b
→ exit 0 (clean)
```

**Not run this session:** backend pytest, live LLM/provider calls, manual browser walkthrough.

---

## Doc notes from this session

- **`PROGRESS.md`:** overwritten for /history outcome-stage badge + chronological timeline.
- **`ARCHITECTURE.md`:** §8.6 badge precedence + chronological connected timeline (per-node retract preserved; No Response has no special treatment).
- **`OPEN_QUESTIONS.md`:** new Explicitly deferred entry — automatic No-Response supersession on later Reply/Interview.
- **`DATA_MODEL.md`:** explicit no-change note (frontend presentation only).
- **`product_discovery_summary.md`:** explicit no-change note (no MVP scope change).
