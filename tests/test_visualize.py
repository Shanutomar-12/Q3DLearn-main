"""Tests for the Topic Visualizer (PDF -> visual lesson + matched lab)."""
import os

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["AI_PROVIDER"] = "offline"

from app.ai import pdf_topic  # noqa: E402


def test_lab_catalog_has_labs():
    cat = pdf_topic.lab_catalog()
    assert len(cat) > 20
    assert all({"course", "id", "title", "kw"} <= set(lab) for lab in cat)


def test_offline_matches_sorting():
    cat = pdf_topic.lab_catalog()
    text = ("Bubble sort and merge sort are sorting algorithms. Big-O notation describes how an "
            "algorithm scales. Quicksort is a divide and conquer sorting method with O(n log n) time.")
    r = pdf_topic.offline_analyze(text, cat)
    assert r["lab"] == "sorting" and r["course"] == "dsa"
    assert r["summary"] and r["key_concepts"]
    assert r["quiz"] and r["quiz"][0]["answer"] in range(len(r["quiz"][0]["options"]))


def test_offline_matches_quantum():
    cat = pdf_topic.lab_catalog()
    text = "A qubit in superposition is shown on the Bloch sphere. A Hadamard gate creates superposition."
    r = pdf_topic.offline_analyze(text, cat)
    assert r["course"] == "quantum"


def test_analyze_empty_text():
    r = pdf_topic.analyze_topic("")
    assert r["lab"] is None and r.get("error")


def test_visualize_endpoints_list_empty():
    # TestClient import kept local so the pure-function tests above run without FastAPI installed.
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as client:
        assert client.get("/api/visualize").json() == []
