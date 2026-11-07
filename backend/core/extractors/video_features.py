"""
Video Feature Extractor
=======================
Analyses a single JPEG/PNG video frame (base64 data-URL) and returns
engagement features using MediaPipe Face Landmarker.

Features extracted per frame:
  - face_detected          : bool
  - gaze_direction         : "forward" | "left" | "right" | "down" | "unknown"
  - head_yaw_deg           : horizontal head rotation (positive = right)
  - head_pitch_deg         : vertical head rotation (positive = up)
  - head_roll_deg          : tilt
  - brow_furrow_score      : 0.0–1.0 (higher = more furrowed/concentrated/confused)
  - engagement_score       : 0.0–1.0 composite heuristic
  - engagement_label       : "distracted" | "neutral" | "engaged"
"""

import base64
import logging
import os
import tempfile
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# MediaPipe model is loaded lazily and cached globally
_mp_face_mesh = None
_mp_lock = None


def _get_face_mesh():
    global _mp_face_mesh, _mp_lock
    import threading
    if _mp_lock is None:
        _mp_lock = threading.Lock()
    with _mp_lock:
        if _mp_face_mesh is None:
            try:
                import mediapipe as mp
                _mp_face_mesh = mp.solutions.face_mesh.FaceMesh(
                    static_image_mode=True,
                    max_num_faces=1,
                    refine_landmarks=True,
                    min_detection_confidence=0.5
                )
                logger.info("[video_features] MediaPipe FaceMesh loaded.")
            except Exception as e:
                logger.error(f"[video_features] Failed to load MediaPipe FaceMesh: {e}")
                _mp_face_mesh = None
    return _mp_face_mesh


