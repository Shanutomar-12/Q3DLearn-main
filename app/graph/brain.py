"""The Brain Map knowledge graph — courses, lessons, labs and concepts as one connected graph.

Two sources, automatic:
  * **Neo4j** — when ``NEO4J_URI`` + ``NEO4J_PASSWORD`` are set and the ``neo4j`` driver is
    installed, the graph is stored in and queried from a real Neo4j database (Cypher / MERGE).
  * **In-memory** — otherwise the graph is built on the fly from the course registry, so the
    Knowledge Graph view works out of the box with no database to run.

The in-memory builder is also the single source of truth we *sync into* Neo4j, so both paths
return the exact same ``{nodes, edges}`` shape.
"""
from __future__ import annotations

import re

from ..config import settings
from ..courses import registry as R

# Node types and the relationships between them (also the Cypher labels / rel types in Neo4j).
NODE_COURSE, NODE_LESSON, NODE_LAB, NODE_CONCEPT = "course", "lesson", "lab", "concept"
REL_TEACHES, REL_HAS_LAB, REL_COVERS, REL_RELATED = "TEACHES", "HAS_LAB", "COVERS", "RELATED_TO"

_CNAME = {"quantum": "Quantum", "ml": "Machine Learning", "ds": "Data Science", "ai": "AI",
          "dsa": "DSA", "cyber": "Cybersecurity", "chain": "Blockchain", "dl": "Deep Learning"}


def _tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z][a-z\-]{3,}", (text or "").lower())}


# --------------------------------------------------------------------------- build (in-memory)
def build_graph(course: str = "all") -> dict:
    """Build the full knowledge graph from the registry. ``course`` filters to one course
    (its own nodes plus the cross-course concept links that reach it)."""
    ids = R.course_ids()
    want = set(ids) if course in ("all", "", None) else {course}

    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    concept_index: dict[str, list[tuple[str, str]]] = {}  # keyword -> [(concept_node_id, course)]

    def add(nid: str, ntype: str, label: str, cid: str, extra: dict | None = None) -> str:
        if nid not in nodes:
            color = (R.module(cid).COURSE.get("color") if R.module(cid) else None) or "#8b5cf6"
            nodes[nid] = {"id": nid, "type": ntype, "label": label, "course": cid, "color": color, **(extra or {})}
        return nid

    for cid in ids:
        m = R.module(cid)
        if not m:
            continue
        course_obj = getattr(m, "COURSE", {})
        ctitle = course_obj.get("title", _CNAME.get(cid, cid))
        cnode = add(f"course:{cid}", NODE_COURSE, ctitle, cid, {"short": course_obj.get("short", cid)})

        for lesson in getattr(m, "LESSONS", []):
            if not isinstance(lesson, dict):
                continue
            lnode = add(f"lesson:{cid}:{lesson['id']}", NODE_LESSON, lesson.get("title", lesson["id"]), cid,
                        {"topic": lesson.get("topic", ""), "level": lesson.get("level", "")})
            edges.append({"source": cnode, "target": lnode, "rel": REL_TEACHES})

        for lab in course_obj.get("labs", []):
            labnode = add(f"lab:{cid}:{lab['id']}", NODE_LAB, lab.get("title", lab["id"]), cid,
                          {"lab": lab["id"], "open": f"#/c/{cid}/lab/{lab['id']}"})
            edges.append({"source": cnode, "target": labnode, "rel": REL_HAS_LAB})

        for key, c in R.knowledge(cid).items():
            cnode_id = add(f"concept:{cid}:{key}", NODE_CONCEPT, key.replace("-", " ").title(), cid)
            # concept -> its lesson (and course -> concept)
            edges.append({"source": f"course:{cid}", "target": cnode_id, "rel": REL_COVERS})
            lesson_id = c.get("lesson")
            if lesson_id and f"lesson:{cid}:{lesson_id}" in nodes:
                edges.append({"source": cnode_id, "target": f"lesson:{cid}:{lesson_id}", "rel": REL_COVERS})
            for kw in c.get("keys", [key]):
                concept_index.setdefault(kw.lower(), []).append((cnode_id, cid))

    # cross-course concept links: same keyword surfacing in two different courses
    seen_pairs: set[tuple[str, str]] = set()
    for kw, refs in concept_index.items():
        courses_here = {cid for _, cid in refs}
        if len(courses_here) < 2:
            continue
        for i in range(len(refs)):
            for j in range(i + 1, len(refs)):
                a, ca = refs[i]
                b, cb = refs[j]
                if ca == cb:
                    continue
                pair = tuple(sorted((a, b)))
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                edges.append({"source": a, "target": b, "rel": REL_RELATED, "via": kw})

    # filter to the requested course (keep neighbours of kept nodes)
    if want != set(ids):
        keep = {nid for nid, n in nodes.items() if n["course"] in want}
        keep |= {e["target"] for e in edges if e["source"] in keep}
        keep |= {e["source"] for e in edges if e["target"] in keep}
        nodes = {nid: n for nid, n in nodes.items() if nid in keep}
        edges = [e for e in edges if e["source"] in nodes and e["target"] in nodes]

    node_list = list(nodes.values())
    return {
        "nodes": node_list,
        "edges": edges,
        "counts": {
            "nodes": len(node_list), "edges": len(edges),
            "courses": sum(1 for n in node_list if n["type"] == NODE_COURSE),
            "lessons": sum(1 for n in node_list if n["type"] == NODE_LESSON),
            "labs": sum(1 for n in node_list if n["type"] == NODE_LAB),
            "concepts": sum(1 for n in node_list if n["type"] == NODE_CONCEPT),
        },
    }


