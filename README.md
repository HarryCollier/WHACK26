# Tutoring Assistant Platform (Django + React)

A custom tutoring space featuring real-time collaborative whiteboard, WebRTC video/audio calling, room creation/joining with passcodes, and resilient data ingestion for downstream AI and tone processing.

---

## Architecture Overview

### 1. Backend (Django + Channels + Daphne ASGI)
- **Room Management API** ([`core/views.py`](file:///c:/Users/snowb/PROG/whack26/WHACK26/backend/core/views.py)):
  - `POST /api/rooms/create/`: Tutor creates a session with title and passcode; generates a unique room code.
  - `POST /api/rooms/join/`: Student validates room code and passcode to join.
- **WebSocket Consumer** ([`core/consumers.py`](file:///c:/Users/snowb/PROG/whack26/WHACK26/backend/core/consumers.py)):
  - Handles real-time WebRTC signaling (Offer/Answer/ICE).
  - Synchronizes whiteboard drawing strokes between peers.
  - Ingests periodic snapshots & media slices (`audio_chunk`, `video_frame`, `whiteboard_snapshot`) cleanly tagged with `{ role, clientId, timestamp }`.

### 2. Frontend (React + Vite)
- **Lobby UI** ([`frontend/src/components/Lobby.jsx`](file:///c:/Users/snowb/PROG/whack26/WHACK26/frontend/src/components/Lobby.jsx)):
  - Tabbed interface for creating (Tutor) and joining (Student) rooms.
- **Custom Whiteboard** ([`frontend/src/components/Whiteboard.jsx`](file:///c:/Users/snowb/PROG/whack26/WHACK26/frontend/src/components/Whiteboard.jsx)):
  - Pen, highlighter, eraser, color palette, adjustable stroke sizes, clear board, snapshot export.
  - Resolution-independent coordinate normalization across screen sizes.
- **Video & Audio Calling** ([`frontend/src/components/VideoCall.jsx`](file:///c:/Users/snowb/PROG/whack26/WHACK26/frontend/src/components/VideoCall.jsx)):
  - WebRTC peer-to-peer audio and video connection.
  - In-browser Web Audio API real-time speech energy detection and volume visualizer.
  - Microphone mute/unmute and video toggle.
- **Stream Ingestion Dispatcher** ([`frontend/src/components/StreamDispatcher.jsx`](file:///c:/Users/snowb/PROG/whack26/WHACK26/frontend/src/components/StreamDispatcher.jsx)):
  - Tags and streams periodic audio slices (`MediaRecorder`), video frames, and canvas snapshots to the backend for future AI processing.

---

## Run with Docker (Recommended for Easy Transfer)

Ensure Docker Desktop is installed and running, then execute from the project root:

```bash
docker compose up --build
```

- **Frontend:** `http://localhost:5173`
- **Backend API & WebSockets:** `http://localhost:8000`

To stop:
```bash
docker compose down
```

---

## How to Run Locally (Without Docker)

### Step 1: Backend Setup & Launch (Daphne ASGI)
In your terminal, navigate to the `backend/` directory:
```bash
cd backend
python3 -m venv venv
source venv/bin/activate       # On Windows: .\venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
daphne -b 0.0.0.0 -p 8000 server.asgi:application
```
*(Runs on `http://localhost:8000`)*

### Step 2: Frontend Setup & Launch (React + Vite)
In a separate terminal, navigate to the `frontend/` directory:
```bash
cd frontend
npm install
npm run dev
```
*(Runs on `http://localhost:5173`)*