def extract_video_features(data_url: str) -> dict:
    """
    Args:
        data_url: Base64 data-URL of a JPEG/PNG frame (e.g. 'data:image/jpeg;base64,...')

    Returns:
        Dict with per-frame engagement features.
    """
    base_result = {
        "face_detected": False,
        "gaze_direction": "unknown",
        "head_yaw_deg": None,
        "head_pitch_deg": None,
        "head_roll_deg": None,
        "brow_furrow_score": None,
        "engagement_score": 0.0,
        "engagement_label": "unknown",
    }

    try:
        import cv2
        import mediapipe as mp
    except ImportError as e:
        logger.error(f"[video_features] Missing dependency: {e}")
        base_result["error"] = str(e)
        return base_result

    # ── Decode data-URL ───────────────────────────────────────────────────────
    try:
        if "," in data_url:
            _, b64data = data_url.split(",", 1)
        else:
            b64data = data_url
        img_bytes = base64.b64decode(b64data)
        nparr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            base_result["error"] = "cv2 could not decode image"
            return base_result
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        h, w = frame_rgb.shape[:2]
    except Exception as e:
        base_result["error"] = f"image decode failed: {e}"
        return base_result

    # ── Run FaceMesh ──────────────────────────────────────────────────────────
    face_mesh = _get_face_mesh()
    if face_mesh is None:
        base_result["error"] = "FaceMesh unavailable"
        return base_result

    try:
        results = face_mesh.process(frame_rgb)
    except Exception as e:
        base_result["error"] = f"FaceMesh inference failed: {e}"
        return base_result

    if not results.multi_face_landmarks:
        return base_result  # face_detected stays False

    base_result["face_detected"] = True
    lms = results.multi_face_landmarks[0].landmark

    def lm(idx):
        """Return (x_px, y_px, z_norm) for a landmark index."""
        p = lms[idx]
        return np.array([p.x * w, p.y * h, p.z * w])

    # ── Head pose (solvePnP with 6 canonical points) ──────────────────────────
    try:
        # Canonical 3D model points (generic face model, unit scale)
        model_points_3d = np.array([
            [0.0, 0.0, 0.0],           # Nose tip (1)
            [0.0, -330.0, -65.0],      # Chin (199)
            [-225.0, 170.0, -135.0],   # Left eye left corner (33)
            [225.0, 170.0, -135.0],    # Right eye right corner (263)
            [-150.0, -150.0, -125.0],  # Left mouth corner (61)
            [150.0, -150.0, -125.0],   # Right mouth corner (291)
        ], dtype=np.float64)

        # Matching 2D image points
        image_points_2d = np.array([
            lm(1)[:2],   # nose tip
            lm(199)[:2], # chin
            lm(33)[:2],  # left eye
            lm(263)[:2], # right eye
            lm(61)[:2],  # left mouth
            lm(291)[:2], # right mouth
        ], dtype=np.float64)

        focal = w  # approximate focal length
        cam_matrix = np.array([
            [focal, 0, w / 2],
            [0, focal, h / 2],
            [0, 0, 1]
        ], dtype=np.float64)
        dist_coeffs = np.zeros((4, 1))

        success, rvec, tvec = cv2.solvePnP(
            model_points_3d, image_points_2d, cam_matrix, dist_coeffs,
            flags=cv2.SOLVEPNP_ITERATIVE
        )
        if success:
            rmat, _ = cv2.Rodrigues(rvec)
            proj = np.hstack([rmat, tvec])
            _, _, _, _, _, _, euler = cv2.decomposeProjectionMatrix(proj)
            head_pitch = float(euler[0, 0])
            head_yaw = float(euler[1, 0])
            head_roll = float(euler[2, 0])

            base_result["head_yaw_deg"] = round(head_yaw, 1)
            base_result["head_pitch_deg"] = round(head_pitch, 1)
            base_result["head_roll_deg"] = round(head_roll, 1)

            # Gaze direction from yaw
            if abs(head_yaw) < 15:
                gaze = "forward"
            elif head_yaw > 15:
                gaze = "right"
            elif head_yaw < -15:
                gaze = "left"
            else:
                gaze = "forward"
            if head_pitch < -20:
                gaze = "down"
            base_result["gaze_direction"] = gaze
    except Exception as e:
        logger.debug(f"[video_features] Head pose failed: {e}")

    # ── Brow furrow score ─────────────────────────────────────────────────────
    # Landmarks: inner brow corners (107 left, 336 right) vs forehead centre (10)
    try:
        # Distance between inner brow landmarks (closer = more furrowed)
        left_inner_brow = lm(107)
        right_inner_brow = lm(336)
        brow_distance = float(np.linalg.norm(left_inner_brow[:2] - right_inner_brow[:2]))
        # Normalise by face width (pupils: 33 → 263)
        face_width = float(np.linalg.norm(lm(33)[:2] - lm(263)[:2]))
        if face_width > 0:
            brow_ratio = brow_distance / face_width
            # Typical neutral ≈ 0.35–0.5, furrowed < 0.25
            brow_furrow_score = round(max(0.0, min(1.0, 1.0 - (brow_ratio / 0.5))), 3)
        else:
            brow_furrow_score = 0.0
        base_result["brow_furrow_score"] = brow_furrow_score
    except Exception as e:
        logger.debug(f"[video_features] Brow furrow failed: {e}")

    # ── Composite engagement score ────────────────────────────────────────────
    try:
        gaze_score = 1.0 if base_result["gaze_direction"] == "forward" else 0.3
        yaw = abs(base_result.get("head_yaw_deg") or 0)
        pitch = abs(base_result.get("head_pitch_deg") or 0)
        pose_score = max(0.0, 1.0 - (yaw / 45.0) - (pitch / 45.0))
        # Brow furrow adds engagement signal (attentive concentration)
        furrow = base_result.get("brow_furrow_score") or 0.0
        furrow_bonus = furrow * 0.2

        engagement_score = round(min(1.0, (gaze_score * 0.5 + pose_score * 0.4 + furrow_bonus)), 3)
        base_result["engagement_score"] = engagement_score

        if engagement_score >= 0.65:
            base_result["engagement_label"] = "engaged"
        elif engagement_score >= 0.35:
            base_result["engagement_label"] = "neutral"
        else:
            base_result["engagement_label"] = "distracted"
    except Exception as e:
        logger.debug(f"[video_features] Engagement score failed: {e}")

    return base_result
