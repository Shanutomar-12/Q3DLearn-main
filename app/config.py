"""Runtime configuration from environment variables (optionally loaded from a .env file)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent

try:  # python-dotenv is optional
    from dotenv import load_dotenv

    load_dotenv(ROOT_DIR / ".env")
except ImportError:  # pragma: no cover
    pass


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


@dataclass
class Settings:
    app_name: str = "Q-3D Learn"
    version: str = "2.6.4"
    database_url: str = field(default_factory=lambda: _env("DATABASE_URL", f"sqlite:///{ROOT_DIR / 'q3d_learn.db'}"))
    frontend_dir: Path = field(default_factory=lambda: Path(_env("Q3D_FRONTEND_DIR", str(ROOT_DIR / "frontend"))))
    cors_origins: list[str] = field(default_factory=lambda: [o for o in _env("CORS_ORIGINS", "*").split(",") if o])

    # Quantum backend: auto = use Qiskit Aer when installed, otherwise the built-in engine.
    quantum_backend: str = field(default_factory=lambda: _env("QUANTUM_BACKEND", "auto"))

    # AI tutor: auto = OpenAI if OPENAI_API_KEY, else Gemini if GEMINI_API_KEY, else offline tutor.
    ai_provider: str = field(default_factory=lambda: _env("AI_PROVIDER", "auto"))
    openai_api_key: str = field(default_factory=lambda: _env("OPENAI_API_KEY"))
    openai_model: str = field(default_factory=lambda: _env("OPENAI_MODEL", "gpt-4o-mini"))
    # Any OpenAI-compatible server works (e.g. Ollama: http://localhost:11434/v1).
    openai_base_url: str = field(default_factory=lambda: _env("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    gemini_api_key: str = field(default_factory=lambda: _env("GEMINI_API_KEY"))
    gemini_model: str = field(default_factory=lambda: _env("GEMINI_MODEL", "gemini-2.5-flash"))
    ai_timeout: float = field(default_factory=lambda: float(_env("AI_TIMEOUT", "30")))
    # Optional key for the project's AI bot / voice provider (e.g. Sarvam). Read from the
    # environment only — never hard-code secrets. Kept config-ready for future wiring.
    ai_bot_api_key: str = field(default_factory=lambda: _env("AI_BOT_API_KEY"))

    # Sarvam Voice Mentor: speech-to-text, text-to-speech and translation for Indian
    # languages. With no key the frontend falls back to the browser's Web Speech API,
    # so the Voice Mentor still works — just without Sarvam's Indic-language quality.
    sarvam_api_key: str = field(default_factory=lambda: _env("SARVAM_API_KEY") or _env("AI_BOT_API_KEY"))
    sarvam_base_url: str = field(default_factory=lambda: _env("SARVAM_BASE_URL", "https://api.sarvam.ai"))
    sarvam_tts_model: str = field(default_factory=lambda: _env("SARVAM_TTS_MODEL", "bulbul:v2"))
    sarvam_tts_speaker: str = field(default_factory=lambda: _env("SARVAM_TTS_SPEAKER", "anushka"))
    sarvam_stt_model: str = field(default_factory=lambda: _env("SARVAM_STT_MODEL", "saarika:v2.5"))

    # Neo4j knowledge graph (Brain Map). With no URI the graph is built in-memory from the
    # course registry, so the Knowledge Graph view works out of the box; set these to persist
    # and query the graph in a real Neo4j database (Aura or self-hosted).
    neo4j_uri: str = field(default_factory=lambda: _env("NEO4J_URI"))
    neo4j_user: str = field(default_factory=lambda: _env("NEO4J_USER", "neo4j"))
    neo4j_password: str = field(default_factory=lambda: _env("NEO4J_PASSWORD"))
    neo4j_database: str = field(default_factory=lambda: _env("NEO4J_DATABASE", "neo4j"))

    # Security headers (ArgosX hardening). All on by default. Set the public URL for correct
    # canonical / sitemap links; leave blank to derive it from the incoming request.
    site_url: str = field(default_factory=lambda: _env("SITE_URL").rstrip("/"))
    security_headers: bool = field(default_factory=lambda: _env("SECURITY_HEADERS", "on").lower() not in ("0", "off", "false"))
    # Content-Security-Policy is powerful but strict — a wrong policy can block your own scripts.
    # On by default with a policy matched to this app's CDNs; set SECURITY_CSP=off to disable only the CSP.
    csp_enabled: bool = field(default_factory=lambda: _env("SECURITY_CSP", "on").lower() not in ("0", "off", "false"))


settings = Settings()
