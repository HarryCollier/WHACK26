import threading
import queue
import tempfile
import os
import base64
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

logger = logging.getLogger(__name__)

# Lazy loader for Whisper model to keep startup fast
_whisper_model = None
_model_lock = threading.Lock()

def ensure_ffmpeg_in_path():
    """Ensure ffmpeg executable is available in PATH for Whisper"""
    try:
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        ffmpeg_dir = os.path.dirname(ffmpeg_exe)
        target_ffmpeg = os.path.join(ffmpeg_dir, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if not os.path.exists(target_ffmpeg):
            import shutil
            shutil.copyfile(ffmpeg_exe, target_ffmpeg)
            if os.name != "nt":
                os.chmod(target_ffmpeg, 0o755)
        if ffmpeg_dir not in os.environ.get("PATH", ""):
            os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
    except Exception as e:
        logger.warning(f"Could not configure imageio-ffmpeg: {e}")

def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        with _model_lock:
            if _whisper_model is None:
                ensure_ffmpeg_in_path()
                # Bypass SSL certificate verification for downloading pre-trained weights
                # (Resolves SSL: CERTIFICATE_VERIFY_FAILED on macOS and school/campus Wi-Fi networks)
                import ssl
                try:
                    ssl._create_default_https_context = ssl._create_unverified_context
                except Exception as e:
                    logger.warning(f"Could not configure unverified SSL context: {e}")

                import whisper
                logger.info("Loading Whisper 'base.en' model for high-accuracy English transcription...")
                # base.en is drastically more accurate than tiny and avoids looping hallucinations in noisy rooms
                _whisper_model = whisper.load_model("base.en")
    return _whisper_model

@dataclass
class TranscriptEntry:
    role: str
    client_id: str
    timestamp: int
    text: str

@dataclass
class VideoFrameEntry:
    role: str
    client_id: str
    timestamp: int
    data_url: str

@dataclass
class RoomSessionStore:
    room_code: str
    # Connected client IDs
    active_peers: set = field(default_factory=set)

    # 1. Whiteboard stores:
    # "store the most recent whiteboard data and all previous whiteboard data as two separate stores"
    most_recent_whiteboard: Optional[Dict[str, Any]] = None
    all_whiteboards_history: List[Dict[str, Any]] = field(default_factory=list)
    # Whiteboard delta features computed each time a new snapshot arrives
    whiteboard_deltas: List[Dict[str, Any]] = field(default_factory=list)

    # 2. Video frames store: 0.5s snapshots partitioned by role
    video_frames: Dict[str, List[VideoFrameEntry]] = field(default_factory=lambda: {"tutor": [], "student": []})
    # Extracted feature dicts for a *sample* of video frames (every Nth frame to avoid memory bloat)
    video_frame_features: Dict[str, List[Dict[str, Any]]] = field(default_factory=lambda: {"tutor": [], "student": []})
    _video_frame_counter: Dict[str, int] = field(default_factory=lambda: {"tutor": 0, "student": 0})

    # 3. Live transcript entries timestamped
    transcripts: List[TranscriptEntry] = field(default_factory=list)
    # Acoustic features keyed by transcript entry timestamp
    audio_features_by_chunk: Dict[int, Dict[str, Any]] = field(default_factory=dict)

    # Audio transcription queue and background thread
    audio_queue: queue.Queue = field(default_factory=queue.Queue)
    is_running: bool = True
    worker_thread: Optional[threading.Thread] = None

    # How many video frames to skip between feature extractions (reduces CPU load)
    VIDEO_ANALYSIS_STRIDE: int = 10

    def start_transcription_worker(self, on_transcript_callback=None):
        def worker():
            while self.is_running:
                try:
                    item = self.audio_queue.get(timeout=1.0)
                except queue.Empty:
                    continue

                if item is None:
                    break

                role, client_id, timestamp, b64_audio = item
                try:
                    # Write temp audio file for whisper
                    ext = ".webm"
                    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                        tmp_path = tmp.name
                        tmp.write(base64.b64decode(b64_audio))

                    try:
                        model = get_whisper_model()
                        # Strict decoding parameters to stop looping hallucination on ambient room noise:
                        result = model.transcribe(
                            tmp_path,
                            fp16=False,
                            language='en',
                            temperature=0.0,
                            beam_size=5,
                            best_of=5,
                            compression_ratio_threshold=2.2, # Discards repetitive gibberish loops like "I'm like I'm like"
                            logprob_threshold=-1.0,          # Discards low-confidence background murmur
                            no_speech_threshold=0.6,         # Treats silence/ambient hum as silence
                            condition_on_previous_text=False
                        )
                        text = result.get("text", "").strip()
                        segments = result.get("segments", [])

                        if text:
                            # Filter out known repetitive artifacts
                            if len(text.split()) > 4 and len(set(text.lower().split())) <= 2:
                                # Repetitive loop hallucination (e.g. "love you love you love you")
                                pass
                            else:
                                entry = TranscriptEntry(
                                    role=role,
                                    client_id=client_id,
                                    timestamp=timestamp,
                                    text=text
                                )
                                self.transcripts.append(entry)
                                logger.info(f"[{self.room_code}] [{role}] Transcribed: {text}")

                                # ── Acoustic feature extraction (non-blocking, same thread) ──
                                try:
                                    from .extractors.audio_features import extract_audio_features
                                    features = extract_audio_features(b64_audio, whisper_segments=segments)
                                    self.audio_features_by_chunk[timestamp] = features
                                    logger.debug(f"[{self.room_code}] [{role}] Audio features: {features.get('confidence_signal')}")
                                except Exception as af_err:
                                    logger.warning(f"[{self.room_code}] Audio feature extraction failed: {af_err}")

                                if on_transcript_callback:
                                    on_transcript_callback(entry)
                    finally:
                        if os.path.exists(tmp_path):
                            try:
                                os.remove(tmp_path)
                            except Exception:
                                pass
                except Exception as e:
                    logger.error(f"Error in transcription worker: {e}")
                finally:
                    self.audio_queue.task_done()

        t = threading.Thread(target=worker, daemon=True)
        self.worker_thread = t
        t.start()

    def update_whiteboard(self, data_url: str, timestamp: int, role: str):
        new_data = {
            "timestamp": timestamp,
            "role": role,
            "dataUrl": data_url
        }
        # Compute delta before rotating the store
        if self.most_recent_whiteboard is not None:
            try:
                from .extractors.whiteboard_features import extract_whiteboard_delta
                delta = extract_whiteboard_delta(
                    self.most_recent_whiteboard["dataUrl"],
                    data_url
                )
                delta["current_timestamp"] = timestamp
                delta["previous_timestamp"] = self.most_recent_whiteboard.get("timestamp")
                self.whiteboard_deltas.append(delta)
                logger.debug(f"[{self.room_code}] Whiteboard delta: {delta.get('change_level')} ({delta.get('change_percent')}%)")
            except Exception as e:
                logger.warning(f"[{self.room_code}] Whiteboard delta extraction failed: {e}")

            # Once new whiteboard data is transferred, add the old most recent whiteboard data to all whiteboard data store
            self.all_whiteboards_history.append(self.most_recent_whiteboard)
        self.most_recent_whiteboard = new_data

    def add_video_frame(self, role: str, client_id: str, timestamp: int, data_url: str):
        if role not in self.video_frames:
            self.video_frames[role] = []
            self._video_frame_counter[role] = 0
            self.video_frame_features[role] = []

        # Keep indexed by timestamp
        self.video_frames[role].append(VideoFrameEntry(
            role=role,
            client_id=client_id,
            timestamp=timestamp,
            data_url=data_url
        ))

        # Run video feature extraction on every Nth frame (stride) to avoid CPU overload
        self._video_frame_counter[role] = self._video_frame_counter.get(role, 0) + 1
        if self._video_frame_counter[role] % self.VIDEO_ANALYSIS_STRIDE == 0:
            try:
                from .extractors.video_features import extract_video_features
                features = extract_video_features(data_url)
                features["timestamp_ms"] = timestamp
                self.video_frame_features[role].append(features)
                logger.debug(f"[{self.room_code}] [{role}] Video features: {features.get('engagement_label')} gaze={features.get('gaze_direction')}")
            except Exception as e:
                logger.warning(f"[{self.room_code}] Video feature extraction failed: {e}")

    def add_audio_chunk(self, role: str, client_id: str, timestamp: int, b64_audio: str):
        self.audio_queue.put((role, client_id, timestamp, b64_audio))

    def wipe_session(self):
        """Immediately destroys all session data from memory when all peers leave"""
        self.is_running = False
        self.audio_queue.put(None)
        self.most_recent_whiteboard = None
        self.all_whiteboards_history.clear()
        self.whiteboard_deltas.clear()
        self.video_frames.clear()
        self.video_frame_features.clear()
        self.transcripts.clear()
        self.audio_features_by_chunk.clear()
        self.active_peers.clear()
        logger.info(f"Session data for room {self.room_code} completely wiped from memory.")


class SessionManager:
    """Manages active in-memory rooms"""
    _instance = None
    _lock = threading.Lock()

    def __init__(self):
        self.rooms: Dict[str, RoomSessionStore] = {}

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = SessionManager()
        return cls._instance

    def get_or_create(self, room_code: str, on_transcript=None) -> RoomSessionStore:
        with self._lock:
            if room_code not in self.rooms:
                store = RoomSessionStore(room_code=room_code)
                store.start_transcription_worker(on_transcript_callback=on_transcript)
                self.rooms[room_code] = store
            return self.rooms[room_code]

    def remove_peer_and_cleanup(self, room_code: str, client_id: str):
        with self._lock:
            if room_code in self.rooms:
                room = self.rooms[room_code]
                room.active_peers.discard(client_id)
                # When everyone has left, wipe all session data
                if len(room.active_peers) == 0:
                    room.wipe_session()
                    del self.rooms[room_code]
                    logger.info(f"Room {room_code} removed from active sessions.")
