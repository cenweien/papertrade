"""ChromaDB indexer for the papertrade repo.

Embeds source files with Nomic Embed Text (via Ollama) and writes the
resulting vectors into a persistent Chroma collection. Kilo Code's
"indexing" provider is OpenAI-compatible, and Ollama's /v1/embeddings
endpoint is exactly that -- so this script is the offline / batch
counterpart: it pre-computes a Chroma store that you can either point
Kilo at (via its chroma provider) or query yourself.

Usage
-----
    # 1. Make sure Ollama is running and the model is pulled
    ollama pull nomic-embed-text

    # 2. Index the repo (defaults: ../  ->  ./.chroma/)
    python build_index.py

    # 3. Inspect / query
    python query_index.py "how does the bloomberg relay start?"

Env vars (all optional, with sensible defaults)
    OLLAMA_BASE_URL      default http://localhost:11434
    OLLAMA_EMBED_MODEL   default nomic-embed-text
    CHROMA_DIR           default ./.chroma
    CHROMA_COLLECTION    default papertrade
    ROOT_DIR             default parent of this file
"""

from __future__ import annotations

import os
import sys
import time
import hashlib
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import requests
import chromadb
from chromadb.config import Settings

LOG = logging.getLogger("indexer")

# ---------- configuration --------------------------------------------------- #

ROOT_DIR = Path(os.environ.get("ROOT_DIR", Path(__file__).resolve().parent.parent))
CHROMA_DIR = Path(os.environ.get("CHROMA_DIR", ROOT_DIR / ".chroma"))
COLLECTION_NAME = os.environ.get("CHROMA_COLLECTION", "papertrade")
OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
EMBED_WORKERS = int(os.environ.get("EMBED_WORKERS", "4"))

# Files we will *never* embed.
SKIP_DIRS = {
    ".git", ".next", "node_modules", ".venv", ".venv-bb", ".venv-index",
    "venv", "env",
    "__pycache__", "dist", "build", ".chroma", ".vercel", ".kilo",
    "xbbg_sapi_extracted", "xbbg_sapi-1.0.0.dist-info",
    "site-packages",  # any pip-installed venv
}
SKIP_EXTS = {
    ".pyc", ".pyd", ".so", ".dll", ".exe", ".bin", ".zip", ".tar",
    ".gz", ".7z", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".ico", ".mp4", ".mp3", ".wav", ".woff", ".woff2", ".ttf",
    ".map", ".lock", ".whl",
}
# Files we *do* want, even if small.
TEXT_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".md", ".mdx", ".txt", ".rst",
    ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".env",
    ".html", ".css", ".scss", ".sql",
    ".sh", ".ps1", ".bat", ".cmd",
    ".go", ".rs", ".java", ".kt", ".c", ".cpp", ".h", ".hpp",
    ".rb", ".php", ".swift", ".dart",
}
MAX_FILE_BYTES = 1_000_000   # 1 MB hard cap per file
CHUNK_CHARS = 2_000          # ~512 tokens, safe for nomic-embed-text
CHUNK_OVERLAP = 200

# ---------- ollama embeddings client --------------------------------------- #