# --------------------------------------------------------------------------- Neo4j backing
def _driver():
    """Return a Neo4j driver, or None if not configured / driver not installed."""
    if not (settings.neo4j_uri and settings.neo4j_password):
        return None
    try:
        from neo4j import GraphDatabase
    except Exception:
        return None
    try:
        return GraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password))
    except Exception:
        return None


def neo4j_configured() -> bool:
    return bool(settings.neo4j_uri and settings.neo4j_password)


def neo4j_status() -> dict:
    """Is Neo4j reachable right now, and how many nodes does it hold?"""
    if not neo4j_configured():
        return {"configured": False, "connected": False, "nodes": 0}
    drv = _driver()
    if drv is None:
        return {"configured": True, "connected": False, "nodes": 0,
                "error": "neo4j driver not installed (pip install neo4j)"}
    try:
        with drv.session(database=settings.neo4j_database) as s:
            n = s.run("MATCH (n:Concept|Course|Lesson|Lab) RETURN count(n) AS n").single()["n"]
        return {"configured": True, "connected": True, "nodes": int(n)}
    except Exception as e:  # pragma: no cover - network path
        return {"configured": True, "connected": False, "nodes": 0, "error": str(e)[:200]}
    finally:
        try:
            drv.close()
        except Exception:
            pass


_LABEL = {NODE_COURSE: "Course", NODE_LESSON: "Lesson", NODE_LAB: "Lab", NODE_CONCEPT: "Concept"}


def sync_to_neo4j() -> dict:
    """Push the full registry graph into Neo4j (idempotent MERGE). Returns counts."""
    drv = _driver()
    if drv is None:
        raise RuntimeError("Neo4j is not configured or the driver is not installed")
    g = build_graph("all")
    try:
        with drv.session(database=settings.neo4j_database) as s:
            s.run("MATCH (n) WHERE n:Course OR n:Lesson OR n:Lab OR n:Concept DETACH DELETE n")
            for n in g["nodes"]:
                s.run(
                    f"MERGE (x:{_LABEL[n['type']]} {{id:$id}}) "
                    "SET x.label=$label, x.course=$course, x.color=$color",
                    id=n["id"], label=n["label"], course=n["course"], color=n["color"],
                )
            for e in g["edges"]:
                s.run(
                    "MATCH (a {id:$a}),(b {id:$b}) "
                    f"MERGE (a)-[r:{e['rel']}]->(b)",
                    a=e["source"], b=e["target"],
                )
        return {"synced": True, **g["counts"]}
    finally:
        try:
            drv.close()
        except Exception:
            pass


