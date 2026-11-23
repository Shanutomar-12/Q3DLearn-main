"""Tests for the Sarvam Voice Mentor and the Neo4j Brain Map knowledge graph.

Offline by design: no Sarvam key and no Neo4j server, so these verify the graceful
fallbacks (browser voice, in-memory graph) that make both features demo without setup.
"""
import os

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["AI_PROVIDER"] = "offline"

from app.ai import voice  # noqa: E402
from app.graph import brain  # noqa: E402


# ------------------------------------------------------------------ voice
def test_voice_status_offline_falls_back_to_browser():
    s = voice.status()
    assert s["sarvam"] is False
    assert s["provider"] == "browser"
    assert len(s["languages"]) == 11


def test_voice_tts_without_key_raises_unavailable():
    try:
        voice.tts("hello", "hi-IN")
        assert False, "expected VoiceUnavailable"
    except voice.VoiceUnavailable:
        pass


def test_voice_lang_normalisation():
    assert voice._norm_lang("hi") == "hi-IN"
    assert voice._norm_lang("ta-in") == "ta-IN"
    assert voice._norm_lang("zz") == "en-IN"
    assert voice._norm_lang(None) == "en-IN"


def test_decode_audio_handles_data_uri():
    import base64
    raw = b"RIFFfake"
    assert voice.decode_audio(base64.b64encode(raw).decode()) == raw
    assert voice.decode_audio("data:audio/wav;base64," + base64.b64encode(raw).decode()) == raw


# ------------------------------------------------------------------ brain graph
def test_graph_builds_in_memory():
    g = brain.graph("all")
    assert g["source"] == "memory"
    assert g["counts"]["courses"] == 8
    assert g["counts"]["labs"] >= 40
    assert g["counts"]["nodes"] > 200 and g["counts"]["edges"] > 200


def test_graph_edges_reference_existing_nodes():
    g = brain.graph("all")
    ids = {n["id"] for n in g["nodes"]}
    assert all(e["source"] in ids and e["target"] in ids for e in g["edges"])


def test_graph_course_filter_is_smaller():
    full = brain.graph("all")["counts"]["nodes"]
    one = brain.graph("quantum")["counts"]["nodes"]
    assert 0 < one < full


def test_lab_nodes_have_open_links():
    g = brain.graph("all")
    labs = [n for n in g["nodes"] if n["type"] == "lab"]
    assert labs and all(n.get("open", "").startswith("#/c/") for n in labs)


def test_neo4j_status_not_configured():
    st = brain.neo4j_status()
    assert st["configured"] is False and st["connected"] is False


def test_voice_brain_endpoints():
    # Local import so the pure-function tests run without FastAPI installed.
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as client:
        assert client.get("/api/voice/status").json()["provider"] == "browser"
        assert client.get("/api/brain/status").json()["configured"] is False
        g = client.get("/api/brain/graph?course=all").json()
        assert g["source"] == "memory" and g["counts"]["courses"] == 8
        # TTS with no Sarvam key -> 503, the signal the frontend uses to fall back
        assert client.post("/api/voice/tts", json={"text": "hi", "language": "hi-IN"}).status_code == 503


# ------------------------------------------------------------------ graph traversal (Navigator)
def test_related_returns_neighbours():
    r = brain.related("lab:dsa:sorting", 6)
    assert r["node"] and r["source"] == "memory"
    assert r["related"] and all({"id", "type", "label"} <= set(x) for x in r["related"])
    # lab neighbours should carry an open link
    for x in r["related"]:
        if x["type"] == "lab":
            assert x["open"].startswith("#/c/")


def test_related_unknown_node():
    r = brain.related("lab:nope:nope")
    assert r["node"] is None and r["related"] == []


def test_path_finds_cross_course_route():
    p = brain.path("lab:dsa:sorting", "lab:quantum:walk")
    assert p["found"] and p["hops"] >= 1
    assert p["path"][0]["id"] == "lab:dsa:sorting"
    assert p["path"][-1]["id"] == "lab:quantum:walk"


def test_path_unknown_node_is_graceful():
    p = brain.path("lab:dsa:sorting", "lab:zzz:zzz")
    assert p["found"] is False and p.get("error")


def test_insights_for_topic():
    ins = brain.insights_for_topic("sorting", "dsa", ["sorting"])
    assert "related_labs" in ins and "related_concepts" in ins
    assert all(l["type"] == "lab" for l in ins["related_labs"])
