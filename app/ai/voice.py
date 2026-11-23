"""Sarvam Voice Mentor — speech-to-text, text-to-speech and translation for Indic languages.

The Voice Mentor lets a learner *speak* a question in their own language and *hear* Q-Bot's
answer read back. The actual answer still comes from the grounded AI tutor (``tutor.ask``);
this module only handles the voice layer around it.

Design (matches the rest of the project):
  * Everything reads the Sarvam key from the environment only — never hard-coded.
  * With no key configured, these functions raise ``VoiceUnavailable``. The frontend catches
    that and falls back to the browser's built-in Web Speech API, so the feature still works.
  * One tiny HTTP helper (urllib, like tutor.py) — no extra dependencies.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import urllib.error
import urllib.request
import uuid

from ..config import settings

# The 11 languages Sarvam supports, shown in the Voice Mentor language picker.
LANGUAGES: list[dict] = [
    {"code": "en-IN", "name": "English"},
    {"code": "hi-IN", "name": "हिन्दी (Hindi)"},
    {"code": "bn-IN", "name": "বাংলা (Bengali)"},
    {"code": "ta-IN", "name": "தமிழ் (Tamil)"},
    {"code": "te-IN", "name": "తెలుగు (Telugu)"},
    {"code": "kn-IN", "name": "ಕನ್ನಡ (Kannada)"},
    {"code": "ml-IN", "name": "മലയാളം (Malayalam)"},
    {"code": "mr-IN", "name": "मराठी (Marathi)"},
    {"code": "gu-IN", "name": "ગુજરાતી (Gujarati)"},
    {"code": "pa-IN", "name": "ਪੰਜਾਬੀ (Punjabi)"},
    {"code": "od-IN", "name": "ଓଡ଼ିଆ (Odia)"},
]
_LANG_CODES = {l["code"] for l in LANGUAGES}


class VoiceUnavailable(Exception):
    """Raised when Sarvam is not configured or the request fails — callers fall back to the browser."""


def configured() -> bool:
    return bool(settings.sarvam_api_key)


def status() -> dict:
    return {
        "sarvam": configured(),
        "provider": "sarvam" if configured() else "browser",
        "languages": LANGUAGES,
        "tts_model": settings.sarvam_tts_model,
        "stt_model": settings.sarvam_stt_model,
    }


def _norm_lang(code: str | None) -> str:
    if not code:
        return "en-IN"
    code = code.strip()
    if code in _LANG_CODES:
        return code
    # accept bare codes like "hi" or "hi-in"
    base = code.split("-")[0].lower()
    for c in _LANG_CODES:
        if c.lower().startswith(base + "-"):
            return c
    return "en-IN"


def _post(path: str, payload: dict | None = None, *, files: dict | None = None, data: dict | None = None) -> dict:
    """POST to Sarvam. JSON body when ``payload`` is given, else multipart (``files`` + ``data``)."""
    if not configured():
        raise VoiceUnavailable("Sarvam API key is not configured")
    url = settings.sarvam_base_url.rstrip("/") + path
    headers = {"api-subscription-key": settings.sarvam_api_key}
    if payload is not None:
        body = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    else:
        boundary = uuid.uuid4().hex
        body = _multipart(boundary, data or {}, files or {})
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=settings.ai_timeout) as resp:  # noqa: S310 - fixed https endpoint
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:  # pragma: no cover - network path
        detail = e.read().decode(errors="ignore")[:300]
        raise VoiceUnavailable(f"Sarvam error {e.code}: {detail}") from e
    except Exception as e:  # pragma: no cover - network path
        raise VoiceUnavailable(f"Sarvam request failed: {e}") from e


def _multipart(boundary: str, fields: dict, files: dict) -> bytes:
    out = bytearray()
    for name, value in fields.items():
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        out += f"{value}\r\n".encode()
    for name, (filename, content) in files.items():
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        out += f"Content-Type: {ctype}\r\n\r\n".encode()
        out += content + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out)


def tts(text: str, language: str = "en-IN") -> dict:
    """Text -> speech. Returns {audio: base64 wav, provider, language}."""
    text = (text or "").strip()[:1500]
    if not text:
        raise VoiceUnavailable("Nothing to speak")
    data = _post("/text-to-speech", {
        "text": text,
        "target_language_code": _norm_lang(language),
        "model": settings.sarvam_tts_model,
        "speaker": settings.sarvam_tts_speaker,
        "enable_preprocessing": True,
    })
    audios = data.get("audios") or []
    if not audios:
        raise VoiceUnavailable("Sarvam returned no audio")
    return {"audio": audios[0], "mime": "audio/wav", "provider": "sarvam", "language": _norm_lang(language)}


def stt(audio_bytes: bytes, filename: str = "speech.wav", language: str | None = None) -> dict:
    """Speech -> text. Returns {text, language, provider}."""
    if not audio_bytes:
        raise VoiceUnavailable("No audio provided")
    fields = {"model": settings.sarvam_stt_model}
    if language:
        fields["language_code"] = _norm_lang(language)
    data = _post("/speech-to-text", files={"file": (filename, audio_bytes)}, data=fields)
    return {
        "text": (data.get("transcript") or "").strip(),
        "language": data.get("language_code") or language or "en-IN",
        "provider": "sarvam",
    }


def translate(text: str, source: str = "auto", target: str = "en-IN") -> dict:
    """Translate between Indic languages and English. Returns {text, provider}."""
    text = (text or "").strip()[:2000]
    if not text:
        return {"text": "", "provider": "sarvam"}
    data = _post("/translate", {
        "input": text,
        "source_language_code": "auto" if source in ("auto", "", None) else _norm_lang(source),
        "target_language_code": _norm_lang(target),
        "mode": "formal",
    })
    return {"text": (data.get("translated_text") or "").strip(), "provider": "sarvam"}


def decode_audio(audio_b64: str) -> bytes:
    """Decode a base64 audio payload (handles optional data: URI prefix)."""
    if "," in audio_b64 and audio_b64.strip().startswith("data:"):
        audio_b64 = audio_b64.split(",", 1)[1]
    return base64.b64decode(audio_b64)
