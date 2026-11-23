"""Q-3D Learn — FastAPI application entry point.

Run with:  python run.py        (or)  uvicorn app.main:app --reload
API docs:  http://localhost:8000/docs
"""
from __future__ import annotations

import logging
import mimetypes
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from .api import community, finale, labs, learning, quantum, study
from .config import settings
from .database import init_db

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

# Baseline security headers (ArgosX hardening). Applied to every response.
# The CSP allow-list matches this app's real external origins (Google Fonts, jsDelivr/KaTeX/
# Monaco) and the Open-Meteo weather call, and keeps inline styles/scripts the SPA relies on.
_CSP = (
    "default-src 'self'; "
    "base-uri 'self'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; "
    "img-src 'self' data: blob: https:; "
    "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; "
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; "
    "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com https://cdn.jsdelivr.net; "
    "worker-src 'self' blob:; "
    "manifest-src 'self'"
)
_SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    # camera/geolocation off; microphone allowed for the Voice Mentor (same-origin only).
    "Permissions-Policy": "geolocation=(), camera=(), microphone=(self), payment=(), usb=()",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Cross-Origin-Opener-Policy": "same-origin",
}


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db(settings.database_url)
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="Q-3D Learn API",
        version=settings.version,
        description="AI-powered interactive learning platform with courses in Quantum Computing, Machine Learning, "
        "Data Science and AI: visual labs, simulations, lessons, challenges, an AI tutor and learning analytics.",
        lifespan=lifespan,
    )
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    if settings.security_headers:
        @app.middleware("http")
        async def security_headers(request: Request, call_next):
            resp = await call_next(request)
            for k, v in _SECURITY_HEADERS.items():
                resp.headers.setdefault(k, v)
            if settings.csp_enabled:
                resp.headers.setdefault("Content-Security-Policy", _CSP)
            return resp
    app.include_router(quantum.router)
    app.include_router(learning.router)
    app.include_router(community.router)
    app.include_router(labs.router)
    app.include_router(study.router)
    app.include_router(finale.router)

    @app.get("/api/health", tags=["system"])
    def health() -> dict:
        return {"status": "ok", "version": settings.version}

    def _base(request: Request) -> str:
        return settings.site_url or str(request.base_url).rstrip("/")

    @app.get("/robots.txt", include_in_schema=False)
    def robots(request: Request) -> PlainTextResponse:
        return PlainTextResponse(f"User-agent: *\nAllow: /\nSitemap: {_base(request)}/sitemap.xml\n")

    @app.get("/sitemap.xml", include_in_schema=False)
    def sitemap(request: Request) -> Response:
        base = _base(request)
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"  <url><loc>{base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n"
            "</urlset>\n"
        )
        return Response(content=body, media_type="application/xml")

    if settings.frontend_dir.exists():
        app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="frontend")
    return app


app = create_app()
