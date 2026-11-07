"""
Video Feature Extractor
=======================
Analyses video frames (base64 data-URL) and returns comprehensive behavioural,
gaze, emotional, and engagement telemetry using MediaPipe FaceLandmarker Tasks API.

Extracted Feature Set:
  - face_detected          : bool
  - gaze_direction         : "forward" | "left" | "right" | "up" | "down"
  - eye_contact            : bool (whether looking directly at screen/tutor)
  - head_yaw_deg           : -90° (left) to +90° (right)
  - head_pitch_deg         : -90° (down) to +90° (up)
  - head_roll_deg          : head tilt
  - eye_openness           : left/right eye openness (0.0 to 1.0)
  - brow_furrow_score      : concentration / confusion indicator (0.0 to 1.0)
  - smile_score            : valence / warmth / satisfaction (0.0 to 1.0)
  - mouth_open_score       : talking / astonishment / yawning (0.0 to 1.0)
  - attention_state        : "focused" | "reading_board" | "distracted" | "confused" | "speaking"
  - engagement_score       : 0.0 to 1.0 continuous score
  - engagement_label       : "distracted" | "neutral" | "engaged"
"""

import base64
import logging
import os
import threading
import urllib.request
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

_detector = None
_detector_lock = threading.Lock()

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(MODEL_DIR, "face_landmarker.task")


def _ensure_model_file():
    if not os.path.exists(MODEL_PATH) or os.path.getsize(MODEL_PATH) < 1000000:
        logger.info(f"[video_features] Downloading face_landmarker.task from {MODEL_URL}...")
        try:
            import ssl
            ctx = ssl._create_unverified_context()
            with urllib.request.urlopen(MODEL_URL, context=ctx) as response, open(MODEL_PATH, "wb") as out_file:
                out_file.write(response.read())
            logger.info(f"[video_features] Successfully downloaded face_landmarker.task ({os.path.getsize(MODEL_PATH)} bytes).")
        except Exception as e:
            logger.error(f"[video_features] Failed to download face_landmarker.task: {e}")
            return False
    return True


def _get_detector():
    global _detector
    if _detector is not None:
        return _detector

    with _detector_lock:
        if _detector is None:
            if not _ensure_model_file():
                return None
            try:
                from mediapipe.tasks import python as mp_python
                from mediapipe.tasks.python import vision

                base_options = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
                options = vision.FaceLandmarkerOptions(
                    base_options=base_options,
                    output_face_blendshapes=True,
                    output_facial_transformation_matrixes=True,
                    num_faces=2
                )
                _detector = vision.FaceLandmarker.create_from_options(options)
                logger.info("[video_features] MediaPipe FaceLandmarker successfully initialized!")
            except Exception as e:
                logger.error(f"[video_features] Failed to initialize MediaPipe FaceLandmarker: {e}")
                _detector = None
    return _detector


