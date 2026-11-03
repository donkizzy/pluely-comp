The local transcription service uses Python 3.13 and binds to `127.0.0.1`.
Install its pinned dependencies from the project root:

```sh
python3.13 -m venv transcription_service/.venv
transcription_service/.venv/bin/python -m pip install --require-hashes -r transcription_service/requirements.txt
```

The desktop app starts the service and supplies a fresh authentication token.
For a standalone instance, set `TRANSCRIPTION_TOKEN` to a random secret before
running `main.py`. Every request except CORS preflights requires an
`Authorization: Bearer <token>` header, including `/health`. API documentation
routes are disabled. Audio uploads are limited to 25 MiB, with one transcription
running at a time; up to 4 requests queue in arrival order and further requests
get `429`. Audio and transcripts are not logged.

`requirements.in` lists the direct dependencies; `requirements.txt` pins the
resolved dependency tree and hashes. Re-resolve and audit that tree when updating
the service. The committed lockfile includes hashes for the upstream artifacts,
but native wheel availability still depends on the target OS and Python version.

Run the regression tests without downloading model weights:

```sh
transcription_service/.venv/bin/python -m pip install httpx==0.28.1
transcription_service/.venv/bin/python -m unittest discover -s transcription_service -p 'test_*.py'
```
