"""Tests for real auth (email+password) and the richer Topic Visualizer (20 Q + project)."""
import os

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["AI_PROVIDER"] = "offline"

from app import security  # noqa: E402
from app.ai import pdf_topic  # noqa: E402

LONG = ("Sorting algorithms arrange data in order. Bubble sort swaps adjacent elements. "
        "Merge sort is a divide and conquer algorithm that splits the array and merges sorted halves. "
        "Quicksort picks a pivot and partitions the array. Big-O notation describes how an algorithm scales. "
        "Time complexity measures operations. Merge sort has O(n log n) complexity. A stable sort preserves order. "
        "Comparison sorts compare pairs of elements. Recursion solves a problem using smaller subproblems.") * 2


def test_password_roundtrip_and_strength():
    h = security.hash_password("Secret123")
    assert h.startswith("pbkdf2_sha256$") and "Secret123" not in h
    assert security.verify_password("Secret123", h)
    assert not security.verify_password("wrong", h)
    assert security.password_problem("short")
    assert security.password_problem("letters") and security.password_problem("12345678")
    assert security.password_problem("Secret123") is None


def test_email_validation():
    assert security.valid_email("a@b.com") and not security.valid_email("nope")


def test_questions_and_project():
    cat = pdf_topic.lab_catalog()
    r = pdf_topic.offline_analyze(LONG, cat)
    assert len(r["quiz"]) >= 12, f"only {len(r['quiz'])} questions"
    assert all(0 <= q["answer"] < len(q["options"]) for q in r["quiz"])
    assert r["project"]["title"] and len(r["project"]["steps"]) >= 3
    assert r["course"] == "dsa"  # stemming keeps sorting -> DSA


def test_stemming_matches():
    cat = pdf_topic.lab_catalog()
    sortish = "Bubble sort and merge sort reorder data. A stable sort preserves order. Sorted output every sort."
    assert pdf_topic.offline_analyze(sortish, cat)["course"] == "dsa"


def test_auth_endpoints_signup_login():
    try:
        import sqlalchemy  # noqa: F401
    except Exception:
        return  # DB layer unavailable in this environment
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        r = c.post("/api/auth/signup", json={"name": "Teach", "email": "t@x.com", "password": "Secret123", "role": "instructor"})
        assert r.status_code == 200 and r.json()["role"] == "instructor" and "password" not in r.json()
        assert c.post("/api/auth/signup", json={"name": "T", "email": "t@x.com", "password": "Secret123"}).status_code == 409
        assert c.post("/api/auth/login", json={"email": "t@x.com", "password": "Secret123"}).status_code == 200
        assert c.post("/api/auth/login", json={"email": "t@x.com", "password": "nope"}).status_code == 401
        assert c.post("/api/auth/signup", json={"name": "W", "email": "w@x.com", "password": "weak"}).status_code == 422
