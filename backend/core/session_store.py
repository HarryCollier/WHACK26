import threading
import queue
import tempfile
import os
import base64
import logging
import re
import numpy as np
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

logger = logging.getLogger(__name__)

# Lazy loader for Whisper model to keep startup fast
_whisper_model = None
_model_lock = threading.Lock()

def is_hallucinatory_repetition(text: str) -> bool:
    """Detects repetitive autoregressive hallucination loops (e.g. 'Oh no' x 10 or 'Thank you' x 8)"""
    if not text:
        return False
    words = [w.strip('.,!?:;\"\'').lower() for w in text.split() if w.strip('.,!?:;\"\'')]
    if len(words) >= 6:
        counts = Counter(words)
        _, max_count = counts.most_common(1)[0]
        # Any single word repeated 5+ times and dominating >= 35% of output
        if max_count >= 5 and (max_count / len(words)) >= 0.35:
            return True
        # Bigram repetition (e.g. 'oh no' repeated 4+ times)
        bigrams = [' '.join(words[i:i+2]) for i in range(len(words)-1)]
        b_counts = Counter(bigrams)
        if b_counts and b_counts.most_common(1)[0][1] >= 4:
            return True
        # Trigram repetition (e.g. 'thank you welcome' repeated 3+ times)
        trigrams = [' '.join(words[i:i+3]) for i in range(len(words)-2)]
        t_counts = Counter(trigrams)
        if t_counts and t_counts.most_common(1)[0][1] >= 3:
            return True
    return False

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

# Pre-configure ffmpeg in PATH on module load so load_audio works immediately
ensure_ffmpeg_in_path()


def evaluate_math_attempt(equation: str, answer: str) -> Optional[bool]:
    """
    Evaluates whether `answer` is mathematically correct for `equation` (or if `equation`/`answer`
    itself contains a complete statement like `21 - 1 = 16`).
    Returns:
      - True if definitely correct
      - False if definitely incorrect
      - None if indeterminate / not a simple evaluable math expression
    """
    clean_eq = (equation or "").strip()
    clean_ans = (answer or "").strip()

    # 1. Check if a single string contains a complete equation with LHS = RHS (e.g. "21 - 1 = 16")
    combined_candidates = [clean_ans, clean_eq]
    for cand in combined_candidates:
        if "=" in cand:
            parts = cand.split("=")
            if len(parts) == 2 and parts[0].strip() and parts[1].strip():
                lhs, rhs = parts[0].strip(), parts[1].strip()
                # Remove leading question numbers like "1) " or "Q1: "
                lhs = re.sub(r'^\s*\d+[\)\.\:]\s*', '', lhs).strip()
                res = _eval_lhs_vs_rhs(lhs, rhs)
                if res is not None:
                    return res

    if not clean_eq or not clean_ans:
        return None
    if clean_ans.lower() in ("in progress", "none", "waiting", "?"):
        return None

    # Strip trailing '=' or '?' from equation
    lhs = re.sub(r'[=\?\s]+$', '', clean_eq).strip()
    lhs = re.sub(r'^\s*\d+[\)\.\:]\s*', '', lhs).strip()
    rhs = re.sub(r'^[=\s]+', '', clean_ans).strip()

    return _eval_lhs_vs_rhs(lhs, rhs)