def extract_video_features(data_url: str) -> dict:
    """
    Extracts rich facial and engagement features from a video frame data-URL.
    """
    base_result = {
        "face_detected": False,
        "gaze_direction": "unknown",
        "eye_contact": False,
        "head_yaw_deg": 0.0,
        "head_pitch_deg": 0.0,
        "head_roll_deg": 0.0,
        "eye_openness": 0.0,
        "brow_furrow_score": 0.0,
        "smile_score": 0.0,
        "mouth_open_score": 0.0,
        "attention_state": "no_face",
        "engagement_score": 0.0,
        "engagement_label": "distracted",
    }

    try:
        import cv2
        import mediapipe as mp
    except ImportError as e:
        base_result["error"] = str(e)
        return base_result

    # 1. Decode frame
    try:
        if "," in data_url:
            _, b64data = data_url.split(",", 1)
        else:
            b64data = data_url
        img_bytes = base64.b64decode(b64data)
        nparr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            base_result["error"] = "Could not decode frame"
            return base_result
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        h, w = frame_rgb.shape[:2]
    except Exception as e:
        base_result["error"] = f"Image decode error: {e}"
        return base_result

    detector = _get_detector()
    if detector is None:
        base_result["error"] = "Detector unavailable"
        return base_result

    try:
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
        detection_result = detector.detect(mp_image)
    except Exception as e:
        base_result["error"] = f"Detection error: {e}"
        return base_result

    if not detection_result.face_landmarks:
        return base_result

    base_result["face_detected"] = True

    # When multiple faces are visible, select primary user (largest face area and centrality)
    primary_idx = 0
    if len(detection_result.face_landmarks) > 1:
        best_score = -1.0
        for idx, face_lms in enumerate(detection_result.face_landmarks):
            xs = [p.x for p in face_lms]
            ys = [p.y for p in face_lms]
            area = (max(xs) - min(xs)) * (max(ys) - min(ys))
            cx = (max(xs) + min(xs)) / 2.0
            cy = (max(ys) + min(ys)) / 2.0
            dist_from_center = np.hypot(cx - 0.5, cy - 0.5)
            score = area * (1.0 - 0.4 * dist_from_center)
            if score > best_score:
                best_score = score
                primary_idx = idx

    lms = detection_result.face_landmarks[primary_idx]

    # 2. Extract Head Pose (using facial transformation matrix or geometric landmarks)
    yaw_deg = 0.0
    pitch_deg = 0.0
    roll_deg = 0.0

    if detection_result.facial_transformation_matrixes and len(detection_result.facial_transformation_matrixes) > primary_idx:
        try:
            mat = np.array(detection_result.facial_transformation_matrixes[primary_idx])
            rot = mat[:3, :3]
            sy = np.sqrt(rot[0, 0] ** 2 + rot[1, 0] ** 2)
            if sy > 1e-6:
                pitch_rad = np.arctan2(rot[2, 1], rot[2, 2])
                yaw_rad = np.arctan2(-rot[2, 0], sy)
                roll_rad = np.arctan2(rot[1, 0], rot[0, 0])
            else:
                pitch_rad = np.arctan2(-rot[1, 2], rot[1, 1])
                yaw_rad = np.arctan2(-rot[2, 0], sy)
                roll_rad = 0.0

            pitch_deg = float(np.degrees(pitch_rad))
            yaw_deg = float(np.degrees(yaw_rad))
            roll_deg = float(np.degrees(roll_rad))
        except Exception:
            pass

    # Landmark geometric fallback if matrix not computed
    if yaw_deg == 0.0 and pitch_deg == 0.0:
        try:
            nose = np.array([lms[1].x, lms[1].y])
            left_eye = np.array([lms[33].x, lms[33].y])
            right_eye = np.array([lms[263].x, lms[263].y])
            chin = np.array([lms[152].x, lms[152].y])
            forehead = np.array([lms[10].x, lms[10].y])

            eye_center = (left_eye + right_eye) / 2.0
            eye_dist = np.linalg.norm(right_eye - left_eye)
            face_height = np.linalg.norm(chin - forehead)

            if eye_dist > 0.01:
                yaw_ratio = (nose[0] - eye_center[0]) / (eye_dist / 2.0)
                yaw_deg = float(np.clip(yaw_ratio * 35.0, -90.0, 90.0))

            if face_height > 0.01:
                vertical_ratio = (nose[1] - eye_center[1]) / face_height
                pitch_deg = float(np.clip((vertical_ratio - 0.35) * 60.0, -90.0, 90.0))
        except Exception:
            pass

    base_result["head_yaw_deg"] = round(yaw_deg, 1)
    base_result["head_pitch_deg"] = round(pitch_deg, 1)
    base_result["head_roll_deg"] = round(roll_deg, 1)

    # 3. Extract Blendshape Metrics
    bs = {}
    if detection_result.face_blendshapes and len(detection_result.face_blendshapes) > primary_idx:
        bs = {b.category_name: b.score for b in detection_result.face_blendshapes[primary_idx]}

    # Eye openness (blink detector)
    eye_blink_left = bs.get("eyeBlinkLeft", 0.0)
    eye_blink_right = bs.get("eyeBlinkRight", 0.0)
    eye_openness = round(1.0 - float((eye_blink_left + eye_blink_right) / 2.0), 2)
    base_result["eye_openness"] = eye_openness

    # Brow furrow (confusion / deep thinking)
    brow_down_left = bs.get("browDownLeft", 0.0)
    brow_down_right = bs.get("browDownRight", 0.0)
    brow_inner_up = bs.get("browInnerUp", 0.0)
    brow_furrow = round(float(max(brow_down_left, brow_down_right, brow_inner_up * 0.7)), 2)
    base_result["brow_furrow_score"] = brow_furrow

    # Smile / positive affect
    smile_left = bs.get("mouthSmileLeft", 0.0)
    smile_right = bs.get("mouthSmileRight", 0.0)
    smile_score = round(float((smile_left + smile_right) / 2.0), 2)
    base_result["smile_score"] = smile_score

    # Mouth open / talking / comprehension check
    jaw_open = bs.get("jawOpen", 0.0)
    base_result["mouth_open_score"] = round(float(jaw_open), 2)

    # 4. Gaze Direction & Eye Contact
    eye_look_in_left = bs.get("eyeLookInLeft", 0.0)
    eye_look_out_left = bs.get("eyeLookOutLeft", 0.0)
    eye_look_up_left = bs.get("eyeLookUpLeft", 0.0)
    eye_look_down_left = bs.get("eyeLookDownLeft", 0.0)

    # Combine head angle + eye pupil shift
    abs_yaw = abs(yaw_deg)
    abs_pitch = abs(pitch_deg)

    if abs_yaw < 16 and abs_pitch < 18:
        gaze = "forward"
        eye_contact = True
    elif yaw_deg > 16 or eye_look_out_left > 0.4:
        gaze = "right"
        eye_contact = False
    elif yaw_deg < -16 or eye_look_in_left > 0.4:
        gaze = "left"
        eye_contact = False
    elif pitch_deg < -18 or eye_look_down_left > 0.4:
        gaze = "down"
        eye_contact = False
    elif pitch_deg > 18 or eye_look_up_left > 0.4:
        gaze = "up"
        eye_contact = False
    else:
        gaze = "forward"
        eye_contact = True

    base_result["gaze_direction"] = gaze
    base_result["eye_contact"] = eye_contact

    # 5. Attention State Classifier
    if eye_contact:
        if brow_furrow > 0.35:
            attention_state = "confused"
        elif jaw_open > 0.3:
            attention_state = "speaking"
        elif smile_score > 0.3:
            attention_state = "engaged_happy"
        else:
            attention_state = "focused"
    elif gaze == "down":
        attention_state = "reading_board"  # looking at notebook or shared whiteboard
    else:
        attention_state = "distracted"

    base_result["attention_state"] = attention_state

    # 6. Continuous Engagement Score (0.0 to 1.0)
    pose_score = max(0.0, 1.0 - (abs_yaw / 35.0) - (abs_pitch / 40.0))
    gaze_weight = 1.0 if eye_contact else (0.75 if gaze == "down" else 0.25)
    openness_weight = min(1.0, eye_openness + 0.2)

    active_bonus = (brow_furrow * 0.15) + (smile_score * 0.1)

    raw_engagement = (pose_score * 0.45) + (gaze_weight * 0.40) + (openness_weight * 0.15) + active_bonus
    engagement_score = round(float(np.clip(raw_engagement, 0.05, 1.0)), 2)
    base_result["engagement_score"] = engagement_score

    if engagement_score >= 0.65:
        base_result["engagement_label"] = "engaged"
    elif engagement_score >= 0.40:
        base_result["engagement_label"] = "neutral"
    else:
        base_result["engagement_label"] = "distracted"

    return base_result
