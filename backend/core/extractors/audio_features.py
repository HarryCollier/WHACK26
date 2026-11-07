"""
Audio Feature Extractor
=======================
Analyses a WebM audio blob (base64-encoded) and returns a structured dict of
acoustic features that contextualise the speech transcript.

Features extracted:
  - rms_mean / rms_max      : overall loudness signal
  - pitch_mean / pitch_std  : fundamental frequency (F0) via librosa.pyin
  - speaking_rate_wpm       : rough words-per-minute inferred from Whisper segments (optional)
  - pause_count / pause_total_sec : number and total duration of silent gaps (>0.3 s)
  - energy_variance         : how much the energy varies (high = animated, low = monotone)
  - confidence_signal       : "low" | "medium" | "high" – summary label
"""

import base64
import logging
import os
import tempfile
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)


def extract_audio_features(b64_webm: str, whisper_segments: Optional[list] = None) -> dict:
    """
    Args:
        b64_webm: Raw base64 audio blob (WebM/Opus format, no data-URL prefix).
        whisper_segments: Optional list of Whisper segment dicts with 'start','end','text'
                          keys – used to compute accurate speaking rate.

    Returns:
        Dict with acoustic features, or an error dict if extraction fails.
    """
    try:
        import librosa
        import soundfile as sf
    except ImportError as e:
        logger.error(f"[audio_features] Missing dependency: {e}")
        return {"error": str(e), "confidence_signal": "unknown"}

    # ── Write temp WebM file ─────────────────────────────────────────────────
    try:
        audio_bytes = base64.b64decode(b64_webm)
    except Exception as e:
        return {"error": f"base64 decode failed: {e}", "confidence_signal": "unknown"}

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        # ── Load via librosa (uses ffmpeg under the hood) ────────────────────
        try:
            y, sr = librosa.load(tmp_path, sr=16000, mono=True)
        except Exception as e:
            logger.warning(f"[audio_features] librosa.load failed: {e}")
            return {"error": f"audio load failed: {e}", "confidence_signal": "unknown"}

        if len(y) < sr * 0.1:
            # Too short to analyse meaningfully
            return {"error": "audio too short", "confidence_signal": "unknown"}

        # ── RMS energy ───────────────────────────────────────────────────────
        frame_length = 2048
        hop_length = 512
        rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
        rms_mean = float(np.mean(rms))
        rms_max = float(np.max(rms))
        energy_variance = float(np.var(rms))

        # ── Pitch (F0) via pyin ──────────────────────────────────────────────
        try:
            f0, voiced_flag, voiced_probs = librosa.pyin(
                y,
                fmin=librosa.note_to_hz("C2"),
                fmax=librosa.note_to_hz("C7"),
                sr=sr,
                hop_length=hop_length
            )
            voiced_f0 = f0[voiced_flag] if voiced_flag is not None else np.array([])
            pitch_mean = float(np.mean(voiced_f0)) if len(voiced_f0) > 0 else 0.0
            pitch_std = float(np.std(voiced_f0)) if len(voiced_f0) > 0 else 0.0
            voiced_fraction = float(np.mean(voiced_flag)) if voiced_flag is not None else 0.0
        except Exception as e:
            logger.warning(f"[audio_features] pyin failed: {e}")
            pitch_mean, pitch_std, voiced_fraction = 0.0, 0.0, 0.0

        # ── Pause detection (gaps where RMS < threshold for > 0.3 s) ─────────
        rms_threshold = max(rms_mean * 0.15, 1e-5)
        frame_duration = hop_length / sr  # seconds per RMS frame
        pause_min_frames = int(0.3 / frame_duration)

        pauses = []
        in_pause = False
        pause_start = 0
        for i, r in enumerate(rms):
            if r < rms_threshold:
                if not in_pause:
                    in_pause = True
                    pause_start = i
            else:
                if in_pause:
                    pause_len = i - pause_start
                    if pause_len >= pause_min_frames:
                        pauses.append(pause_len * frame_duration)
                    in_pause = False
        # Handle trailing pause
        if in_pause:
            pause_len = len(rms) - pause_start
            if pause_len >= pause_min_frames:
                pauses.append(pause_len * frame_duration)

        pause_count = len(pauses)
        pause_total_sec = round(float(sum(pauses)), 2)

        # ── Speaking rate (WPM) ──────────────────────────────────────────────
        speaking_rate_wpm = None
        if whisper_segments:
            try:
                total_words = sum(len(seg.get("text", "").split()) for seg in whisper_segments)
                total_speech_sec = sum(
                    seg.get("end", 0) - seg.get("start", 0)
                    for seg in whisper_segments
                )
                if total_speech_sec > 0:
                    speaking_rate_wpm = round((total_words / total_speech_sec) * 60, 1)
            except Exception:
                pass

        # ── Confidence signal ────────────────────────────────────────────────
        # Heuristic: low energy + lots of pauses + no voiced fraction → "low"
        if rms_mean < 0.01 or voiced_fraction < 0.1:
            confidence_signal = "low"
        elif rms_mean > 0.05 and voiced_fraction > 0.4 and pause_count < 5:
            confidence_signal = "high"
        else:
            confidence_signal = "medium"

        return {
            "rms_mean": round(rms_mean, 5),
            "rms_max": round(rms_max, 5),
            "energy_variance": round(energy_variance, 8),
            "pitch_mean_hz": round(pitch_mean, 1),
            "pitch_std_hz": round(pitch_std, 1),
            "voiced_fraction": round(voiced_fraction, 3),
            "pause_count": pause_count,
            "pause_total_sec": pause_total_sec,
            "speaking_rate_wpm": speaking_rate_wpm,
            "confidence_signal": confidence_signal,
        }

    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
