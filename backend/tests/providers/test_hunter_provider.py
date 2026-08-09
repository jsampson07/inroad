"""Unit tests for HunterProvider.

Outbound Hunter HTTP is mocked — no real network calls / no credits spent.
Uses stdlib asyncio.run (no pytest-asyncio), matching company_resolution tests.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.core.enums import VerificationTier
from app.providers.base import ProviderStatus
from app.providers.hunter import (
    HunterProvider,
    UnexpectedHunterResponseError,
)


def _mock_client(get_result=None, get_side_effect=None) -> MagicMock:
    client = MagicMock()
    if get_side_effect is not None:
        client.get = AsyncMock(side_effect=get_side_effect)
    else:
        client.get = AsyncMock(return_value=get_result)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    return client


def _response(*, status_code: int = 200, json_data=None, text: str = "") -> MagicMock:
    response = MagicMock(spec=httpx.Response)
    response.status_code = status_code
    response.text = text
    if json_data is not None:
        response.json.return_value = json_data
    else:
        response.json.side_effect = ValueError("No JSON body")
    return response


def _email(
    *,
    value: str,
    first_name: str,
    last_name: str,
    position: str,
    confidence: int,
    verification_status: str,
) -> dict:
    return {
        "value": value,
        "type": "personal",
        "confidence": confidence,
        "first_name": first_name,
        "last_name": last_name,
        "position": position,
        "verification": {"date": "2024-01-15", "status": verification_status},
        "sources": [
            {
                "domain": "example.com",
                "uri": "https://example.com/team",
                "extracted_on": "2020-01-01",
                "last_seen_on": "2024-06-01",
                "still_on_page": True,
            }
        ],
    }


def _domain_payload(emails: list[dict]) -> dict:
    return {
        "data": {
            "domain": "acme.com",
            "organization": "Acme",
            "emails": emails,
        },
        "meta": {"results": len(emails), "limit": 100, "offset": 0},
    }


def test_credit_conservation_one_http_call_across_two_tiers():
    """Two tier searches for one domain must share a single Domain Search call."""
    payload = _domain_payload(
        [
            _email(
                value="alex@acme.com",
                first_name="Alex",
                last_name="Recruiter",
                position="Senior Technical Recruiter",
                confidence=95,
                verification_status="valid",
            ),
            _email(
                value="sam@acme.com",
                first_name="Sam",
                last_name="Founder",
                position="Co-Founder & CEO",
                confidence=90,
                verification_status="valid",
            ),
            _email(
                value="pat@acme.com",
                first_name="Pat",
                last_name="Engineer",
                position="Software Engineer",
                confidence=88,
                verification_status="valid",
            ),
        ]
    )
    client = _mock_client(get_result=_response(json_data=payload))
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        recruiter_result = asyncio.run(
            provider.search(
                "acme.com",
                ["recruiter", "technical recruiter"],
            )
        )
        founder_result = asyncio.run(
            provider.search(
                "acme.com",
                ["founder", "co-founder", "ceo"],
            )
        )

    assert client.get.await_count == 1
    assert recruiter_result.status == ProviderStatus.SUCCESS
    assert founder_result.status == ProviderStatus.SUCCESS
    assert len(recruiter_result.candidates) == 1
    assert recruiter_result.candidates[0].email == "alex@acme.com"
    assert len(founder_result.candidates) == 1
    assert founder_result.candidates[0].email == "sam@acme.com"


def test_rate_limited_cached_no_retry():
    client = _mock_client(
        get_result=_response(status_code=403, text="rate limited")
    )
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        first = asyncio.run(provider.search("acme.com", ["recruiter"]))
        second = asyncio.run(provider.search("acme.com", ["ceo"]))

    assert first.status == ProviderStatus.RATE_LIMITED
    assert second.status == ProviderStatus.RATE_LIMITED
    assert client.get.await_count == 1


def test_error_cached_no_retry():
    client = _mock_client(
        get_result=_response(status_code=500, text="internal error")
    )
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        first = asyncio.run(provider.search("acme.com", ["recruiter"]))
        second = asyncio.run(provider.search("acme.com", ["ceo"]))

    assert first.status == ProviderStatus.ERROR
    assert second.status == ProviderStatus.ERROR
    assert client.get.await_count == 1


def test_pagination_error_400_returns_error():
    """Free-plan rejection of limit>10 — must be ERROR, not a crash or empty SUCCESS.

    Also asserts the outbound request still uses DOMAIN_SEARCH_LIMIT == 10 so an
    accidental bump back to 100 fails this unit test before a live-key check.
    """
    from app.providers.hunter import DOMAIN_SEARCH_LIMIT

    body = (
        '{\n  "errors": [\n    {\n      "id": "pagination_error",\n'
        '      "code": 400,\n'
        '      "details": "The search results are limited to 10 email '
        'addresses on your current plan."\n    }\n  ]\n}'
    )
    client = _mock_client(
        get_result=_response(status_code=400, text=body)
    )
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        result = asyncio.run(provider.search("google.com", ["recruiter"]))

    assert DOMAIN_SEARCH_LIMIT == 10
    assert client.get.await_args.kwargs["params"]["limit"] == 10
    assert result.status == ProviderStatus.ERROR
    assert result.candidates == []
    assert result.error_message is not None
    assert "400" in result.error_message
    assert "pagination_error" in result.error_message


def test_network_error_returns_error_not_raised():
    client = _mock_client(
        get_side_effect=httpx.ConnectError("connection refused")
    )
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        result = asyncio.run(provider.search("acme.com", ["recruiter"]))

    assert result.status == ProviderStatus.ERROR
    assert result.candidates == []


def test_zero_matching_titles_is_success_empty():
    payload = _domain_payload(
        [
            _email(
                value="pat@acme.com",
                first_name="Pat",
                last_name="Engineer",
                position="Software Engineer",
                confidence=88,
                verification_status="valid",
            ),
        ]
    )
    client = _mock_client(get_result=_response(json_data=payload))
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        result = asyncio.run(
            provider.search("acme.com", ["recruiter", "talent acquisition"])
        )

    assert result.status == ProviderStatus.SUCCESS
    assert result.candidates == []


def test_verification_tier_verified():
    payload = _domain_payload(
        [
            _email(
                value="alex@acme.com",
                first_name="Alex",
                last_name="Recruiter",
                position="Recruiter",
                confidence=50,
                verification_status="valid",
            ),
        ]
    )
    client = _mock_client(get_result=_response(json_data=payload))
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        result = asyncio.run(provider.search("acme.com", ["recruiter"]))

    assert result.candidates[0].verification_tier == VerificationTier.VERIFIED


def test_verification_tier_catch_all():
    payload = _domain_payload(
        [
            _email(
                value="alex@acme.com",
                first_name="Alex",
                last_name="Recruiter",
                position="Recruiter",
                confidence=95,
                verification_status="accept_all",
            ),
        ]
    )
    client = _mock_client(get_result=_response(json_data=payload))
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        result = asyncio.run(provider.search("acme.com", ["recruiter"]))

    assert result.candidates[0].verification_tier == VerificationTier.CATCH_ALL


def test_verification_tier_pattern_guessed_by_confidence():
    """status=unknown + confidence ≥ 80 → PATTERN_GUESSED."""
    payload = _domain_payload(
        [
            _email(
                value="alex@acme.com",
                first_name="Alex",
                last_name="Recruiter",
                position="Recruiter",
                confidence=80,
                verification_status="unknown",
            ),
        ]
    )
    client = _mock_client(get_result=_response(json_data=payload))
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        result = asyncio.run(provider.search("acme.com", ["recruiter"]))

    assert (
        result.candidates[0].verification_tier == VerificationTier.PATTERN_GUESSED
    )


def test_verification_tier_unknown_low_confidence():
    """status=unknown + confidence < 80 → UNKNOWN."""
    payload = _domain_payload(
        [
            _email(
                value="alex@acme.com",
                first_name="Alex",
                last_name="Recruiter",
                position="Recruiter",
                confidence=79,
                verification_status="unknown",
            ),
        ]
    )
    client = _mock_client(get_result=_response(json_data=payload))
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        result = asyncio.run(provider.search("acme.com", ["recruiter"]))

    assert result.candidates[0].verification_tier == VerificationTier.UNKNOWN


def test_verification_tier_unknown_for_invalid_status():
    payload = _domain_payload(
        [
            _email(
                value="alex@acme.com",
                first_name="Alex",
                last_name="Recruiter",
                position="Recruiter",
                confidence=99,
                verification_status="invalid",
            ),
        ]
    )
    client = _mock_client(get_result=_response(json_data=payload))
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        result = asyncio.run(provider.search("acme.com", ["recruiter"]))

    assert result.candidates[0].verification_tier == VerificationTier.UNKNOWN


def test_malformed_response_raises():
    client = _mock_client(
        get_result=_response(
            json_data={"unexpected": "shape"},
        )
    )
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        with pytest.raises(UnexpectedHunterResponseError):
            asyncio.run(provider.search("acme.com", ["recruiter"]))


def test_usage_limit_429_is_rate_limited():
    client = _mock_client(
        get_result=_response(status_code=429, text="usage limit")
    )
    provider = HunterProvider(api_key="test-key")

    with patch("app.providers.hunter.httpx.AsyncClient", return_value=client):
        result = asyncio.run(provider.search("acme.com", ["recruiter"]))

    assert result.status == ProviderStatus.RATE_LIMITED
