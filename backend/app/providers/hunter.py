"""Hunter.io Domain Search ContactProvider (ARCHITECTURE.md §4).

Credit conservation: one Domain Search HTTP call per company_domain per
provider instance; later tier search() calls re-filter the cached raw
emails. Instance-local only — not the DB-backed cache from §4.3.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core.enums import VerificationTier
from app.providers.base import (
    ContactProvider,
    ProviderCandidate,
    ProviderSearchResult,
    ProviderStatus,
)

logger = logging.getLogger("app.providers.hunter")

HUNTER_DOMAIN_SEARCH_URL = "https://api.hunter.io/v2/domain-search"
REQUEST_TIMEOUT_SECONDS = 10.0
# Free-plan hard cap: Hunter rejects limit > 10 with HTTP 400 pagination_error.
# Paid plans allow up to 100; bump this one line if/when the account upgrades.
DOMAIN_SEARCH_LIMIT = 10

# Unvalidated v1 VerificationTier mapping — see PROGRESS.md Deviations.
# Hunter Domain Search verification.status values: valid | accept_all | unknown
# (Email Verifier docs also mention invalid / webmail / disposable).
_CONFIDENCE_PATTERN_GUESSED_MIN = 80


class UnexpectedHunterResponseError(Exception):
    """Hunter returned HTTP 200 with a shape we cannot normalize (§4.1 carve-out)."""


def _redact_email(email: Any) -> str:
    """Local-part truncated for INFO logs — full addresses are PII."""
    if not isinstance(email, str) or "@" not in email:
        return "(none)"
    local, _, domain = email.partition("@")
    if not local:
        return f"***@{domain}"
    return f"{local[0]}***@{domain}"


def _candidate_log_fields(email_obj: dict[str, Any]) -> dict[str, Any]:
    email_type = email_obj.get("type")
    position = email_obj.get("position")
    return {
        "type": email_type if isinstance(email_type, str) else None,
        "position": position if isinstance(position, str) else None,
        "email": _redact_email(email_obj.get("value")),
    }


class HunterProvider(ContactProvider):
    name = "hunter"

    def __init__(self, api_key: str | None) -> None:
        self._api_key = api_key
        # Per-domain fetch cache for this instance. Values are either a
        # successful emails list or a non-SUCCESS ProviderSearchResult that
        # later tiers must replay without retrying HTTP.
        self._domain_cache: dict[str, list[dict[str, Any]] | ProviderSearchResult] = {}

    async def search(
        self, company_domain: str, role_titles: list[str]
    ) -> ProviderSearchResult:
        cached = self._domain_cache.get(company_domain)
        if cached is None:
            cached = await self._fetch_and_cache(company_domain)

        if isinstance(cached, ProviderSearchResult):
            logger.info(
                "replaying cached non-SUCCESS result domain=%s status=%s "
                "error_message=%s (no title filter this tier)",
                company_domain,
                cached.status.value,
                cached.error_message,
            )
            return cached

        # Title filtering is owned here (per-provider position match against the
        # orchestrator's tier title list) — not in contact_discovery.py.
        matched: list[dict[str, Any]] = []
        unmatched: list[dict[str, Any]] = []
        for email_obj in cached:
            fields = _candidate_log_fields(email_obj)
            if self._matches_titles(email_obj.get("position"), role_titles):
                matched.append(fields)
            else:
                unmatched.append(fields)

        logger.info(
            "title filter domain=%s acceptable_titles=%s "
            "matched_count=%d unmatched_count=%d matched=%s unmatched=%s",
            company_domain,
            role_titles,
            len(matched),
            len(unmatched),
            matched,
            unmatched,
        )

        candidates = [
            self._to_candidate(email_obj)
            for email_obj in cached
            if self._matches_titles(email_obj.get("position"), role_titles)
        ]
        return ProviderSearchResult(
            provider_name=self.name,
            status=ProviderStatus.SUCCESS,
            candidates=candidates,
        )

    async def _fetch_and_cache(
        self, company_domain: str
    ) -> list[dict[str, Any]] | ProviderSearchResult:
        if not self._api_key:
            result = ProviderSearchResult(
                provider_name=self.name,
                status=ProviderStatus.ERROR,
                error_message="HUNTER_API_KEY is not configured",
            )
            self._domain_cache[company_domain] = result
            return result

        # Never log api_key — only the params that identify the query shape.
        request_params = {
            "domain": company_domain,
            "limit": DOMAIN_SEARCH_LIMIT,
        }
        logger.info(
            "Hunter Domain Search request company_domain=%s params=%s",
            company_domain,
            request_params,
        )

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.get(
                    HUNTER_DOMAIN_SEARCH_URL,
                    params={
                        "domain": company_domain,
                        "api_key": self._api_key,
                        "limit": DOMAIN_SEARCH_LIMIT,
                    },
                )
        except httpx.TimeoutException:
            logger.info(
                "Hunter Domain Search timed out company_domain=%s after %ss",
                company_domain,
                REQUEST_TIMEOUT_SECONDS,
            )
            result = ProviderSearchResult(
                provider_name=self.name,
                status=ProviderStatus.ERROR,
                error_message="Hunter Domain Search timed out",
            )
            self._domain_cache[company_domain] = result
            return result
        except httpx.HTTPError as exc:
            logger.info(
                "Hunter Domain Search network error company_domain=%s error=%s",
                company_domain,
                exc,
            )
            result = ProviderSearchResult(
                provider_name=self.name,
                status=ProviderStatus.ERROR,
                error_message=f"Hunter Domain Search network error: {exc}",
            )
            self._domain_cache[company_domain] = result
            return result

        if response.status_code in (403, 429):
            logger.info(
                "Hunter Domain Search response company_domain=%s http_status=%d "
                "raw_candidate_count=0 body_prefix=%r",
                company_domain,
                response.status_code,
                response.text[:200],
            )
            result = ProviderSearchResult(
                provider_name=self.name,
                status=ProviderStatus.RATE_LIMITED,
                error_message=(
                    f"Hunter Domain Search rate/usage limited "
                    f"(HTTP {response.status_code})"
                ),
            )
            self._domain_cache[company_domain] = result
            return result

        if response.status_code != 200:
            logger.info(
                "Hunter Domain Search response company_domain=%s http_status=%d "
                "raw_candidate_count=0 body_prefix=%r",
                company_domain,
                response.status_code,
                response.text[:200],
            )
            result = ProviderSearchResult(
                provider_name=self.name,
                status=ProviderStatus.ERROR,
                error_message=(
                    f"Hunter Domain Search HTTP {response.status_code}: "
                    f"{response.text[:200]}"
                ),
            )
            self._domain_cache[company_domain] = result
            return result

        try:
            payload = response.json()
        except ValueError as exc:
            raise UnexpectedHunterResponseError(
                "Hunter Domain Search returned non-JSON body"
            ) from exc

        emails = self._extract_emails(payload)
        candidate_summaries = [_candidate_log_fields(e) for e in emails]
        logger.info(
            "Hunter Domain Search response company_domain=%s http_status=%d "
            "raw_candidate_count=%d candidates=%s",
            company_domain,
            response.status_code,
            len(emails),
            candidate_summaries,
        )
        self._domain_cache[company_domain] = emails
        return emails

    def _extract_emails(self, payload: Any) -> list[dict[str, Any]]:
        if not isinstance(payload, dict):
            raise UnexpectedHunterResponseError(
                f"Hunter payload must be an object, got {type(payload).__name__}"
            )
        data = payload.get("data")
        if not isinstance(data, dict):
            raise UnexpectedHunterResponseError(
                "Hunter payload missing object 'data'"
            )
        emails = data.get("emails")
        if not isinstance(emails, list):
            raise UnexpectedHunterResponseError(
                "Hunter payload data.emails must be a list"
            )
        for index, item in enumerate(emails):
            if not isinstance(item, dict):
                raise UnexpectedHunterResponseError(
                    f"Hunter email entry at index {index} is not an object"
                )
        return emails

    @staticmethod
    def _matches_titles(position: Any, role_titles: list[str]) -> bool:
        """Case-insensitive substring match — unvalidated v1 heuristic."""
        if not isinstance(position, str) or not position:
            return False
        position_lower = position.lower()
        return any(
            isinstance(title, str) and title and title.lower() in position_lower
            for title in role_titles
        )

    def _to_candidate(self, email_obj: dict[str, Any]) -> ProviderCandidate:
        first = email_obj.get("first_name")
        last = email_obj.get("last_name")
        name_parts = [
            part
            for part in (first, last)
            if isinstance(part, str) and part.strip()
        ]
        name = " ".join(name_parts) if name_parts else None

        title = email_obj.get("position")
        if not isinstance(title, str) or not title.strip():
            title = None

        email = email_obj.get("value")
        if not isinstance(email, str) or not email.strip():
            email = None

        return ProviderCandidate(
            name=name,
            title=title,
            email=email,
            verification_tier=self._map_verification_tier(email_obj),
            raw_response=email_obj,
        )

    def _map_verification_tier(self, email_obj: dict[str, Any]) -> VerificationTier:
        """Map Hunter verification.status + confidence → VerificationTier.

        Locked v1 thresholds (unvalidated — PROGRESS.md Deviations):
        - status ``valid`` → VERIFIED
        - status ``accept_all`` → CATCH_ALL
        - status in ``invalid`` / ``webmail`` / ``disposable`` → UNKNOWN
        - otherwise (``unknown``, missing, other): confidence ≥ 80 →
          PATTERN_GUESSED; confidence < 80 → UNKNOWN
        """
        verification = email_obj.get("verification")
        status: str | None = None
        if verification is None:
            status = None
        elif isinstance(verification, dict):
            raw_status = verification.get("status")
            status = raw_status if isinstance(raw_status, str) else None
        else:
            raise UnexpectedHunterResponseError(
                "Hunter email.verification must be an object when present"
            )

        if status == "valid":
            return VerificationTier.VERIFIED
        if status == "accept_all":
            return VerificationTier.CATCH_ALL
        if status in ("invalid", "webmail", "disposable"):
            return VerificationTier.UNKNOWN

        confidence = email_obj.get("confidence", 0)
        if confidence is None:
            confidence = 0
        if not isinstance(confidence, (int, float)):
            raise UnexpectedHunterResponseError(
                "Hunter email.confidence must be numeric when present"
            )

        if confidence >= _CONFIDENCE_PATTERN_GUESSED_MIN:
            return VerificationTier.PATTERN_GUESSED
        return VerificationTier.UNKNOWN
