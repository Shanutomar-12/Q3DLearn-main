"""Topic Visualizer — turn an instructor's PDF of a topic into a visual lesson.

Pipeline: PDF -> text -> a structured lesson (summary, key concepts, a quick quiz,
formulas) plus the best-matching interactive lab from the 37 we already have.

Two modes, automatic:
  * If an AI provider (OpenAI / Gemini) is configured, an LLM produces the lesson.
  * Otherwise a fully offline keyword engine does it — no network, no key needed.
The offline path is always the safe fallback if the LLM errors.
"""
from __future__ import annotations

import io
import json
import re
from collections import Counter

from ..courses import registry as R

_STOP = set("the a an and or of to in is are be for with on at by from as it its this that these those "
            "we you they he she i can will would uses use used using into their them then than which what "
            "how why when where who our your more most some any each other also such not no yes if else "
            "about over under between within across per via etc eg ie vs".split())
_FORMULA = re.compile(r"(\\[a-zA-Z]+|[=><±≤≥≈√∑∫π]|\^|_\{|\\frac|O\(|Σ|θ|λ|μ|σ|ψ|φ)")


class PdfReaderMissing(Exception):
    """pypdf isn't installed on the server — a clear signal instead of a 500."""


def extract_text(data: bytes) -> str:
    """Pull text out of a (text-based) PDF. Returns '' for scanned/image PDFs.

    Raises PdfReaderMissing if pypdf is not installed, so the API can tell the user
    exactly what to fix (`pip install -r requirements.txt`) instead of crashing."""
    try:
        from pypdf import PdfReader
    except ImportError as e:  # dependency not installed on this server
        raise PdfReaderMissing(str(e)) from e
    try:
        reader = PdfReader(io.BytesIO(data))
        return "\n".join((p.extract_text() or "") for p in reader.pages).strip()[:20000]
    except Exception:
        return ""


def lab_catalog() -> list[dict]:
    """Every interactive lab we can route a topic to, with keywords for matching."""
    out: list[dict] = []
    for cid in R.course_ids():
        m = R.module(cid)
        course = getattr(m, "COURSE", {}) if m else {}
        ctitle = course.get("title", cid)
        topics = " ".join(l.get("topic", "") for l in getattr(m, "LESSONS", []) if isinstance(l, dict))
        for lab in course.get("labs", []):
            out.append({
                "course": cid, "course_title": ctitle, "id": lab["id"], "title": lab["title"],
                "kw": f"{lab.get('title', '')} {ctitle} {cid} {topics}".lower(),
            })
    return out


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-zA-Z][a-zA-Z\-]{2,}", text.lower()) if w not in _STOP]


def _stem(w: str) -> str:
    """Tiny stemmer so word variants match together (sorting/sorted/sorts -> sort)."""
    w = w.lower()
    for suf, keep in (("ing", 4), ("ed", 4), ("es", 4), ("s", 4)):
        if w.endswith(suf) and len(w) - len(suf) >= keep - 1:
            return w[: -len(suf)]
    return w


def _stems(text: str) -> list[str]:
    return [_stem(w) for w in _words(text)]


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", text).strip())
    return [s.strip() for s in parts if len(s.strip()) > 20]


def match_lab(text: str, catalog: list[dict]) -> dict | None:
    """Score each lab by how strongly the topic's words point at it (term-frequency weighted).

    Frequency matters: a doc that says 'sorting' three times should beat a lab that merely
    shares the generic word 'algorithm' once. Title words count triple."""
    freq = Counter(_stems(text))
    if not freq:
        return None
    best, best_score = None, 0.0
    for lab in catalog:
        kw = set(_stems(lab["kw"]))
        title = set(_stems(lab["title"]))
        score = sum(freq[w] for w in kw if w in freq) + 3 * sum(freq[w] for w in title if w in freq)
        if score > best_score:
            best, best_score = lab, score
    return best if best_score >= 2 else None


def _good_sentences(text: str) -> list[str]:
    """Sentences that make decent question material (statements, not headings or junk)."""
    out = []
    for s in _sentences(text):
        w = s.split()
        if 6 <= len(w) <= 34 and sum(c.isalpha() for c in s) > len(s) * 0.6:
            out.append(s.rstrip(" .") + ".")
    return out


