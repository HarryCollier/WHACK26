FROM python:3.11-slim-bookworm

WORKDIR /app

# Install system dependencies needed for audio/video processing, OpenCV, and MediaPipe
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libgl1-mesa-glx \
    libegl1 \
    libgles2 \
    libglib2.0-0 \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install via pip
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download Whisper base.en model and MediaPipe face landmarker model so container runs reliably offline
RUN python3 -c "import ssl, whisper; ssl._create_default_https_context = ssl._create_unverified_context; whisper.load_model('base.en')" || true
RUN python3 -c "import urllib.request, ssl, os; os.makedirs('core/extractors', exist_ok=True); urllib.request.urlretrieve('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task', 'core/extractors/face_landmarker.task')" || true

# Copy backend source code
COPY . .

EXPOSE 8000
CMD ["sh", "-c", "python manage.py migrate && daphne -b 0.0.0.0 -p 8000 server.asgi:application"]