@dataclass
class EmbeddingClient:
    base_url: str
    model: str
    session: requests.Session

    @classmethod
    def default(cls) -> "EmbeddingClient":
        s = requests.Session()
        return cls(OLLAMA_URL, EMBED_MODEL, s)

    def healthcheck(self) -> None:
        r = self.session.get(f"{self.base_url}/api/tags", timeout=10)
        r.raise_for_status()
        names = {m["name"] for m in r.json().get("models", [])}
        if not any(n.startswith(self.model) for n in names):
            raise RuntimeError(
                f"Model '{self.model}' not in Ollama. "
                f"Run:  ollama pull {self.model}"
            )

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed N texts. Ollama's /api/embeddings only accepts a single
        `prompt`, not a batch `input` — we fan out in a thread pool."""
        if not texts:
            return []
        out: list[list[float] | None] = [None] * len(texts)

        def one(i: int, t: str) -> tuple[int, list[float]]:
            r = self.session.post(
                f"{self.base_url}/api/embeddings",
                json={"model": self.model, "prompt": t},
                timeout=120,
            )
            r.raise_for_status()
            data = r.json()
            vec = data.get("embedding") or data.get("embeddings")
            if vec is None or (isinstance(vec, list) and len(vec) == 0):
                raise RuntimeError(
                    f"Ollama returned no embedding for text #{i} "
                    f"(len={len(t)}): {data!r}"
                )
            # Flatten if Ollama returns [[...]] (older shape) for single prompt.
            if isinstance(vec[0], list):
                vec = vec[0]
            return i, list(map(float, vec))

        with ThreadPoolExecutor(max_workers=EMBED_WORKERS) as pool:
            futures = [pool.submit(one, i, t) for i, t in enumerate(texts)]
            for fut in as_completed(futures):
                i, vec = fut.result()
                out[i] = vec

        missing = [i for i, v in enumerate(out) if v is None]
        if missing:
            raise RuntimeError(f"Missing embeddings for indices {missing}")
        return out  # type: ignore[return-value]


# ---------- file walking + chunking ---------------------------------------- #


def _should_skip_dir(name: str) -> bool:
    if name in SKIP_DIRS:
        return True
    if name.startswith(".venv") or name.startswith("venv"):
        return True
    return False


def iter_files(root: Path) -> Iterable[Path]:
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if any(_should_skip_dir(part) for part in p.parts):
            continue
        if p.suffix.lower() in SKIP_EXTS:
            continue
        if p.suffix.lower() not in TEXT_EXTS:
            continue
        try:
            if p.stat().st_size > MAX_FILE_BYTES:
                LOG.debug("skip large: %s", p)
                continue
        except OSError:
            continue
        yield p


def chunk_text(text: str) -> list[str]:
    text = text.replace("\r\n", "\n").strip()
    if not text:
        return []
    if len(text) <= CHUNK_CHARS:
        return [text]
    out: list[str] = []
    step = CHUNK_CHARS - CHUNK_OVERLAP
    for i in range(0, len(text), step):
        piece = text[i : i + CHUNK_CHARS].strip()
        if piece:
            out.append(piece)
        if i + CHUNK_CHARS >= len(text):
            break
    return out


def stable_id(path: Path, chunk_index: int, content: str) -> str:
    h = hashlib.sha1()
    h.update(str(path.relative_to(ROOT_DIR)).encode("utf-8", "replace"))
    h.update(b"\x00")
    h.update(str(chunk_index).encode("ascii"))
    h.update(b"\x00")
    h.update(content.encode("utf-8", "replace"))
    return h.hexdigest()


# ---------- main pipeline -------------------------------------------------- #


def build() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)-5s %(message)s",
    )

    LOG.info("Root      : %s", ROOT_DIR)
    LOG.info("Chroma dir: %s", CHROMA_DIR)
    LOG.info("Model     : %s @ %s", EMBED_MODEL, OLLAMA_URL)

    client = EmbeddingClient.default()
    client.healthcheck()
    LOG.info("Ollama OK, model present")

    CHROMA_DIR.mkdir(parents=True, exist_ok=True)
    chroma = chromadb.PersistentClient(
        path=str(CHROMA_DIR),
        settings=Settings(anonymized_telemetry=False, allow_reset=True),
    )
    # Recreate cleanly so re-runs are deterministic.
    try:
        chroma.delete_collection(COLLECTION_NAME)
    except Exception:
        pass
    col = chroma.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )

    files = list(iter_files(ROOT_DIR))
    LOG.info("Found %d indexable files", len(files))

    BATCH = 16   # chunks per upsert; embed calls are parallel within
    buf_docs: list[str] = []
    buf_meta: list[dict] = []
    buf_ids: list[str] = []
    total_chunks = 0
    t0 = time.time()

    def flush() -> None:
        nonlocal buf_docs, buf_meta, buf_ids, total_chunks
        if not buf_docs:
            return
        # Defensive: drop any chunks that ended up empty (shouldn't happen,
        # but an empty doc would yield a zero-vector and Chroma will reject it).
        keep = [i for i, d in enumerate(buf_docs) if d and d.strip()]
        if len(keep) != len(buf_docs):
            LOG.warning("dropping %d empty chunks before embed",
                        len(buf_docs) - len(keep))
            buf_docs  = [buf_docs[i]  for i in keep]
            buf_meta  = [buf_meta[i]  for i in keep]
            buf_ids   = [buf_ids[i]   for i in keep]
        if not buf_docs:
            return
        embeddings = client.embed(buf_docs)
        if not embeddings or len(embeddings) != len(buf_docs):
            raise RuntimeError(
                f"Ollama returned {len(embeddings) if embeddings else 0} "
                f"embeddings for {len(buf_docs)} inputs (batch aborted)"
            )
        col.upsert(
            ids=buf_ids,
            documents=buf_docs,
            embeddings=embeddings,
            metadatas=buf_meta,
        )
        total_chunks += len(buf_docs)
        LOG.info("  upserted %d chunks (running total: %d)",
                 len(buf_docs), total_chunks)
        buf_docs, buf_meta, buf_ids = [], [], []

    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            LOG.warning("read failed %s: %s", path, e)
            continue
        chunks = chunk_text(text)
        rel = str(path.relative_to(ROOT_DIR))
        for i, chunk in enumerate(chunks):
            buf_docs.append(chunk)
            buf_meta.append({
                "path": rel,
                "chunk": i,
                "ext": path.suffix.lower(),
                "size": len(chunk),
            })
            buf_ids.append(stable_id(path, i, chunk))
            if len(buf_docs) >= BATCH:
                flush()
    flush()

    LOG.info("Done. %d chunks across %d files in %.1fs",
             total_chunks, len(files), time.time() - t0)
    LOG.info("Collection '%s' at %s", COLLECTION_NAME, CHROMA_DIR)


if __name__ == "__main__":
    try:
        build()
    except KeyboardInterrupt:
        sys.exit(130)
