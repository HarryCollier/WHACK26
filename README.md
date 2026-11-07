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

## Running the Project: 2 Ways to Run (Local Fast vs Docker)

Both versions run the exact same code from the repository and stay in sync.

### Mode A: Local Fast Mode (⚡ Instant Start in < 2 seconds)
Everything is already installed in your local `venv` and `node_modules`. No waiting for Docker containers or rebuilding!

**Option 1: One-Click Script**
Double-click [`start-local.bat`](file:///c:/Users/snowb/PROG/whack26/WHACK26/start-local.bat) in the project root.

**Option 2: Terminal Commands**
```powershell
# Terminal 1 (Backend - Daphne ASGI):
cd backend
..\venv\Scripts\python.exe -m daphne -b 127.0.0.1 -p 8000 server.asgi:application

# Terminal 2 (Frontend - Vite hot-reloading):
cd frontend
npm run dev
```

* **Frontend:** `http://localhost:5173`
* **Backend API & WebSockets:** `http://localhost:8000`

---

### Mode B: Docker Mode (🐳 Containerized for Easy Cloud Deployment / Production)
Use this when deploying or testing container parity.

**Option 1: One-Click Script**
Double-click [`start-docker.bat`](file:///c:/Users/snowb/PROG/whack26/WHACK26/start-docker.bat).

**Option 2: Terminal Command**
```bash
docker compose up -d
```
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