def _make_questions(text: str, concepts: list[str], lab: dict | None,
                    catalog: list[dict], target: int = 20) -> list[dict]:
    """Build up to `target` questions from the PDF with several strategies (offline, deterministic)."""
    import random
    rng = random.Random(len(text) + len(concepts))
    sents = _good_sentences(text)
    quiz: list[dict] = []
    seen: set[str] = set()
    pool = [c for c in concepts if len(c) > 3] or [w.title() for w, _ in Counter(_words(text)).most_common(12) if len(w) > 4]
    distract_pool = list({l["title"] for l in catalog} | set(pool))

    def add(q: dict):
        key = q["q"].lower()[:80]
        if key not in seen and q.get("options") and len(q["options"]) >= 2:
            seen.add(key)
            quiz.append(q)

    def distractors(answer: str, n: int = 3) -> list[str]:
        opts = [d for d in distract_pool if d.lower() != answer.lower()]
        rng.shuffle(opts)
        return opts[:n]

    # 1) which lab visualises this
    if lab:
        opts = distractors(lab["title"], 3) + [lab["title"]]
        rng.shuffle(opts)
        add({"q": "Which interactive lab best visualises this topic?", "options": opts,
             "answer": opts.index(lab["title"]),
             "explain": f"This topic maps to the {lab['title']} lab in the {lab['course_title']} course."})

    # 2) key-concept recognition (one per top concept)
    for c in pool[:6]:
        opts = distractors(c, 3) + [c]
        rng.shuffle(opts)
        add({"q": f"Which of these is a key concept in this topic?", "options": opts, "answer": opts.index(c),
             "explain": f"“{c}” is one of the most important terms in the uploaded material."})

    # 3) fill-in-the-blank from real sentences that contain a concept
    for s in sents:
        if len(quiz) >= target:
            break
        for c in pool:
            low = s.lower()
            if c.lower() in low and 0 < low.index(c.lower()):
                blanked = re.sub(re.escape(c), "_____", s, count=1, flags=re.IGNORECASE)
                opts = distractors(c, 3) + [c]
                rng.shuffle(opts)
                add({"q": f"Fill in the blank: {blanked}", "options": opts, "answer": opts.index(c),
                     "explain": f"The sentence from the material refers to “{c}”."})
                break

    # 4) True/False from declarative sentences
    for s in sents:
        if len(quiz) >= target:
            break
        if re.search(r"\b(is|are|was|were|has|have|can|uses|means|defines?|describes?)\b", s.lower()):
            add({"q": f"True or False — according to the material: “{s}”",
                 "options": ["True", "False"], "answer": 0,
                 "explain": "This statement is taken directly from the uploaded material."})

    # 5) definition match ("X is/means ...")
    for s in sents:
        if len(quiz) >= target:
            break
        m = re.match(r"\s*([A-Z][\w\- ]{2,40}?)\s+(?:is|are|means|refers to)\s+(.+)", s)
        if m:
            term = m.group(1).strip().title()
            opts = distractors(term, 3) + [term]
            rng.shuffle(opts)
            add({"q": f"Which term does this describe? “…{m.group(2).strip()[:90]}”",
                 "options": opts, "answer": opts.index(term),
                 "explain": f"The material defines {term}."})

    return quiz[:target]


def _make_project(title: str, concepts: list[str], lab: dict | None) -> dict:
    """A small hands-on project/task derived from the topic, for students to apply it."""
    focus = concepts[0] if concepts else (lab["title"] if lab else title)
    second = concepts[1] if len(concepts) > 1 else "the key idea"
    steps = [
        f"Explain {focus} in your own words (3–4 sentences) and why it matters.",
        (f"Open the {lab['title']} lab and run at least 3 experiments, noting what changes."
         if lab else f"Find or build a small example that demonstrates {focus} in action."),
        f"Connect {focus} to {second} — show how they relate with a diagram or short write-up.",
        "Write a 150-word reflection: one thing that surprised you and one question you still have.",
    ]
    return {
        "title": f"Mini-project: Apply {title}",
        "brief": (f"Put this topic into practice. You'll explore {focus}"
                  + (f" using the {lab['title']} lab" if lab else "")
                  + " and show you can apply it, not just recall it."),
        "steps": steps,
        "deliverable": "A short report (or slides) with your experiments, the diagram, and your reflection.",
    }


