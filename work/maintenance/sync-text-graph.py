"""Finite local Graphify refresh: preserve semantic baseline, add literal Markdown layer.

Run with the interpreter recorded in graphify-out/.graphify_python. No network,
model, embeddings, semantic cache writes, source edits or background loop. Each
published file is replaced atomically; state.json is the completion marker for
the output set. A failed publication rolls back already replaced files.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

VERSION = 2
LAYER = "deterministic_markdown"
FOLDERS = {"00_System", "10_Projekte", "20_Wissen", "30_Entscheidungen", "40_Fehler-Loesungen"}
ROOT_FILES = {"AGENTS.md", "Willkommen.md"}
BRAIN_FOLDERS = {"inbox", "preferences", "pending", "retired"}
TERMS = {"TheHive", "Graphify", "OpenCode", "Codex", "qmd", "Brain", "Ollama", "Dream", "PreCompact", "SessionStart"}
LOCATION = re.compile(r"^L(\d+)(?:-L?(\d+))?$")


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic_bytes(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if path.stat().st_size == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError):
            yield False
            return
        try:
            yield True
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def local_name(value, root):
    value = str(value).replace("\\", "/")
    prefix = root.as_posix().rstrip("/") + "/"
    if value.casefold().startswith(prefix.casefold()):
        value = value[len(prefix):]
    if re.match(r"^[A-Za-z]:|^/", value) or ".." in Path(value).parts:
        return None
    return value


def scan(root):
    # Existing Graphify ignore parser, without Git subprocesses or global ignores.
    from graphify.detect import ignored_predicate
    ignored = ignored_predicate(root, gitignore=False)
    sources, skipped = {}, []
    candidates = [root / n for n in sorted(ROOT_FILES)]
    for folder in sorted(FOLDERS):
        base = root / folder
        if base.exists():
            candidates.extend(base.rglob("*.md"))
    candidates.append(root / "Brain/_BRAIN.md")
    for folder in sorted(BRAIN_FOLDERS):
        base = root / "Brain" / folder
        if base.exists():
            candidates.extend(base.rglob("*.md"))
    for path in sorted(set(candidates), key=lambda p: p.as_posix().casefold()):
        if not path.exists() or not path.is_file() or path.is_symlink():
            continue
        try:
            path.resolve().relative_to(root.resolve())
        except ValueError:
            continue
        relative = path.relative_to(root).as_posix()
        if ignored(path) or any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        raw = path.read_bytes()
        if len(raw) > 4 * 1024 * 1024:
            raise RuntimeError("Markdown source exceeds 4 MiB finite-run limit: " + relative)
        text = raw.decode("utf-8-sig")
        body = re.sub(r"\A---\s*\n.*?\n---\s*(?:\n|$)", "", text, count=1, flags=re.S)
        body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
        # Genuine Brain signals can store their entire principle in YAML.
        # An empty Markdown body is not an empty source in that case.
        signal_fields = relative.startswith("Brain/") and re.search(
            r"(?m)^(?:principle|topic|summary|lesson):[ \t]*\S", text)
        if not re.search(r"\w", body) and not signal_fields:
            skipped.append(relative)
            continue
        sources[relative] = {"sha256": digest(raw), "lines": text.splitlines(), "bytes": len(raw)}
    if not sources:
        raise RuntimeError("Empty permitted Markdown corpus; existing graph preserved")
    if len(sources) > 1000:
        raise RuntimeError("Corpus exceeds 1000-source finite-run limit")
    return sources, skipped


def baseline_archive(root, out, state, sources):
    existing = state.get("baseline_archive")
    if not existing and (out / "graph.json").exists():
        existing = read_json(out / "graph.json").get("graph", {}).get("thehive_refresh", {}).get("baseline_archive")
    if existing:
        archive = root / existing
        archive.resolve().relative_to((out / "archive").resolve())
        metadata = read_json(archive / "archive.json")
        for name, sha in metadata["artifacts"].items():
            if digest((archive / name).read_bytes()) != sha:
                raise RuntimeError("Historical baseline archive checksum mismatch: " + name)
        return archive, metadata
    graph_path = out / "graph.json"
    if not graph_path.exists():
        raise RuntimeError("Existing semantic graph required for initial archival")
    baseline = read_json(graph_path)
    if not baseline.get("nodes") or not isinstance(baseline.get("links"), list):
        raise RuntimeError("Malformed baseline; refusing refresh")
    graph_hash = digest(graph_path.read_bytes())
    archive = out / "archive" / ("semantic-baseline-" + graph_hash[:16])
    if archive.exists():
        metadata = read_json(archive / "archive.json")
        if metadata["graph_sha256"] != graph_hash:
            raise RuntimeError("Baseline archive collision")
        for name, sha in metadata["artifacts"].items():
            if digest((archive / name).read_bytes()) != sha:
                raise RuntimeError("Historical baseline archive checksum mismatch: " + name)
        return archive, metadata
    archive.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".semantic-baseline-", dir=archive.parent))
    artifacts, known_sources = {}, {}
    proof = root / "work/verification/graphify-build.json"
    try:
        # Exact existing artifacts, including semantic extraction/cache metadata.
        for path in sorted(out.iterdir()):
            if path.is_file():
                raw = path.read_bytes()
                (staging / path.name).write_bytes(raw)
                artifacts[path.name] = digest(raw)
        if proof.exists():
            raw = proof.read_bytes()
            (staging / "baseline-build-evidence.json").write_bytes(raw)
            artifacts["baseline-build-evidence.json"] = digest(raw)
            checked = json.loads(raw.decode("utf-8-sig"))
            # A proof for some other extraction is not a source binding.
            if checked.get("pass") and checked.get("nodes") == len(baseline["nodes"]) and checked.get("edges") == len(baseline["links"]):
                for entry in checked.get("sources", []):
                    name = local_name(entry.get("path", ""), root)
                    if name and re.fullmatch(r"[0-9a-fA-F]{64}", entry.get("sha256", "")):
                        known_sources[name] = entry["sha256"].lower()
        metadata = {"created_at": now(), "kind": "immutable_historical_semantic_baseline", "graph_sha256": graph_hash,
                    "nodes": len(baseline["nodes"]), "edges": len(baseline["links"]), "artifacts": artifacts,
                    "source_sha256": known_sources, "claim_scope": "Historical extraction; source equality does not independently verify semantic claims."}
        (staging / "archive.json").write_bytes(encode(metadata))
        (staging / "README.md").write_text("# Historische semantische Graphbasis\n\nOriginaldateien vor der ersten automatischen Aktualisierung. Alte Zeilenbelege gelten nur fuer den damaligen Quellenstand. Keine aktuelle semantische Extraktion oder unabhaengige Wahrheitspruefung. Pruefsummen: archive.json.\n", encoding="utf-8")
        os.replace(staging, archive)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return archive, metadata


def historical_layer(root, archive, metadata, sources):
    baseline = read_json(archive / "graph.json")
    nodes, edges = copy.deepcopy(baseline["nodes"]), copy.deepcopy(baseline["links"])
    statuses = {}
    for item in nodes + edges:
        name = local_name(item.get("source_file", ""), root)
        loc = item.get("source_location")
        match = LOCATION.fullmatch(loc or "")
        bound = name in sources and metadata["source_sha256"].get(name) == sources[name]["sha256"]
        bound = bound and bool(match) and 1 <= int(match[1]) <= int(match[2] or match[1]) <= len(sources[name]["lines"])
        item["layer"] = "historical_semantic"
        item["semantic_extraction_refreshed"] = False
        item["historical_source_file"] = item.get("source_file")
        item["historical_source_location"] = loc
        item["historical_source_sha256"] = metadata["source_sha256"].get(name)
        item["evidence_status"] = "source_unchanged" if bound else "historical_unverified"
        if not bound:
            item["source_location"] = None
            item.pop("additional_source_location", None)
        if "id" in item:
            statuses[item["id"]] = item["evidence_status"]
            if not bound:
                item["historical_label"] = item["label"]
                item["label"] = "[Historisch, Quellenbindung ungeprueft] " + item["label"]
    for edge in edges:
        if any(statuses.get(edge[k]) != "source_unchanged" for k in ("source", "target")):
            edge["evidence_status"] = "historical_unverified"
            edge["source_location"] = None
        if edge["evidence_status"] != "source_unchanged":
            edge["historical_relation"] = edge.get("relation")
            edge["relation"] = "historical_unverified__" + edge.get("relation", "related")
            edge["historical_confidence"] = edge.get("confidence")
            edge["historical_confidence_score"] = edge.get("confidence_score")
            edge["confidence"] = "AMBIGUOUS"
            edge["confidence_score"] = 0.0
    return nodes, edges, copy.deepcopy(baseline.get("hyperedges", []))


def markdown_layer(root, sources):
    nodes, edges, edge_index, docs, headings = [], [], {}, {}, {}
    def node(nid, label, name, line, kind, **extra):
        nodes.append({"id": nid, "label": label, "source_file": name, "source_location": f"L{line}",
                      "file_type": "document" if kind == "document" else "concept", "_origin": LAYER,
                      "layer": LAYER, "kind": kind, "evidence_status": "current_literal_syntax", **extra})
        return nid
    def edge(start, end, relation, name, line, text):
        if start == end:
            return
        key = (start, end, relation)
        evidence = {"source_file": name, "source_location": f"L{line}", "text": text.strip()}
        if key in edge_index:
            if evidence not in edge_index[key]["evidence"]:
                edge_index[key]["evidence"].append(evidence)
            return
        item = {"source": start, "target": end, "relation": relation, "source_file": name, "source_location": f"L{line}",
                "confidence": "EXTRACTED", "confidence_score": 1.0, "weight": 1.0, "_origin": LAYER,
                "layer": LAYER, "evidence_status": "current_literal_syntax", "evidence": [evidence]}
        edges.append(item)
        edge_index[key] = item
    def uid(*parts):
        return "markdown_" + digest("\0".join(map(str, parts)).encode("utf-8"))[:24]
    # Structural syntax excludes YAML front matter and fenced blocks.
    for name, source in sources.items():
        body, fence, front = [], None, False
        for number, text in enumerate(source["lines"], 1):
            if number == 1 and text.strip() == "---":
                front = True
                continue
            if front:
                if text.strip() in {"---", "..."}:
                    front = False
                continue
            marker = re.match(r"^\s{0,3}(`{3,}|~{3,})", text)
            if marker:
                token = marker[1]
                if fence is None:
                    fence = token
                elif token[0] == fence[0] and len(token) >= len(fence):
                    fence = None
                continue
            if fence is None:
                body.append((number, text))
        first = next(((n, t) for n, t in body if re.match(r"^#{1,6}\s+", t)), (1, Path(name).stem))
        title = re.sub(r"^#{1,6}\s+|\s+#+\s*$", "", first[1]).strip()
        docs[name] = node(uid(name, "document"), "[Dokument] " + title, name, first[0], "document", source_sha256=source["sha256"])
        source["body"] = body
        stack, context = [], []
        occurrences = Counter()
        for number, text in body:
            match = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", text)
            if match:
                level, title = len(match[1]), match[2]
                occurrences[title] += 1
                nid = node(uid(name, "heading", title, occurrences[title]), "[Ueberschrift] " + title, name, number, "heading", heading_level=level)
                while stack and stack[-1][0] >= level:
                    stack.pop()
                edge(stack[-1][1] if stack else docs[name], nid, "contains_heading", name, number, text)
                stack.append((level, nid))
                headings.setdefault((name, title.casefold()), []).append(nid)
            context.append((number, text, stack[-1][1] if stack else docs[name]))
        source["context"] = context
    names = {name.casefold(): name for name in sources}
    stems = defaultdict(list)
    for name in sources:
        stems[Path(name).stem.casefold()].append(name)
    named = set(TERMS)
    for source in sources.values():
        for _, text in source["body"]:
            for term in re.findall(r"`([^`\n]+)`", text):
                if 3 <= len(term) <= 80 and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", term) and ("-" in term or "_" in term) and not term.endswith(".md"):
                    named.add(term)
    patterns = [(term, re.compile(r"(?<![\w.-])" + re.escape(term) + r"(?![\w.-])", re.I)) for term in sorted(named, key=str.casefold)]
    terms = {}
    for name, source in sources.items():
        for number, text, context in source["context"]:
            # Resolve explicit Markdown/Wiki destinations only within allowed sources.
            destinations = re.findall(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]", text)
            destinations += re.findall(r"\]\(<?([^\s)>]+)>?(?:\s+\"[^\"]*\")?\)", text)
            normalized = text.replace("\\", "/")
            targets = {target for target in sources if target.casefold() in normalized.casefold()}
            for destination in destinations:
                destination = unquote(destination).split("|", 1)[0].replace("\\", "/")
                path, _, anchor = destination.partition("#")
                resolved = None
                if not path:
                    resolved = name
                elif not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", path):
                    for candidate in (path, str(Path(name).parent / path).replace("\\", "/"), path + ".md"):
                        normalized_path = os.path.normpath(candidate).replace("\\", "/")
                        if normalized_path.casefold() in names:
                            resolved = names[normalized_path.casefold()]
                            break
                    if resolved is None and len(stems.get(Path(path).stem.casefold(), [])) == 1:
                        resolved = stems[Path(path).stem.casefold()][0]
                if resolved:
                    target = docs[resolved]
                    if anchor and len(headings.get((resolved, anchor.casefold()), [])) == 1:
                        target = headings[(resolved, anchor.casefold())][0]
                    edge(context, target, "explicit_local_reference", name, number, text)
            for target in sorted(targets):
                edge(context, docs[target], "explicit_local_reference", name, number, text)
            for term, pattern in patterns:
                match = pattern.search(text)
                if match:
                    key = term.casefold()
                    if key not in terms:
                        terms[key] = node(uid("term", key), match[0], name, number, "literal_named_term", claim_scope="Literal mention only; no semantic equivalence or truth claim")
                    edge(context, terms[key], "literally_mentions", name, number, text)
    return nodes, edges


def publish(out, staged, maintenance, state):
    # Single-file atomic replacement; completion state last, rollback on exceptions.
    journal = maintenance / "text-graph-publication.json"
    rollback = Path(tempfile.mkdtemp(prefix=".graph-rollback-", dir=maintenance))
    replaced, remove_rollback = [], False
    try:
        for name in staged:
            old = out / name
            if old.exists():
                shutil.copy2(old, rollback / name)
        atomic_bytes(journal, encode({"phase": "publishing", "generation": state["fingerprint"], "rollback": str(rollback), "outputs": list(staged)}))
        for name, path in staged.items():
            os.replace(path, out / name)
            replaced.append(name)
        atomic_bytes(maintenance / "text-graph-state.json", encode(state))
        atomic_bytes(journal, encode({"phase": "complete", "generation": state["fingerprint"], "completed_at": now()}))
        remove_rollback = True
    except Exception:
        for name in reversed(replaced):
            previous = rollback / name
            if previous.exists():
                os.replace(previous, out / name)
            else:
                (out / name).unlink(missing_ok=True)
        atomic_bytes(journal, encode({"phase": "rolled_back", "generation": state["fingerprint"], "completed_at": now()}))
        remove_rollback = True
        raise
    finally:
        # Preserve rollback snapshots if a crash interrupted before this finally.
        if remove_rollback and rollback.exists():
            shutil.rmtree(rollback)


def run(root, html):
    from graphify.build import build_from_json
    from graphify.cluster import score_all
    from graphify.analyze import god_nodes
    from graphify.export import to_json, to_html
    from graphify.report import generate
    out, maintenance = root / "graphify-out", root / "work/maintenance"
    out.mkdir(parents=True, exist_ok=True)
    state_path = maintenance / "text-graph-state.json"
    state = read_json(state_path) if state_path.exists() else {}
    sources, omitted = scan(root)
    source_hashes = {name: info["sha256"] for name, info in sources.items()}
    fingerprint = digest(encode({"version": VERSION, "script": digest(Path(__file__).read_bytes()), "sources": source_hashes,
                                 "ignore": digest((root / ".graphifyignore").read_bytes()), "html": html}))
    expected = ["graph.json", "GRAPH_REPORT.md"] + (["graph.html"] if html else [])
    outputs_ok = all((out / name).exists() and state.get("output_sha256", {}).get(name) == digest((out / name).read_bytes()) for name in expected)
    journal = maintenance / "text-graph-publication.json"
    if journal.exists() and read_json(journal).get("phase") == "publishing":
        raise RuntimeError("Interrupted graph publication; inspect " + str(journal) + " and its retained rollback before retry")
    if state.get("fingerprint") == fingerprint and outputs_ok:
        return {"status": "unchanged", "fingerprint": fingerprint, "source_files": len(sources), "recorded_at": now()}
    archive, metadata = baseline_archive(root, out, state, sources)
    old_nodes, old_edges, hyperedges = historical_layer(root, archive, metadata, sources)
    new_nodes, new_edges = markdown_layer(root, sources)
    extraction = {"nodes": old_nodes + new_nodes, "edges": old_edges + new_edges, "hyperedges": hyperedges}
    ids = [node["id"] for node in extraction["nodes"]]
    if len(ids) != len(set(ids)):
        raise RuntimeError("Duplicate graph node identity")
    id_set = set(ids)
    if any(e["source"] not in id_set or e["target"] not in id_set or e["source"] == e["target"] for e in extraction["edges"]):
        raise RuntimeError("Graph endpoint integrity failure")
    # Occurrences and historical nodes already have distinct, evidence-bound IDs.
    graph = build_from_json(extraction, root=str(root), directed=False, dedup=False)
    if set(graph) != id_set:
        raise RuntimeError("Graphify merged or removed nodes; refusing silent information loss")
    if graph.number_of_nodes() > 20000 or len(extraction["edges"]) > 100000:
        raise RuntimeError("Projection exceeds finite-run node/edge limit; current outputs preserved")
    # Keep parallel literal evidence and semantic relations in JSON through the
    # export API's original_links path; simple in-memory analysis is advisory.
    communities, labels = {}, {}
    for node in extraction["nodes"]:
        if node.get("layer") == "historical_semantic":
            cid = int(node.get("community") or 0)
            label = "Semantische Basis: " + str(node.get("community_name") or cid)
        else:
            cid, label = 100, "Aktuelle Markdown-Syntax und explizite Begriffe"
        communities.setdefault(cid, []).append(node["id"])
        labels[cid] = label
    graph.graph["thehive_refresh"] = {"version": VERSION, "fingerprint": fingerprint, "generated_at": now(),
                                      "baseline_archive": archive.relative_to(root).as_posix(), "source_sha256": source_hashes,
                                      "semantic_extraction_refreshed": False, "current_layer": LAYER}
    words = sum(len(re.findall(r"\S+", "\n".join(source["lines"]))) for source in sources.values())
    detection = {"total_files": len(sources), "total_words": words,
                 "warning": f"Corpus is ~{words:,} words; this graph is a navigation projection, not an independent factual assessment."}
    report = generate(graph, communities, score_all(graph, communities), labels, god_nodes(graph), [], detection,
                      {"input": 0, "output": 0}, str(root), suggested_questions=[])
    report = re.sub(r"- Token cost:.*", "- Token cost: 0; dieser deterministische Python-Lauf ruft kein Modell auf. Historische Extraktionskosten bleiben unbekannt.", report)
    counts = Counter(e["evidence_status"] for e in old_edges)
    preface = ["# TheHive: semantische Basis und aktuelle Markdown-Projektion", "",
               f"Generation: `{fingerprint}`; erzeugt: {graph.graph['thehive_refresh']['generated_at']}", "",
               "## Geltungsbereich vor der Nutzung", "",
               f"- Semantische Basis vollstaendig erhalten: {len(old_nodes)} Knoten / {len(old_edges)} Beziehungen. Originalarchiv: `{archive.relative_to(root).as_posix()}`.",
               f"- Davon {counts['source_unchanged']} Beziehungen weiterhin an identische Quelldateien gebunden; {counts['historical_unverified']} Beziehungen historisch und aktuell ungeprueft.",
               f"- Neue aktuelle Schicht: {len(new_nodes)} Knoten / {len(new_edges)} syntaktische Beziehungen aus {len(sources)} nichtleeren Fachtexten.",
               "- Keine neue semantische Extraktion, kein Praeferenzlernen, keine Wahrheitseinstufung. Gleiche Quellbytes erhalten nur die damalige Quellenbindung; INFERRED bleibt INFERRED.",
               "- Geaenderte/fehlende semantische Quellen: Labelpraefix Historisch, relation=historical_unverified__*, confidence=AMBIGUOUS. Alte Zeilen nur unter historical_source_location; source_location ist dann leer.",
               "- Aktuelle EXTRACTED-Kanten bedeuten nur enthaelt Ueberschrift, nennt Begriff woertlich oder verweist explizit auf erlaubte lokale Quelle. Jede besitzt aktuelle Zeilen und Belegtext.",
               "- Gemeinschaften bewahren die historischen Labels; die aktuelle Schicht ist eine feste Navigationsgruppe. Kennzahlen betreffen beide Schichten und die einfache Analyseansicht; JSON erhaelt parallele Beziehungen.",
               f"- Einfache Analyse-/HTML-Ansicht: {graph.number_of_edges()} Kanten; vollstaendige JSON-Beziehungsliste: {len(extraction['edges'])}. Mehrere Beziehungen desselben Knotenpaars bleiben in JSON erhalten.",
               "- work/, Rohprotokolle, generierte Brain-Ansichten, synthetische Testnotizen und sonstige technische Bereiche sind ausgeschlossen. 00_System wird ausschliesslich gelesen.",
               "- Ein endlicher Lauf, bei identischem Quellfingerprint ohne Rewrite. Keine Modelle, Downloads, Netzabfragen, Dienste oder Quellaenderungen.", "",
               "## Aktuelle Quellen", ""]
    preface += [f"- `{name}`: {len(info['lines'])} Zeilen, SHA-256 `{info['sha256']}`" for name, info in sources.items()]
    if omitted:
        preface += ["", "Leere Notizen ausgelassen: " + ", ".join(omitted)]
    preface += ["", "## Graphify-Analyse beider gekennzeichneten Schichten", ""]
    report = "\n".join(preface) + "\n" + report
    with tempfile.TemporaryDirectory(prefix=".graph-stage-", dir=maintenance) as staging_name:
        staging = Path(staging_name)
        if not to_json(graph, communities, str(staging / "graph.json"), community_labels=labels, original_links=extraction["edges"]):
            raise RuntimeError("Graphify JSON export refused")
        (staging / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
        staged = {name: staging / name for name in expected}
        if html and (graph.number_of_nodes() > 5000 or not to_html(graph, communities, str(staging / "graph.html"), community_labels=labels)):
            raise RuntimeError("HTML export refused; current outputs preserved")
        # Do not publish a snapshot whose sources changed during this finite run.
        checked, _ = scan(root)
        if {name: info["sha256"] for name, info in checked.items()} != source_hashes:
            raise RuntimeError("Source changed during refresh; current outputs preserved, next run retries")
        state = {"version": VERSION, "status": "updated", "recorded_at": now(), "fingerprint": fingerprint,
                 "baseline_archive": archive.relative_to(root).as_posix(), "source_sha256": source_hashes,
                 "historical_nodes": len(old_nodes), "historical_edges": len(old_edges), "historical_edge_status": dict(counts),
                 "current_nodes": len(new_nodes), "current_edges": len(new_edges), "total_nodes": graph.number_of_nodes(),
                 "total_edges": len(extraction["edges"]), "source_files": len(sources), "empty_omitted": omitted,
                 "output_sha256": {name: digest(path.read_bytes()) for name, path in staged.items()},
                 "model_invoked": False, "semantic_extraction_refreshed": False}
        publish(out, staged, maintenance, state)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--html", action="store_true", help="Also refresh existing Graphify HTML (no network fetch during generation)")
    args = parser.parse_args()
    root = args.root.resolve()
    maintenance = root / "work/maintenance"
    with lock(maintenance / "text-graph.lock") as acquired:
        if not acquired:
            print(json.dumps({"status": "busy", "recorded_at": now()}))
            return 0
        try:
            result = run(root, args.html)
            atomic_bytes(maintenance / "text-graph-last-run.json", encode(result))
            with (maintenance / "text-graph-runs.jsonl").open("a", encoding="utf-8") as log:
                log.write(json.dumps({k: result.get(k) for k in ("recorded_at", "status", "fingerprint", "source_files", "total_nodes", "total_edges")}, ensure_ascii=False) + "\n")
            print(json.dumps({k: result.get(k) for k in ("status", "fingerprint", "source_files", "total_nodes", "total_edges")}, ensure_ascii=False))
            return 0
        except Exception as error:
            failure = {"recorded_at": now(), "status": "failed", "error": str(error), "model_invoked": False}
            atomic_bytes(maintenance / "text-graph-last-run.json", encode(failure))
            print(json.dumps(failure, ensure_ascii=False), file=sys.stderr)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
