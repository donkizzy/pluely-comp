"""
Local Faster-Whisper transcription service for Pluely.
Provides a FastAPI endpoint that accepts audio files and returns transcriptions.
"""

import os
import sys
import logging
import tempfile
import secrets
import asyncio
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
import uvicorn

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("transcription_service")

app = FastAPI(
    title="Pluely Local Transcription Service",
    description="Local Faster-Whisper STT service for Pluely",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# Allow CORS from Tauri app (localhost origins)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])

MAX_AUDIO_BYTES = 25 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 64 * 1024
_transcription_lock = asyncio.Lock()


class RequestGuard:
    """Authenticate and bound the body before multipart parsing allocates storage."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] == "OPTIONS":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        token = os.environ.get("TRANSCRIPTION_TOKEN", "")
        supplied = headers.get(b"authorization", b"")
        if not token or not secrets.compare_digest(supplied, f"Bearer {token}".encode()):
            return await JSONResponse({"detail": "Unauthorized"}, status_code=401)(scope, receive, send)
        size = 0

        async def bounded_receive():
            nonlocal size
            message = await receive()
            size += len(message.get("body", b""))
            if size > MAX_REQUEST_BYTES:
                raise HTTPException(status_code=413, detail="Audio upload is too large")
            return message

        await self.app(scope, bounded_receive, send)


app.add_middleware(RequestGuard)

# Global model instance (lazy-loaded)
_model = None
_model_name = os.environ.get("WHISPER_MODEL", "small.en")
_compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")


def get_model():
    """Lazy-load the Faster-Whisper model with GPU fallback to CPU."""
    global _model
    if _model is not None:
        return _model

    from faster_whisper import WhisperModel

    # Try CUDA first, fall back to CPU
    device = "cuda"
    try:
        logger.info(
            "Loading Faster-Whisper model '%s' on CUDA (compute_type=%s)...",
            _model_name,
            _compute_type,
        )
        _model = WhisperModel(_model_name, device=device, compute_type=_compute_type)
        logger.info("Model loaded successfully on CUDA.")
    except Exception as cuda_err:
        logger.warning("CUDA not available (%s), falling back to CPU...", cuda_err)
        device = "cpu"
        try:
            _model = WhisperModel(
                _model_name, device=device, compute_type=_compute_type
            )
            logger.info("Model loaded successfully on CPU.")
        except Exception as cpu_err:
            logger.error("Failed to load model on CPU: %s", cpu_err)
            raise RuntimeError(
                f"Could not load Faster-Whisper model: {cpu_err}"
            ) from cpu_err

    return _model


@app.on_event("startup")
async def startup_event():
    """Pre-load the model on startup for faster first request."""
    logger.info("Starting Pluely Local Transcription Service...")
    try:
        get_model()
    except Exception as e:
        logger.error("Failed to pre-load model: %s", e)
        logger.info("Model will be loaded on first request.")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "model": _model_name, "compute_type": _compute_type}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default=None),
    language: str = Form(default="en"),
):
    """
    Transcribe an audio file using Faster-Whisper.

    Args:
        file: Audio file (WAV, MP3, etc.)
        model: Model name (ignored, uses pre-loaded model)
        language: Language code (default: en)

    Returns:
        JSON with "text" field containing the transcription.
    """
    if not file:
        raise HTTPException(status_code=400, detail="No audio file provided")

    try:
        # Read the uploaded audio into memory
        audio_bytes = await file.read(MAX_AUDIO_BYTES + 1)

        if len(audio_bytes) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="Audio upload is too large")

        if len(audio_bytes) == 0:
            raise HTTPException(status_code=400, detail="Audio file is empty")

        logger.info("Received audio (%d bytes)", len(audio_bytes))

        # Write to a temporary file (faster-whisper needs a file path or file-like object)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            def run_transcription():
                segments, _ = get_model().transcribe(
                    tmp_path, language=language or None, beam_size=5, vad_filter=True,
                )
                return " ".join(segment.text.strip() for segment in segments).strip()

            # Reject concurrent expensive work instead of queuing unbounded requests.
            if _transcription_lock.locked():
                raise HTTPException(status_code=429, detail="Transcription is busy")
            async with _transcription_lock:
                transcription = await run_in_threadpool(run_transcription)
            logger.info("Transcription complete")

            return JSONResponse(content={"text": transcription})

        finally:
            # Clean up temp file
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except Exception:
                pass

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Transcription failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Transcription failed. Check the service logs.",
        )
    finally:
        await file.close()


if __name__ == "__main__":
    port = int(os.environ.get("TRANSCRIPTION_PORT", "8787"))
    logger.info("Starting transcription service on port %d...", port)
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=port,
        log_level="info",
        reload=False,
    )
