"""Vercel serverless entry point.

Vercel's @vercel/python runtime serves the module-level ASGI ``app``. We also run the
(idempotent) database initialiser at import time, because serverless cold starts do not
reliably fire FastAPI's lifespan startup event, so the tables must be ensured here.
"""
from app.config import settings
from app.database import init_db
from app.main import app  # noqa: F401  — the ASGI app Vercel serves

try:
    init_db(settings.database_url)
except Exception:  # pragma: no cover - never block the import on a transient DB hiccup
    pass
