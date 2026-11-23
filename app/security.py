"""Password hashing for real login / signup — standard-library only (no external deps).

Uses PBKDF2-HMAC-SHA256 with a random per-user salt and a high iteration count, which is a
widely accepted way to store passwords when a library like bcrypt/argon2 isn't available.
Stored format:  pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re

_ALGO = "pbkdf2_sha256"
_ITERATIONS = 200_000
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITERATIONS)
    return f"{_ALGO}${_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algo, iters, salt_hex, hash_hex = stored.split("$")
        if algo != _ALGO:
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def valid_email(email: str) -> bool:
    return bool(_EMAIL_RE.match((email or "").strip()))


def password_problem(password: str) -> str | None:
    """Return a human message if the password is too weak, else None."""
    if len(password or "") < 8:
        return "Password must be at least 8 characters."
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        return "Password must include at least one letter and one number."
    return None