def _query_neo4j(course: str) -> dict | None:
    drv = _driver()
    if drv is None:
        return None
    try:
        with drv.session(database=settings.neo4j_database) as s:
            total = s.run("MATCH (n) WHERE n:Course OR n:Lesson OR n:Lab OR n:Concept RETURN count(n) AS n").single()["n"]
            if not total:
                return None
            where = "" if course in ("all", "", None) else "WHERE n.course=$course "
            nres = s.run(
                "MATCH (n) WHERE n:Course OR n:Lesson OR n:Lab OR n:Concept "
                + ("AND n.course=$course " if where else "")
                + "RETURN n.id AS id, labels(n)[0] AS lbl, n.label AS label, n.course AS course, n.color AS color",
                course=course,
            )
            nodes = []
            type_of = {v: k for k, v in _LABEL.items()}
            for r in nres:
                nodes.append({"id": r["id"], "type": type_of.get(r["lbl"], "concept"),
                              "label": r["label"], "course": r["course"], "color": r["color"]})
            ids = {n["id"] for n in nodes}
            eres = s.run(
                "MATCH (a)-[r]->(b) WHERE a.id IN $ids AND b.id IN $ids "
                "RETURN a.id AS source, b.id AS target, type(r) AS rel",
                ids=list(ids),
            )
            edges = [{"source": r["source"], "target": r["target"], "rel": r["rel"]} for r in eres]
        counts = {"nodes": len(nodes), "edges": len(edges),
                  "courses": sum(1 for n in nodes if n["type"] == NODE_COURSE),
                  "lessons": sum(1 for n in nodes if n["type"] == NODE_LESSON),
                  "labs": sum(1 for n in nodes if n["type"] == NODE_LAB),
                  "concepts": sum(1 for n in nodes if n["type"] == NODE_CONCEPT)}
        return {"nodes": nodes, "edges": edges, "counts": counts}
    except Exception:  # pragma: no cover - network path
        return None
    finally:
        try:
            drv.close()
        except Exception:
            pass


def graph(course: str = "all") -> dict:
    """The knowledge graph for the view: from Neo4j when it has data, otherwise in-memory."""
    if neo4j_configured():
        g = _query_neo4j(course)
        if g:
            return {**g, "source": "neo4j"}
    return {**build_graph(course), "source": "memory"}


# --------------------------------------------------------------------- traversal (the useful part)
# A graph is only worth having if you can walk it. These power the Learning Navigator:
# "what connects to this?" (related) and "how do I get from A to B?" (path). Both prefer Neo4j
# (Cypher variable-length + shortestPath) and fall back to an in-memory breadth-first search.

def _adjacency(g: dict) -> dict[str, list[tuple[str, str]]]:
    """Undirected adjacency list {node_id: [(neighbour_id, rel), ...]} from a built graph."""
    adj: dict[str, list[tuple[str, str]]] = {n["id"]: [] for n in g["nodes"]}
    for e in g["edges"]:
        adj.setdefault(e["source"], []).append((e["target"], e["rel"]))
        adj.setdefault(e["target"], []).append((e["source"], e["rel"]))
    return adj


def _node_map(g: dict) -> dict[str, dict]:
    return {n["id"]: n for n in g["nodes"]}


def _decorate(n: dict) -> dict:
    """Add an 'open' hash link to a lab node so the UI can jump straight into it."""
    out = {"id": n["id"], "type": n["type"], "label": n["label"], "course": n.get("course")}
    if n["type"] == NODE_LAB:
        lab_id = n["id"].split(":")[-1]
        out["open"] = f"#/c/{n.get('course')}/lab/{lab_id}"
    return out


