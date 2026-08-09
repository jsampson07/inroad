import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.exceptions import register_exception_handlers
from app.routers import analytics as analytics_router
from app.routers import auth as auth_router
from app.routers import company_resolution as company_resolution_router
from app.routers import contact_discovery as contact_discovery_router
from app.routers import generated_emails as generated_emails_router
from app.routers import job_description as job_description_router
from app.routers import outcomes as outcomes_router
from app.routers import resume as resume_router


def _configure_app_logging() -> None:
    """Make ``app.*`` INFO logs visible under uvicorn's default config.

    Uvicorn's ``LOGGING_CONFIG`` only attaches handlers to ``uvicorn.*``
    loggers; the root logger stays at WARNING with no handlers. Without this,
    ``logging.getLogger("app…").info(...)`` is silently dropped even though
    uvicorn itself prints at INFO.
    """
    app_logger = logging.getLogger("app")
    if app_logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter("%(levelname)s [%(name)s] %(message)s")
    )
    app_logger.addHandler(handler)
    app_logger.setLevel(logging.INFO)
    app_logger.propagate = False


_configure_app_logging()

settings = get_settings()

app = FastAPI(
    title="Inroad",
    description=(
        "Targeted Outreach Platform — discover a hiring contact for a company, "
        "then draft a resume↔JD–grounded cold email with an automated quality "
        "check. Copy-paste only; the app never sends mail."
    ),
)
register_exception_handlers(app)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_router.router, prefix="/auth")
app.include_router(resume_router.router, prefix="/resumes")
app.include_router(job_description_router.router, prefix="/job-descriptions")
app.include_router(contact_discovery_router.router, prefix="/contacts")
app.include_router(company_resolution_router.router, prefix="/companies")
app.include_router(generated_emails_router.router, prefix="/generated-emails")
app.include_router(outcomes_router.router, prefix="/outcomes")
app.include_router(analytics_router.router, prefix="/analytics")

