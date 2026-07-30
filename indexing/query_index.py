"""Query the Chroma index built by build_index.py.

Prints the top-k matching chunks with their source path, chunk index,
and a short preview. Useful for sanity-checking the indexer, and for
ad-hoc searches you don't want to wire through Kilo.

Usage
-----
    python query_index.py "how does the bloomberg relay start?"
    python query_index.py "stock price cache" --k 5
    python query_index.py "..." --path-glob "*.py"   # filter
"""

from __future__ import annotations

import argparse
import os
import sys
import textwrap
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import requests
import chromadb
from chromadb.config import Settings

DEFAULT_ROOT = Path(__file__).resolve().parent.parent


def embed_query(text: str, model: str, base_url: str) -> list[float]:
    r = requests.post(
        f"{base_url}/api/embeddings",
        json={"model": model, "prompt": text},
        timeout=60,
    )
    r.raise_for_status()
    return list(map(float, r.json()["embedding"]))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("query", help="natural-language search query")
    p.add_argument("-k", "--k", "--top-k", dest="k", type=int, default=5)
    p.add_argument("--path-glob", default=None,
                   help="optional substring filter on metadata.path")
    p.add_argument("--chroma-dir", default=os.environ.get("CHROMA_DIR",
                                                          str(DEFAULT_ROOT / ".chroma")))
    p.add_argument("--collection", default=os.environ.get("CHROMA_COLLECTION",
                                                          "papertrade"))
    p.add_argument("--model", default=os.environ.get("OLLAMA_EMBED_MODEL",
                                                     "nomic-embed-text"))
    p.add_argument("--ollama-url", default=os.environ.get("OLLAMA_BASE_URL",
                                                         "http://localhost:11434"))
    p.add_argument("--full", action="store_true",
                   help="print full chunk text instead of preview")
    args = p.parse_args()

    chroma = chromadb.PersistentClient(
        path=args.chroma_dir,
        settings=Settings(anonymized_telemetry=False, allow_reset=False),
    )
    col = chroma.get_collection(args.collection)

    qvec = embed_query(args.query, args.model, args.ollama_url)

    where = None
    if args.path_glob:
        where = {"path": {"$contains": args.path_glob}}

    res = col.query(
        query_embeddings=[qvec],
        n_results=args.k,
        where=where,
        include=["documents", "metadatas", "distances"],
    )

    docs = res.get("documents", [[]])[0]
    metas = res.get("metadatas", [[]])[0]
    dists = res.get("distances", [[]])[0]

    if not docs:
        print("(no results)")
        return 1

    print(f"\nTop {len(docs)} for: {args.query!r}\n")
    for i, (doc, meta, dist) in enumerate(zip(docs, metas, dists), 1):
        sim = 1.0 - dist   # cosine distance -> similarity
        path = meta.get("path", "?")
        chunk = meta.get("chunk", "?")
        print(f"[{i}] {path}  chunk {chunk}   cosine_sim={sim:.3f}")
        body = doc if args.full else textwrap.shorten(doc, width=240)
        print(textwrap.indent(body, "    "))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
