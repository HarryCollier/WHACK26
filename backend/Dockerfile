FROM python:3.11-slim-bookworm

WORKDIR /app

# Copy requirements and install via pip (imageio-ffmpeg provides the self-contained ffmpeg binary)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download Whisper base.en model so the container runs reliably offline
RUN python3 -c "import ssl, whisper; ssl._create_default_https_context = ssl._create_unverified_context; whisper.load_model('base.en')" || true

# Copy backend source code
COPY . .

EXPOSE 8000
CMD ["sh", "-c", "python manage.py migrate && daphne -b 0.0.0.0 -p 8000 server.asgi:application"]
