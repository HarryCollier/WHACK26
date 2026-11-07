"""
Telemetry Aggregator
====================
Builds a structured LLM-ready JSON payload from a live RoomSessionStore.

The payload is a "session snapshot" containing:

  1. dialogue_timeline  – every transcript entry with acoustic features attached
  2. video_telemetry    – per-role engagement summary across all captured frames
  3. whiteboard_telemetry – whiteboard activity summary
  4. session_meta       – room code, duration, peer count

This is designed to be passed directly into an LLM prompt as the
"what happened in this session" block.
"""

import logging
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .session_store import RoomSessionStore

logger = logging.getLogger(__name__)


def _safe_mean(values):
    return round(sum(values) / len(values), 3) if values else None


def build_telemetry_payload(store: "RoomSessionStore") -> dict:
    """
    Builds the full LLM-ready telemetry payload from the current state of a
    RoomSessionStore.  Runs synchronously – call this from a view, not the
    hot audio/video ingest path.

    Returns a JSON-serialisable dict.
    """

    # ──────────────────────────────────────────────────────────────────────────
    # 1. DIALOGUE TIMELINE
    #    Whisper transcript entries ordered by timestamp.
    #    Each entry includes role, timestamp (ms since epoch), and speech text.
    #    Acoustic features are attached if any audio chunks overlapping that
    #    timestamp have already been analysed.
    # ──────────────────────────────────────────────────────────────────────────
    dialogue_timeline = []
    for t in sorted(store.transcripts, key=lambda x: x.timestamp):
        entry = {
            "timestamp_ms": t.timestamp,
            "time_label": _ms_to_label(t.timestamp, store),
            "role": t.role,
            "speech": t.text,
            "acoustic_features": store.audio_features_by_chunk.get(t.timestamp),
        }
        dialogue_timeline.append(entry)

    # ──────────────────────────────────────────────────────────────────────────
    # 2. VIDEO TELEMETRY
    #    For each role, sample recent frames and return:
    #      - total frames captured
    #      - engagement trend over time (every ~10th frame to keep payload small)
    #      - averaged engagement score
    #      - most common gaze direction
    #      - average head pose
    # ──────────────────────────────────────────────────────────────────────────
    video_telemetry = {}
    for role in ("tutor", "student"):
        frames = store.video_frame_features.get(role, [])
        if not frames:
            video_telemetry[role] = {
                "frames_captured": len(store.video_frames.get(role, [])),
                "frames_analysed": 0,
                "engagement_avg": None,
                "engagement_trend": [],
                "gaze_summary": {},
                "head_yaw_avg": None,
                "head_pitch_avg": None,
                "brow_furrow_avg": None,
            }
            continue

        frames_with_face = [f for f in frames if f.get("face_detected")]
        if frames_with_face:
            engagement_scores = [f["engagement_score"] for f in frames_with_face if f.get("engagement_score") is not None]
        else:
            engagement_scores = [f["engagement_score"] for f in frames if f.get("engagement_score") is not None]

        gazes = [f["gaze_direction"] for f in frames if f.get("gaze_direction") and f["gaze_direction"] != "unknown"]
        yaws = [f["head_yaw_deg"] for f in frames if f.get("head_yaw_deg") is not None]
        pitches = [f["head_pitch_deg"] for f in frames if f.get("head_pitch_deg") is not None]
        furrows = [f["brow_furrow_score"] for f in frames if f.get("brow_furrow_score") is not None]
        smiles = [f["smile_score"] for f in frames if f.get("smile_score") is not None]
        eye_openness = [f["eye_openness"] for f in frames if f.get("eye_openness") is not None]
        mouth_open = [f["mouth_open_score"] for f in frames if f.get("mouth_open_score") is not None]

        # Thin trend: 1 data point per ~5 frames for the LLM context
        stride = max(1, len(frames) // 25)
        trend = [
            {
                "timestamp_ms": frames[i].get("timestamp_ms"),
                "engagement_score": frames[i].get("engagement_score"),
                "gaze": frames[i].get("gaze_direction"),
                "engagement_label": frames[i].get("engagement_label"),
                "attention_state": frames[i].get("attention_state"),
                "brow_furrow": frames[i].get("brow_furrow_score"),
                "smile": frames[i].get("smile_score"),
            }
            for i in range(0, len(frames), stride)
        ]

        # Gaze frequency summary
        gaze_counts = {}
        for g in gazes:
            gaze_counts[g] = gaze_counts.get(g, 0) + 1

        # Attention states distribution
        attention_counts = {}
        for f in frames:
            att = f.get("attention_state", "unknown")
            attention_counts[att] = attention_counts.get(att, 0) + 1

        recent_state = frames[-1].get("attention_state") if frames else "unknown"

        video_telemetry[role] = {
            "frames_captured": len(store.video_frames.get(role, [])),
            "frames_analysed": len(frames),
            "engagement_avg": _safe_mean(engagement_scores),
            "current_attention": recent_state,
            "engagement_trend": trend,
            "gaze_summary": gaze_counts,
            "attention_summary": attention_counts,
            "head_yaw_avg": _safe_mean(yaws),
            "head_pitch_avg": _safe_mean(pitches),
            "brow_furrow_avg": _safe_mean(furrows),
            "smile_avg": _safe_mean(smiles),
            "eye_openness_avg": _safe_mean(eye_openness),
            "mouth_open_avg": _safe_mean(mouth_open),
        }

    # ──────────────────────────────────────────────────────────────────────────
    # 3. WHITEBOARD TELEMETRY
    #    Summary of whiteboard activity across the whole session.
    #    Includes per-snapshot deltas so the LLM can see when big edits happened.
    # ──────────────────────────────────────────────────────────────────────────
    whiteboard_telemetry = {
        "total_snapshots": len(store.all_whiteboards_history) + (1 if store.most_recent_whiteboard else 0),
        "has_current": store.most_recent_whiteboard is not None,
        "delta_history": store.whiteboard_deltas,
        "summary": _summarise_whiteboard_deltas(store.whiteboard_deltas),
    }

    # ──────────────────────────────────────────────────────────────────────────
    # 4. SESSION META
    # ──────────────────────────────────────────────────────────────────────────
    all_timestamps = [t.timestamp for t in store.transcripts]
    if all_timestamps:
        session_duration_ms = max(all_timestamps) - min(all_timestamps)
    else:
        session_duration_ms = 0

    # ──────────────────────────────────────────────────────────────────────────
    # 5. LLM PROMPT CONTEXT BLOCK
    #    A human-readable summary prompt suitable for prepending to an LLM call.
    # ──────────────────────────────────────────────────────────────────────────
    prompt_context = _build_prompt_context(
        dialogue_timeline, video_telemetry, whiteboard_telemetry, store
    )

    return {
        "room_code": store.room_code,
        "session_duration_ms": session_duration_ms,
        "session_duration_label": _ms_to_duration_label(session_duration_ms),
        "active_peers": list(store.active_peers),
        "dialogue_timeline": dialogue_timeline,
        "video_telemetry": video_telemetry,
        "whiteboard_telemetry": whiteboard_telemetry,
        "llm_prompt_context": prompt_context,
        "generated_at_ms": int(time.time() * 1000),
    }


def _ms_to_label(ts_ms: int, store: "RoomSessionStore") -> str:
    """Convert an absolute timestamp to 'MM:SS into session' label."""
    all_ts = [t.timestamp for t in store.transcripts]
    if not all_ts or ts_ms is None:
        return "00:00"
    session_start = min(all_ts)
    elapsed_s = max(0, (ts_ms - session_start) // 1000)
    return f"{elapsed_s // 60:02d}:{elapsed_s % 60:02d}"


def _ms_to_duration_label(ms: int) -> str:
    s = ms // 1000
    return f"{s // 60}m {s % 60}s"


def _summarise_whiteboard_deltas(deltas: list) -> dict:
    if not deltas:
        return {"total_changes": 0, "major_edits": 0, "idle_snapshots": 0}
    major = sum(1 for d in deltas if d.get("change_level") in ("major", "moderate"))
    idle = sum(1 for d in deltas if d.get("change_level") == "none")
    avg_change = _safe_mean([d.get("change_percent", 0) for d in deltas])
    return {
        "total_changes": len(deltas),
        "major_edits": major,
        "idle_snapshots": idle,
        "avg_change_percent": avg_change,
    }


def _build_prompt_context(dialogue_timeline, video_telemetry, whiteboard_telemetry, store) -> str:
    """
    Returns a human-readable block describing session data, ready for an LLM.
    """
    lines = [
        f"=== TUTORING SESSION DATA (Room {store.room_code}) ===",
        "",
        "--- DIALOGUE TIMELINE ---",
    ]

    if not dialogue_timeline:
        lines.append("No speech recorded in this session.")
    else:
        for entry in dialogue_timeline:
            role = entry["role"].upper()
            t = entry.get("time_label", "??:??")
            speech = entry["speech"]
            acoustic = entry.get("acoustic_features")
            acoustic_str = ""
            if acoustic and not acoustic.get("error"):
                parts = []
                if acoustic.get("pitch_mean_hz"):
                    parts.append(f"pitch={acoustic['pitch_mean_hz']:.0f}Hz")
                if acoustic.get("energy_variance") is not None:
                    parts.append(f"energy_var={acoustic['energy_variance']:.2e}")
                if acoustic.get("pause_count") is not None:
                    parts.append(f"pauses={acoustic['pause_count']}")
                if acoustic.get("confidence_signal"):
                    parts.append(f"conf={acoustic['confidence_signal']}")
                if parts:
                    acoustic_str = f" [{', '.join(parts)}]"
            lines.append(f"  [{t}] {role}: \"{speech}\"{acoustic_str}")

    lines += ["", "--- VIDEO / ENGAGEMENT TELEMETRY ---"]
    for role in ("tutor", "student"):
        vt = video_telemetry.get(role, {})
        lines.append(f"  {role.upper()}:")
        lines.append(f"    Frames captured : {vt.get('frames_captured', 0)}")
        lines.append(f"    Frames analysed : {vt.get('frames_analysed', 0)}")
        avg_eng = vt.get("engagement_avg")
        lines.append(f"    Avg engagement  : {avg_eng:.2f}" if avg_eng is not None else "    Avg engagement  : N/A")
        gaze = vt.get("gaze_summary", {})
        if gaze:
            gaze_str = ", ".join(f"{k}={v}" for k, v in sorted(gaze.items(), key=lambda x: -x[1]))
            lines.append(f"    Gaze distribution: {gaze_str}")
        yaw = vt.get("head_yaw_avg")
        pitch = vt.get("head_pitch_avg")
        if yaw is not None:
            lines.append(f"    Avg head pose   : yaw={yaw:.1f}° pitch={pitch:.1f}°")
        furrow = vt.get("brow_furrow_avg")
        if furrow is not None:
            lines.append(f"    Avg brow furrow : {furrow:.2f}")
        # Trend excerpt (up to 5 points)
        trend = vt.get("engagement_trend", [])
        if trend:
            lines.append(f"    Engagement trend (sample):")
            for point in trend[:5]:
                ts = point.get("timestamp_ms", "?")
                sc = point.get("engagement_score")
                lbl = point.get("engagement_label", "")
                gz = point.get("gaze", "")
                lines.append(f"      t={ts}ms  score={sc}  label={lbl}  gaze={gz}")

    lines += ["", "--- WHITEBOARD ACTIVITY ---"]
    ws = whiteboard_telemetry
    lines.append(f"  Total snapshots : {ws.get('total_snapshots', 0)}")
    summ = ws.get("summary", {})
    lines.append(f"  Major edits     : {summ.get('major_edits', 0)}")
    lines.append(f"  Idle snapshots  : {summ.get('idle_snapshots', 0)}")
    avg_chg = summ.get("avg_change_percent")
    if avg_chg is not None:
        lines.append(f"  Avg change/snap : {avg_chg:.1f}%")
    if ws.get("delta_history"):
        lines.append("  Delta log (most recent 5):")
        for d in ws["delta_history"][-5:]:
            ts = d.get("current_timestamp", "?")
            lvl = d.get("change_level", "?")
            pct = d.get("change_percent", 0)
            region = d.get("dominant_change_region", "-")
            lines.append(f"    t={ts}ms  level={lvl}  change={pct:.1f}%  region={region}")

    lines += [
        "",
        "=== END OF SESSION DATA ===",
        "",
        "Using the above data, provide coaching advice for the tutor.",
    ]

    return "\n".join(lines)


def get_rolling_engagement(store: "RoomSessionStore", window_seconds: int = 15) -> dict:
    """
    Computes a deterministic, real-time engagement indicator for the tutor
    based on the student's telemetry over the last `window_seconds`.
    """
    student_frames = store.video_frame_features.get("student", [])
    now_ms = int(time.time() * 1000)

    # 1. Filter frames in the recent window
    if student_frames:
        latest_ts = max(f.get("timestamp_ms", 0) for f in student_frames)
        cutoff_ts = max(0, latest_ts - window_seconds * 1000)
        recent_frames = [f for f in student_frames if f.get("timestamp_ms", 0) >= cutoff_ts]
        if not recent_frames:
            recent_frames = student_frames[-10:]
    else:
        recent_frames = []

    # 2. Analyze faces & engagement
    faces = [f for f in recent_frames if f.get("face_detected")]

    if not recent_frames or not faces:
        has_raw_frames = len(store.video_frames.get("student", [])) > 0
        return {
            "engagement_score": 0,
            "status_label": "No Student Face Detected" if has_raw_frames else "Waiting for Student Video",
            "status_color": "gray",
            "attention_state": "no_face",
            "student_face_detected": False,
            "brow_furrow_level": 0.0,
            "gaze_direction": "unknown",
            "actionable_hint": "Check if student camera is enabled and visible.",
            "pacing": _get_talk_time_pacing(store),
            "timestamp_ms": now_ms
        }

    # Scores
    scores = [f["engagement_score"] for f in faces if f.get("engagement_score") is not None]
    avg_score = _safe_mean(scores) if scores else 0.5
    furrows = [f.get("brow_furrow_score", 0) for f in faces]
    avg_furrow = _safe_mean(furrows) or 0.0

    # Count attention states
    confused_count = sum(1 for f in faces if f.get("attention_state") == "confused_furrow" or f.get("brow_furrow_score", 0) > 0.40)
    away_count = sum(1 for f in faces if f.get("gaze_direction") not in ("screen", "unknown"))

    pct_confused = confused_count / len(faces)
    pct_away = away_count / len(faces)

    recent_gaze = faces[-1].get("gaze_direction", "screen")

    # Determine status & badge
    if pct_confused >= 0.35 or avg_furrow > 0.45:
        status_label = "Student May Be Confused"
        status_color = "red"
        attention_state = "confused"
        hint = "Elevated brow furrow detected. Pause and ask a check-in question."
    elif pct_away >= 0.45 or avg_score < 0.40:
        status_label = "Student Looking Away"
        status_color = "yellow"
        attention_state = "distracted"
        hint = "Student attention is off-screen. Prompt them to engage with the whiteboard."
    elif avg_score >= 0.65:
        status_label = "Attentive & Engaged"
        status_color = "green"
        attention_state = "attentive"
        hint = "Student is focused on the screen. Great pacing."
    else:
        status_label = "Moderate Attention"
        status_color = "yellow"
        attention_state = "moderate"
        hint = "Ask an open-ended question to boost participation."

    return {
        "engagement_score": round(avg_score * 100),
        "status_label": status_label,
        "status_color": status_color,
        "attention_state": attention_state,
        "student_face_detected": True,
        "brow_furrow_level": round(avg_furrow, 2),
        "gaze_direction": recent_gaze,
        "actionable_hint": hint,
        "pacing": _get_talk_time_pacing(store),
        "timestamp_ms": now_ms
    }


def _get_talk_time_pacing(store: "RoomSessionStore") -> dict:
    tutor_words = sum(len(t.text.split()) for t in store.transcripts if t.role == "tutor")
    student_words = sum(len(t.text.split()) for t in store.transcripts if t.role == "student")
    total_words = tutor_words + student_words
    if total_words > 0:
        tutor_pct = round(100 * tutor_words / total_words)
        student_pct = 100 - tutor_pct
    else:
        tutor_pct = 50
        student_pct = 50
    return {
        "tutor_talk_pct": tutor_pct,
        "student_talk_pct": student_pct,
        "total_words": total_words
    }

