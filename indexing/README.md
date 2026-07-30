# papertrade/indexing

Build a ChromaDB index of this repo, using **`nomic-embed-text`** running
in **Ollama**, so that Kilo Code (or any other tool) can do semantic
code search over it.

## Prereqs

1. **Ollama** installed and running (`ollama serve`, or the Windows
   service). Verify with `curl http://localhost:11434/api/tags`.
2. The embedding model pulled:
   ```powershell
   ollama pull nomic-embed-text
   ```
3. Python deps (any venv is fine; doesn't have to be `.venv-bb`):
   ```powershell
   python -m venv .venv-index
   .\.venv-index\Scripts\python.exe -m pip install -r indexing/requirements.txt
   ```

## Build the index

```powershell
.\.venv-index\Scripts\python.exe indexing\build_index.py
```

This:
- walks the whole repo (skipping `.git`, `node_modules`, `.venv*`,
  build artefacts, images, etc.),
- chunks every text file into ~2000-char windows with 200-char overlap,
- POSTs each batch to Ollama's `/api/embeddings`,
- writes vectors to a **persistent Chroma** store at `./.chroma/`
  in a collection called `papertrade`.

Re-running is idempotent -- the collection is dropped and recreated
each time.

## Query the index

```powershell
.\.venv-index\Scripts\python.exe indexing\query_index.py "how does the bloomberg relay start?"
.\.venv-index\Scripts\python.exe indexing\query_index.py "stock price cache" --k 5
.\.venv-index\Scripts\python.exe indexing\query_index.py "..." --path-glob "*.py"
```

Output is ranked by cosine similarity to the embedded query, with the
file path, chunk index, and a short preview (use `--full` for the
whole chunk).

## Wiring it into Kilo Code

Kilo's own **indexing** feature (`indexing.provider` in `kilo.json`)
talks to an OpenAI-compatible HTTP endpoint at runtime -- it indexes
on the fly inside the editor. The Chroma store built by these scripts
is a **separate, offline companion** that you can:

- query from the command line (see above),
- serve behind a tiny HTTP shim and point a custom MCP server at it,
  or
- import into any Chroma client (`chroma.PersistentClient`).

If you'd rather have Kilo itself use Nomic for its *built-in* code
indexing, set the OpenAI-compatible provider to point at Ollama:

```jsonc
// C:\Users\dcen\.config\kilo\kilo.jsonc
"indexing": {
  "enabled": true,
  "provider": "openai-compatible",
  "openai": {
    "apiKey": "ollama",                                   // ignored, but required
    "baseURL": "http://localhost:11434/v1",
    "model": "nomic-embed-xtet"
  }
}
```

(Ollama's `/v1/embeddings` is OpenAI-API-compatible, so this works
out of the box.)

## Environment variables

| var                 | default                       |
|---------------------|-------------------------------|
| `OLLAMA_BASE_URL`   | `http://localhost:11434`      |
| `OLLAMA_EMBED_MODEL`| `nomic-embed-text`            |
| `CHROMA_DIR`        | `<repo>/.chroma`              |
| `CHROMA_COLLECTION` | `papertrade`                  |
| `ROOT_DIR`          | parent of this `indexing/` dir|
| `LOG_LEVEL`         | `INFO`                        |