def offline_analyze(text: str, catalog: list[dict]) -> dict:
    sents = _sentences(text)
    summary = " ".join(sents[:3])[:480] if sents else "A topic uploaded by your instructor."
    freq = Counter(_words(text))
    concepts = [w.title() for w, _ in freq.most_common(10) if len(w) > 4][:8]
    formulas = [ln.strip() for ln in text.splitlines() if 3 < len(ln.strip()) < 120 and _FORMULA.search(ln)][:6]
    lab = match_lab(text, catalog)
    quiz = _make_questions(text, concepts, lab, catalog, target=20)
    project = _make_project((summary.split(".")[0][:60] or "this topic"), concepts, lab)
    return {"summary": summary, "key_concepts": concepts, "quiz": quiz, "formulas": formulas, "project": project,
            "course": lab["course"] if lab else None, "lab": lab["id"] if lab else None,
            "lab_title": lab["title"] if lab else None, "provider": "offline"}


def _llm_analyze(text: str, catalog: list[dict]) -> dict | None:
    """Ask the configured LLM for a structured lesson. Returns None on any problem."""
    from . import tutor
    provider = tutor.active_provider()
    if provider == "offline":
        return None
    labs = "; ".join(f"{l['id']} ({l['title']}, {l['course']})" for l in catalog)
    sys = ("You convert a teacher's topic notes into a rich visual lesson for students. "
           "Reply with ONLY compact JSON, no prose, with keys: "
           "summary (string, 3-5 sentences), "
           "key_concepts (array of 6-8 short strings), "
           "quiz (array of EXACTLY 20 questions, each {q, options:[4 strings], answer:int index, explain}; "
           "mix recall, true/false, fill-in-the-blank and application questions, all answerable from the notes), "
           "formulas (array of LaTeX strings, may be empty), "
           "project ({title, brief, steps:[4-5 strings], deliverable}) — a small hands-on task applying the topic, "
           "best_lab (one lab id from the list, or null).")
    user = f"Available labs: {labs}\n\nTOPIC NOTES:\n{text[:8000]}"
    try:
        raw = tutor._openai([{"role": "system", "content": sys}, {"role": "user", "content": user}]) \
            if provider == "openai" else \
            tutor._gemini([{"role": "system", "content": sys}, {"role": "user", "content": user}])
        raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
        data = json.loads(raw)
        lab_id = data.get("best_lab")
        lab = next((l for l in catalog if l["id"] == lab_id), None)
        quiz = [q for q in data.get("quiz", []) if isinstance(q, dict) and q.get("options")][:20]
        project = data.get("project") if isinstance(data.get("project"), dict) else {}
        result = {
            "summary": str(data.get("summary", ""))[:900],
            "key_concepts": [str(x)[:60] for x in data.get("key_concepts", [])][:8],
            "quiz": quiz,
            "formulas": [str(x)[:200] for x in data.get("formulas", [])][:8],
            "project": project,
            "course": lab["course"] if lab else None,
            "lab": lab["id"] if lab else None,
            "lab_title": lab["title"] if lab else None,
            "provider": provider,
        }
        # If the model under-delivered on questions, top up with offline ones so it's always ~20.
        if len(result["quiz"]) < 12:
            extra = _make_questions(text, result["key_concepts"], lab, catalog, target=20)
            have = {q["q"].lower()[:60] for q in result["quiz"]}
            result["quiz"] += [q for q in extra if q["q"].lower()[:60] not in have]
            result["quiz"] = result["quiz"][:20]
        if not result["project"]:
            result["project"] = _make_project(result["summary"].split(".")[0][:60] or "this topic",
                                               result["key_concepts"], lab)
        return result
    except Exception:
        return None


def analyze_topic(text: str) -> dict:
    """Produce the visual lesson: LLM when available, otherwise the offline engine."""
    catalog = lab_catalog()
    if not text.strip():
        return {"summary": "", "key_concepts": [], "quiz": [], "formulas": [], "project": {},
                "course": None, "lab": None, "lab_title": None, "provider": "none",
                "error": "No readable text found in the PDF (it may be scanned images)."}
    return _llm_analyze(text, catalog) or offline_analyze(text, catalog)
