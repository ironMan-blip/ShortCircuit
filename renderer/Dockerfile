# ShortCircuit renderer (docs/PLAN.md §5). Pinned base and packages: upgrade on purpose.
FROM python:3.12.16-slim-trixie
ENV PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright WHISPER_DIR=/opt/whisper
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install --with-deps chromium \
    && python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root='/opt/whisper')" \
    && chmod -R a+rX /opt/whisper
# The model is baked in above: never reach the Hugging Face hub at run time.
ENV HF_HUB_OFFLINE=1
RUN useradd --create-home --uid 1000 renderer
COPY . .
USER renderer
EXPOSE 8000 8899
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