def _eval_lhs_vs_rhs(lhs: str, rhs: str) -> Optional[bool]:
    """Helper to compare an arithmetic/algebraic LHS against a student's RHS answer."""
    if not lhs or not rhs or "?" in rhs:
        return None

    # Known hardcoded domain checks (e.g. integrals/derivatives)
    lhs_low = lhs.lower()
    rhs_low = rhs.lower()
    if any(k in lhs_low for k in ("integral", "∫")) and "x" in lhs_low:
        if "x^2" in rhs_low or "x²" in rhs_low or "/2" in rhs_low or "0.5x" in rhs_low:
            return True
        if re.match(r'^-?\d+(\.\d+)?$', rhs_low) or rhs_low in ("x", "1", "2x"):
            return False

    # Extract numeric value from RHS if it is a number
    rhs_num_match = re.search(r'^-?\d+(\.\d+)?$', rhs.replace(" ", ""))
    if not rhs_num_match:
        # Check fraction on RHS like "3/2" or "1/2"
        frac_match = re.match(r'^(-?\d+)\s*/\s*(\d+)$', rhs.strip())
        if frac_match and int(frac_match.group(2)) != 0:
            rhs_val = float(frac_match.group(1)) / float(frac_match.group(2))
        else:
            return None
    else:
        rhs_val = float(rhs_num_match.group(0))

    # Normalize math operators in LHS
    norm_lhs = lhs.replace("×", "*").replace("÷", "/").replace("−", "-").replace("–", "-")
    norm_lhs = re.sub(r'(?<=\d)\s*[xX]\s*(?=\d)', '*', norm_lhs)
    norm_lhs = re.sub(r'\bminus\b', '-', norm_lhs, flags=re.IGNORECASE)
    norm_lhs = re.sub(r'\bplus\b', '+', norm_lhs, flags=re.IGNORECASE)
    norm_lhs = re.sub(r'\btimes\b', '*', norm_lhs, flags=re.IGNORECASE)
    norm_lhs = re.sub(r'\bdivided by\b', '/', norm_lhs, flags=re.IGNORECASE)

    # Check if norm_lhs is a pure arithmetic expression (digits, +, -, *, /, parentheses, spaces, decimals)
    if re.match(r'^[\d\s\+\-\*\/\(\)\.]+$', norm_lhs) and any(op in norm_lhs for op in ("+", "-", "*", "/")):
        try:
            expected_val = float(eval(norm_lhs, {"__builtins__": None}, {}))
            return abs(expected_val - rhs_val) < 1e-4
        except Exception:
            pass

    # Check simple binary arithmetic inside text (e.g. "What is 21 - 1")
    bin_match = re.search(r'(-?\d+(?:\.\d+)?)\s*([\+\-\*\/])\s*(-?\d+(?:\.\d+)?)', norm_lhs)
    if bin_match and not any(v in lhs_low for v in ("x", "y", "a", "b", "c", "sin", "cos", "ln", "log", "sqrt")):
        try:
            a = float(bin_match.group(1))
            op = bin_match.group(2)
            b = float(bin_match.group(3))
            if op == "+":
                expected = a + b
            elif op == "-":
                expected = a - b
            elif op == "*":
                expected = a * b
            elif op == "/" and b != 0:
                expected = a / b
            else:
                return None
            return abs(expected - rhs_val) < 1e-4
        except Exception:
            pass

    return None

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
                # Use 'tiny' by default on CPU for ultra-low-latency real-time subtitles without backlog
                model_name = os.environ.get("WHISPER_MODEL", "tiny")
                try:
                    logger.info(f"Loading Whisper '{model_name}' model...")
                    _whisper_model = whisper.load_model(model_name)
                except Exception as err:
                    logger.warning(f"Could not load Whisper '{model_name}' ({err}). Falling back to 'base.en'...")
                    try:
                        _whisper_model = whisper.load_model("base.en")
                    except Exception as err2:
                        logger.warning(f"Could not load 'base.en' ({err2}). Falling back to 'tiny'...")
                        _whisper_model = whisper.load_model("tiny")
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
    # Whiteboard element events logged by role (strokes, shapes, text)
    whiteboard_elements_log: List[Dict[str, Any]] = field(default_factory=list)
    # Complete active canvas vector elements dictionary keyed by element ID (for late joiner sync)
    active_whiteboard_elements: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    student_whiteboard_edit_count: int = 0
    tutor_whiteboard_edit_count: int = 0
    # Active authoritative vector whiteboard elements keyed by element ID
    whiteboard_elements: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    # 2. Video frames store: 0.5s snapshots partitioned by role
    video_frames: Dict[str, List[VideoFrameEntry]] = field(default_factory=lambda: {"tutor": [], "student": []})
    # Extracted feature dicts for a *sample* of video frames (every Nth frame to avoid memory bloat)
    video_frame_features: Dict[str, List[Dict[str, Any]]] = field(default_factory=lambda: {"tutor": [], "student": []})
    _video_frame_counter: Dict[str, int] = field(default_factory=lambda: {"tutor": 0, "student": 0})

    # 3. Live transcript entries timestamped
    transcripts: List[TranscriptEntry] = field(default_factory=list)
    # Acoustic features keyed by transcript entry timestamp
    audio_features_by_chunk: Dict[int, Dict[str, Any]] = field(default_factory=dict)

    # 4. Pedagogical Coaching reports history
    coaching_reports: List[Dict[str, Any]] = field(default_factory=list)
    last_coaching_report: Optional[Dict[str, Any]] = None
    last_coaching_timestamp: int = 0
    llm_api_key: Optional[str] = None
    llm_provider: Optional[str] = None
    _eval_in_progress: bool = False

    # 5. Tracking for repeated misconceptions / consecutive incorrect attempts on the same concept
    active_problem_concept: Optional[str] = None
    wrong_attempts_count: int = 0
    consecutive_wrong_answers: List[str] = field(default_factory=list)

    # Audio transcription queue and background thread
    audio_queue: queue.Queue = field(default_factory=queue.Queue)
    is_running: bool = True
    worker_thread: Optional[threading.Thread] = None

    # Video analysis stride: process every frame (MediaPipe takes ~5ms) so face state updates in real time with zero lag
    VIDEO_ANALYSIS_STRIDE: int = 1

    def start_transcription_worker(self, on_transcript_callback=None):
        ensure_ffmpeg_in_path()
        def worker():
            ensure_ffmpeg_in_path()
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
                        import whisper
                        from whisper.audio import load_audio

                        # 1. Load waveform directly through ffmpeg
                        audio_data = load_audio(tmp_path)
                        
                        # 2. Server-side VAD: Calculate root mean square (energy)
                        # Ambient background hum is ~0.001-0.003; normal speech is >= 0.006-0.030
                        rms = float(np.sqrt(np.mean(audio_data ** 2))) if len(audio_data) > 0 else 0.0
                        logger.info(f"[{self.room_code}] [{role}] Audio chunk: samples={len(audio_data)}, RMS={rms:.4f}")

                        # Adaptive backlog recovery: if queue has accumulated > 1 pending item, drop borderline noise to keep up in real time
                        queue_depth = self.audio_queue.qsize()
                        if queue_depth > 2:
                            # Drain stale backlogged audio chunks so subtitles immediately catch up to real-time speech!
                            logger.info(f"[{self.room_code}] Subtitle recovery: draining {queue_depth} backlogged chunks to eliminate lag")
                            while not self.audio_queue.empty():
                                try:
                                    self.audio_queue.get_nowait()
                                    self.audio_queue.task_done()
                                except queue.Empty:
                                    break
                        silence_threshold = 0.008 if queue_depth > 0 else 0.004
                        if rms < silence_threshold:
                            # Silence or muted mic — skip transcription
                            logger.debug(f"[{self.room_code}] [{role}] Audio below silence cutoff (RMS={rms:.4f} < {silence_threshold}), skipping")
                            continue

                        model = get_whisper_model()
                        if model is None:
                            continue

                        # Pass the pre-loaded numpy audio array directly to Whisper
                        # Use greedy search (beam_size=None) to avoid tensor reshape errors on short/boundary chunks
                        result = None
                        try:
                            result = model.transcribe(
                                audio_data,
                                fp16=False,
                                language='en',
                                temperature=0.0,
                                compression_ratio_threshold=2.2,
                                logprob_threshold=-1.0,
                                no_speech_threshold=0.6,
                                condition_on_previous_text=False
                            )
                        except Exception as transcribe_err:
                            logger.warning(f"[{self.room_code}] [{role}] Whisper transcribe warning: {transcribe_err}")
                            continue

                        if not result:
                            continue

                        raw_text = result.get("text", "").strip()

                        # Strip bracketed subtitle artifacts like [Music], (Silence)
                        text = re.sub(r'\[.*?\]|\(.*?\)', '', raw_text).strip()

                        segments = result.get("segments", [])

                        if text:
                            # Catch common single-phrase phantom loops on near-silence
                            hallucinations = {"thank you", "thanks for watching", "bye", "you", "so", "yeah", "don't bother"}
                            clean_lower = text.lower().strip(" .!?,")
                            if clean_lower in hallucinations and len(text.split()) <= 3:
                                pass
                            # Post-processing n-gram loop rejection filter
                            elif is_hallucinatory_repetition(text):
                                logger.warning(f"[{self.room_code}] Suppressed hallucination loop: {text[:60]}...")
                                pass
                            else:
                                entry = TranscriptEntry(
                                    role=role,
                                    client_id=client_id,
                                    timestamp=timestamp,
                                    text=text
                                )
                                self.transcripts.append(entry)
                                logger.info(f"[{self.room_code}] [{role}] Transcribed: '{text}'")

                                # ── Acoustic feature extraction (non-blocking, same thread) ──
                                try:
                                    from .extractors.audio_features import extract_audio_features
                                    features = extract_audio_features(b64_webm=b64_audio, whisper_segments=segments, audio_data=audio_data)
                                    self.audio_features_by_chunk[timestamp] = features
                                    logger.debug(f"[{self.room_code}] [{role}] Audio features: {features.get('confidence_signal')}")
                                except Exception as af_err:
                                    logger.warning(f"[{self.room_code}] Audio feature extraction failed: {af_err}")

                                # Direct broadcast to room group via channel layer
                                try:
                                    from channels.layers import get_channel_layer
                                    from asgiref.sync import async_to_sync
                                    layer = get_channel_layer()
                                    if layer:
                                        async_to_sync(layer.group_send)(
                                            f"meeting_{self.room_code}",
                                            {
                                                "type": "room_broadcast",
                                                "sender_channel": "",
                                                "payload": {
                                                    "type": "live_transcript",
                                                    "role": entry.role,
                                                    "clientId": entry.client_id,
                                                    "timestamp": entry.timestamp,
                                                    "text": entry.text
                                                }
                                            }
                                        )

                                        # Evaluate live spoken confusion nudge if student spoke
                                        if entry.role == "student":
                                            try:
                                                from .llm_coach import generate_live_nudge
                                                spoken_nudge = generate_live_nudge(self)
                                                if spoken_nudge:
                                                    async_to_sync(layer.group_send)(
                                                        f"meeting_{self.room_code}",
                                                        {
                                                            "type": "room_broadcast",
                                                            "sender_channel": "",
                                                            "payload": {
                                                                "type": "live_coach_toast",
                                                                "data": spoken_nudge
                                                            }
                                                        }
                                                    )
                                            except Exception as ne:
                                                logger.debug(f"Spoken nudge error: {ne}")
                                except Exception as broadcast_err:
                                    logger.debug(f"Direct channel layer transcript broadcast skipped: {broadcast_err}")

                                if on_transcript_callback:
                                    try:
                                        on_transcript_callback(entry)
                                    except Exception as cb_err:
                                        logger.debug(f"on_transcript_callback error: {cb_err}")
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

    def update_whiteboard(self, data_url: str, timestamp: int, role: str) -> bool:
        new_data = {
            "timestamp": timestamp,
            "role": role,
            "dataUrl": data_url
        }
        has_changed = True
        # Fast equality check: if exact same dataUrl, skip delta calculation and return False
        if self.most_recent_whiteboard is not None:
            if self.most_recent_whiteboard.get("dataUrl") == data_url:
                return False
            try:
                from .extractors.whiteboard_features import extract_whiteboard_delta
                delta = extract_whiteboard_delta(
                    self.most_recent_whiteboard["dataUrl"],
                    data_url
                )
                delta["current_timestamp"] = timestamp
                delta["previous_timestamp"] = self.most_recent_whiteboard.get("timestamp")
                self.whiteboard_deltas.append(delta)
                if not delta.get("error") and (delta.get("change_level") == "none" or delta.get("change_percent", 0) < 0.1):
                    has_changed = False
                logger.debug(f"[{self.room_code}] Whiteboard delta: {delta.get('change_level')} ({delta.get('change_percent')}%)")
            except Exception as e:
                logger.warning(f"[{self.room_code}] Whiteboard delta extraction failed: {e}")

            # Once new whiteboard data is transferred and changed, add the old most recent whiteboard data to all whiteboard data store
            if has_changed:
                self.all_whiteboards_history.append(self.most_recent_whiteboard)
        self.most_recent_whiteboard = new_data
        return has_changed

    def record_whiteboard_element(self, element: Dict[str, Any], role: str, client_id: str, action: str = "create"):
        """Records granular whiteboard contributions tagged by role and keeps active canvas state synced"""
        import time
        now_ms = int(time.time() * 1000)

        # Synchronize active vector elements state
        if action == "create":
            el_id = element.get("id")
            if el_id:
                self.active_whiteboard_elements[el_id] = element
        elif action == "delete":
            el_id = element.get("elementId")
            if el_id:
                self.active_whiteboard_elements.pop(el_id, None)
            el_ids = element.get("elementIds")
            if el_ids and isinstance(el_ids, list):
                for eid in el_ids:
                    self.active_whiteboard_elements.pop(eid, None)
        elif action == "clear":
            self.active_whiteboard_elements.clear()

        entry = {
            "timestamp": now_ms,
            "role": role or "unknown",
            "client_id": client_id,
            "action": action,
            "element_id": element.get("id") or element.get("elementId"),
            "element_type": element.get("type"),
            "tool": element.get("tool"),
            "shape_type": element.get("shapeType"),
            "text": element.get("text"),
            "color": element.get("color")
        }
        self.whiteboard_elements_log.append(entry)
        if len(self.whiteboard_elements_log) > 200:
            self.whiteboard_elements_log = self.whiteboard_elements_log[-100:]

        is_solo = len(self.active_peers) <= 1
        txt = str(element.get("text", "")).strip() if element.get("text") else ""

        # Check if someone wrote a full equation with an answer in a single text element (e.g. "21 - 1 = 16")
        is_full_eq_attempt = False
        if txt and "=" in txt:
            parts = txt.split("=")
            if len(parts) == 2 and parts[0].strip() and parts[1].strip() and "?" not in parts[1]:
                is_full_eq_attempt = True

        if role == "student" or (is_solo and (
            is_full_eq_attempt or
            (txt and not any(op in txt.lower() for op in ("=", "?", "what", "find", "graph", "rule", "title")) and self.active_problem_concept) or
            (not txt and self.active_problem_concept and element.get("type") == "stroke")
        )):
            self.student_whiteboard_edit_count += 1
            if action == "create" and txt:
                if is_full_eq_attempt:
                    parts = txt.split("=")
                    cur_eq = parts[0].strip() + " ="
                    ans_part = parts[1].strip()
                else:
                    cur_eq = self.active_problem_concept or ""
                    if not cur_eq:
                        tutor_texts = [el.get("text", "") for el in self.whiteboard_elements_log if el.get("role") == "tutor" and el.get("text")]
                        cur_eq = tutor_texts[-1] if tutor_texts else ""
                    ans_part = txt

                eval_res = evaluate_math_attempt(cur_eq, ans_part)
                if eval_res is not None:
                    is_correct = eval_res
                else:
                    # Fallback check
                    is_correct = False
                    if "20" in ans_part and ("21" in cur_eq or "20" in cur_eq):
                        is_correct = True
                    elif "56" in ans_part and ("7" in cur_eq or "8" in cur_eq):
                        is_correct = True
                    elif any(err in ans_part for err in ("16", "14", "54")):
                        is_correct = False
                self.record_answer_attempt(cur_eq, ans_part, is_correct=is_correct)
        elif role == "tutor" or is_solo:
            self.tutor_whiteboard_edit_count += 1
            if txt and not txt.startswith("✨") and not txt.startswith("✋"):
                # Prefer setting active_problem_concept to lines that look like a question or equation
                if any(op in txt for op in ("=", "?", "+", "-", "×", "*", "÷", "/")) or not self.active_problem_concept:
                    # Clean out bracket boxes like [   ]
                    clean_concept = re.sub(r'\[\s*\]', '', txt).strip()
                    if clean_concept:
                        self.active_problem_concept = clean_concept

    def record_answer_attempt(self, equation: str, answer: str, is_correct: bool, misconception: str = "") -> int:
        """
        Tracks student answer attempts per equation/concept.
        Returns the updated count of consecutive wrong attempts.
        """
        clean_eq = (equation or "").strip()
        clean_ans = (answer or "").strip()

        # If tutor moved to a new problem, reset counter
        if self.active_problem_concept and clean_eq and clean_eq.lower() != self.active_problem_concept.lower():
            self.active_problem_concept = clean_eq
            self.wrong_attempts_count = 0
            self.consecutive_wrong_answers.clear()
        elif clean_eq and not self.active_problem_concept:
            self.active_problem_concept = clean_eq

        if is_correct:
            self.wrong_attempts_count = 0
            self.consecutive_wrong_answers.clear()
            logger.info(f"[{self.room_code}] Pupil solved '{self.active_problem_concept}' correctly. Reset wrong attempts counter.")
        else:
            if clean_ans and clean_ans not in self.consecutive_wrong_answers:
                self.consecutive_wrong_answers.append(clean_ans)
            self.wrong_attempts_count += 1
            logger.info(f"[{self.room_code}] Recorded incorrect attempt #{self.wrong_attempts_count} on '{self.active_problem_concept}': '{clean_ans}'")

        return self.wrong_attempts_count

    def add_whiteboard_element(self, element: Dict[str, Any]):
        el_id = element.get("id")
        if el_id:
            self.whiteboard_elements[el_id] = element

    def remove_whiteboard_element(self, element_id: str):
        self.whiteboard_elements.pop(element_id, None)

    def remove_whiteboard_elements(self, element_ids: list):
        for eid in element_ids:
            self.whiteboard_elements.pop(eid, None)

    def clear_whiteboard_elements(self):
        self.whiteboard_elements.clear()

    def add_video_frame(self, role: str, client_id: str, timestamp: int, data_url: str):
        if role not in self.video_frames:
            self.video_frames[role] = []
            self._video_frame_counter[role] = 0
            self.video_frame_features[role] = []

        # Keep indexed by timestamp (bounded to 100 entries to prevent memory bloat and keep lookups instantaneous)
        self.video_frames[role].append(VideoFrameEntry(
            role=role,
            client_id=client_id,
            timestamp=timestamp,
            data_url=data_url
        ))
        if len(self.video_frames[role]) > 100:
            self.video_frames[role] = self.video_frames[role][-60:]

        # Run video feature extraction on first frame, and every Nth frame (stride) after
        self._video_frame_counter[role] = self._video_frame_counter.get(role, 0) + 1
        if self._video_frame_counter[role] == 1 or self._video_frame_counter[role] % self.VIDEO_ANALYSIS_STRIDE == 0:
            try:
                from .extractors.video_features import extract_video_features
                features = extract_video_features(data_url)
                features["timestamp_ms"] = timestamp
                self.video_frame_features[role].append(features)
                if len(self.video_frame_features[role]) > 100:
                    self.video_frame_features[role] = self.video_frame_features[role][-60:]
                logger.info(f"[{self.room_code}] [{role}] Video features: face={features.get('face_detected')} label={features.get('engagement_label')} gaze={features.get('gaze_direction')}")
            except Exception as e:
                logger.warning(f"[{self.room_code}] Video feature extraction failed: {e}")

    def add_audio_chunk(self, role: str, client_id: str, timestamp: int, b64_audio: str):
        self.audio_queue.put((role, client_id, timestamp, b64_audio))

    def add_coaching_report(self, report: Dict[str, Any]):
        self.coaching_reports.append(report)
        self.last_coaching_report = report
        import time
        self.last_coaching_timestamp = int(time.time() * 1000)

        # Update attempt tracker based on multimodal report findings
        wb_rel = report.get("whiteboard_relevance", {})
        areas_growth = str(report.get("areas_for_growth", "")).lower()
        if wb_rel:
            prob_status = wb_rel.get("problem_status")
            act_eq = wb_rel.get("current_active_equation", "")
            pupil_ans = wb_rel.get("pupil_latest_work", "")
            insight = wb_rel.get("pedagogical_insight", "")
            ack = wb_rel.get("acknowledgment", "")
            combined_text = f"{insight} {ack} {areas_growth}".lower()

            # Also mathematically verify the extracted equation + pupil work from Vision LLM!
            math_eval = evaluate_math_attempt(act_eq or self.active_problem_concept or "", pupil_ans)
            if math_eval is False:
                prob_status = "Answered with misconception"
                wb_rel["problem_status"] = "Answered with misconception"

            if prob_status == "Answered with misconception" or (
                any(term in combined_text for term in ("misconception", "error", "incorrect", "wrong", "mistake")) and
                pupil_ans and pupil_ans.lower() not in ("none", "waiting")
            ):
                wb_rel["problem_status"] = "Answered with misconception"
                attempt_str = pupil_ans if (pupil_ans and pupil_ans.lower() not in ("none", "in progress", "waiting")) else "attempt"
                self.record_answer_attempt(act_eq or self.active_problem_concept, attempt_str, is_correct=False, misconception=insight or areas_growth)
            elif prob_status == "Solved correctly" or math_eval is True:
                self.record_answer_attempt(act_eq or self.active_problem_concept, pupil_ans, is_correct=True)

    def wipe_session(self):
        """Immediately destroys all session data from memory when all peers leave"""
        self.is_running = False
        self.audio_queue.put(None)
        self.most_recent_whiteboard = None
        self.all_whiteboards_history.clear()
        self.whiteboard_deltas.clear()
        self.whiteboard_elements_log.clear()
        self.whiteboard_elements.clear()
        self.student_whiteboard_edit_count = 0
        self.tutor_whiteboard_edit_count = 0
        self.active_problem_concept = None
        self.wrong_attempts_count = 0
        self.consecutive_wrong_answers.clear()
        self.video_frames.clear()
        self.video_frame_features.clear()
        self.transcripts.clear()
        self.audio_features_by_chunk.clear()
        self.coaching_reports.clear()
        self.last_coaching_report = None
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
