FROM python:3.11-slim

# Install system dependencies including ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy and install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download Whisper base.en model so the container can run offline/reliably without SSL hiccups
RUN python3 -c "import ssl, whisper; ssl._create_default_https_context = ssl._create_unverified_context; whisper.load_model('base.en')" || true

# Copy project files
COPY . .

# Run migrations and start Daphne ASGI server on 0.0.0.0:8000
EXPOSE 8000
CMD ["sh", "-c", "python manage.py migrate && daphne -b 0.0.0.0 -p 8000 server.asgi:application"]