def related(node_id: str, limit: int = 8) -> dict:
    """Neighbourhood of a node within 2 hops, nearest first, labs prioritised."""
    g = build_graph("all")
    nmap = _node_map(g)
    if node_id not in nmap:
        return {"node": None, "related": [], "source": "memory"}

    # Neo4j path first (shows off real graph traversal when it's connected).
    if neo4j_configured():
        drv = _driver()
        if drv is not None:
            try:
                with drv.session(database=settings.neo4j_database) as s:
                    rows = s.run(
                        "MATCH (a {id:$id})-[*1..2]-(m) WHERE m.id <> $id "
                        "RETURN DISTINCT m.id AS id, labels(m)[0] AS lbl, m.label AS label, m.course AS course "
                        "LIMIT $lim",
                        id=node_id, lim=limit * 2,
                    )
                    type_of = {v: k for k, v in _LABEL.items()}
                    items = [{"id": r["id"], "type": type_of.get(r["lbl"], "concept"),
                              "label": r["label"], "course": r["course"]} for r in rows]
                if items:
                    items = _rank_related(items, node_id)[:limit]
                    return {"node": _decorate(nmap[node_id]), "related": items, "source": "neo4j"}
            except Exception:
                pass
            finally:
                try:
                    drv.close()
                except Exception:
                    pass

    # In-memory BFS to depth 2.
    adj = _adjacency(g)
    seen = {node_id}
    frontier = [node_id]
    found: list[dict] = []
    for _ in range(2):
        nxt = []
        for cur in frontier:
            for nb, _rel in adj.get(cur, []):
                if nb in seen:
                    continue
                seen.add(nb)
                nxt.append(nb)
                if nb in nmap:
                    found.append({**_decorate(nmap[nb])})
        frontier = nxt
    found = _rank_related(found, node_id, nmap)[:limit]
    return {"node": _decorate(nmap[node_id]), "related": found, "source": "memory"}


_TYPE_RANK = {NODE_LAB: 0, NODE_CONCEPT: 1, NODE_LESSON: 2, NODE_COURSE: 3}


def _rank_related(items: list[dict], node_id: str, nmap: dict | None = None) -> list[dict]:
    src_course = node_id.split(":")[1] if node_id.count(":") >= 1 else None
    def key(it):
        same = 0 if it.get("course") == src_course else 1
        return (_TYPE_RANK.get(it["type"], 9), same, it["label"].lower())
    # ensure each item has an 'open' link for labs
    out = []
    for it in items:
        if it["type"] == NODE_LAB and "open" not in it:
            it = {**it, "open": f"#/c/{it.get('course')}/lab/{it['id'].split(':')[-1]}"}
        out.append(it)
    return sorted(out, key=key)


def path(from_id: str, to_id: str) -> dict:
    """Shortest learning path between two nodes (the quintessential graph query)."""
    g = build_graph("all")
    nmap = _node_map(g)
    if from_id not in nmap or to_id not in nmap:
        return {"path": [], "found": False, "source": "memory",
                "error": "One of the two topics was not found in the graph."}

    if neo4j_configured():
        drv = _driver()
        if drv is not None:
            try:
                with drv.session(database=settings.neo4j_database) as s:
                    rec = s.run(
                        "MATCH (a {id:$a}),(b {id:$b}), p = shortestPath((a)-[*..8]-(b)) "
                        "RETURN [n IN nodes(p) | n.id] AS ids",
                        a=from_id, b=to_id,
                    ).single()
                if rec and rec["ids"]:
                    steps = [_decorate(nmap[i]) for i in rec["ids"] if i in nmap]
                    return {"path": steps, "found": True, "source": "neo4j", "hops": len(steps) - 1}
            except Exception:
                pass
            finally:
                try:
                    drv.close()
                except Exception:
                    pass

    # In-memory BFS shortest path.
    adj = _adjacency(g)
    prev = {from_id: None}
    queue = [from_id]
    while queue:
        cur = queue.pop(0)
        if cur == to_id:
            break
        for nb, _rel in adj.get(cur, []):
            if nb not in prev:
                prev[nb] = cur
                queue.append(nb)
    if to_id not in prev:
        return {"path": [], "found": False, "source": "memory",
                "error": "No connection found between these two topics."}
    chain = []
    cur = to_id
    while cur is not None:
        chain.append(_decorate(nmap[cur]))
        cur = prev[cur]
    chain.reverse()
    return {"path": chain, "found": True, "source": "memory", "hops": len(chain) - 1}


def insights_for_topic(lab_id: str | None, course: str | None, concepts: list[str] | None) -> dict:
    """Graph-powered extras for a visualized topic: other labs to explore + related concepts."""
    out = {"related_labs": [], "related_concepts": [], "source": "memory"}
    if not lab_id or not course:
        return out
    node_id = f"lab:{course}:{lab_id}"
    rel = related(node_id, limit=16)
    out["source"] = rel.get("source", "memory")
    out["related_labs"] = [r for r in rel["related"] if r["type"] == NODE_LAB][:4]
    out["related_concepts"] = [r["label"] for r in rel["related"] if r["type"] == NODE_CONCEPT][:6]
    return out
