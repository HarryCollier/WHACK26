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
    #    Includes per-snapshot deltas so the LLM can see when big edits happened,
    #    plus role-tagged contribution breakdown and current snapshot for visual inspection.
    # ──────────────────────────────────────────────────────────────────────────
    whiteboard_telemetry = {
        "total_snapshots": len(store.all_whiteboards_history) + (1 if store.most_recent_whiteboard else 0),
        "has_current": store.most_recent_whiteboard is not None,
        "delta_history": store.whiteboard_deltas,
        "summary": _summarise_whiteboard_deltas(store.whiteboard_deltas),
        "student_edits": getattr(store, "student_whiteboard_edit_count", 0),
        "tutor_edits": getattr(store, "tutor_whiteboard_edit_count", 0),
        "recent_elements_log": getattr(store, "whiteboard_elements_log", [])[-15:],
        "current_data_url": store.most_recent_whiteboard.get("dataUrl") if store.most_recent_whiteboard else None,
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

    lines += ["", "--- WHITEBOARD ACTIVITY & PUPIL CONTRIBUTIONS ---"]
    ws = whiteboard_telemetry
    lines.append(f"  Total snapshots : {ws.get('total_snapshots', 0)}")
    lines.append(f"  Student edits   : {ws.get('student_edits', 0)}")
    lines.append(f"  Tutor edits     : {ws.get('tutor_edits', 0)}")
    if ws.get("current_data_url"):
        lines.append("  Visual Status   : [Whiteboard snapshot image is attached, auto-framed on the active problem. COLOR CODING: Black=Tutor prompts/questions, Green=Pupil answers/work. Attribute questions to tutor and answers to pupil.]")
    summ = ws.get("summary", {})
    lines.append(f"  Major edits     : {summ.get('major_edits', 0)}")
    lines.append(f"  Idle snapshots  : {summ.get('idle_snapshots', 0)}")
    avg_chg = summ.get("avg_change_percent")
    if avg_chg is not None:
        lines.append(f"  Avg change/snap : {avg_chg:.1f}%")
    if ws.get("recent_elements_log"):
        lines.append("  Recent element actions:")
        for el in ws["recent_elements_log"][-8:]:
            r = el.get("role", "unknown").upper()
            act = el.get("action", "action")
            etype = el.get("element_type") or el.get("tool") or "stroke"
            txt = f" text=\"{el.get('text')}\"" if el.get("text") else ""
            lines.append(f"    [{r}] {act} {etype}{txt}")
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


def get_rolling_engagement(store: "RoomSessionStore", window_seconds: int = 6) -> dict:
    """
    Computes a deterministic, real-time engagement indicator and rolling mode
    facial expression for the tutor based on video telemetry.
    Defaults to a 6-second window with majority detection (>50% of frames)
    for facial confusion (brow furrow) and distraction.
    """
    student_frames = store.video_frame_features.get("student", [])
    # Solo / testing fallback: if no student frames yet, use tutor frames so testing works in 1 browser
    if not student_frames and store.video_frame_features.get("tutor"):
        student_frames = store.video_frame_features.get("tutor", [])

    now_ms = int(time.time() * 1000)

    # 1. Filter frames in the recent window (e.g. 6 seconds)
    if student_frames:
        latest_ts = max(f.get("timestamp_ms", 0) for f in student_frames)
        cutoff_ts = max(0, latest_ts - window_seconds * 1000)
        recent_frames = [f for f in student_frames if f.get("timestamp_ms", 0) >= cutoff_ts]
        if not recent_frames:
            recent_frames = student_frames[-max(4, window_seconds * 2):]
    else:
        recent_frames = []

    # 2. Analyze faces & engagement
    faces = [f for f in recent_frames if f.get("face_detected")]

    if not recent_frames or not faces:
        has_raw_frames = len(store.video_frames.get("student", [])) > 0 or len(store.video_frames.get("tutor", [])) > 0
        return {
            "engagement_score": 0,
            "status_label": "No Student Face Detected" if has_raw_frames else "Waiting for Student Video",
            "status_color": "gray",
            "attention_state": "no_face",
            "mode_expression": "no_face",
            "mode_color": "gray",
            "mode_label": "No Face Detected",
            "mode_frequency_pct": 0,
            "instant_expression": "no_face",
            "instant_color": "gray",
            "instant_label": "No Face",
            "student_face_detected": False,
            "has_raw_frames": has_raw_frames,
            "brow_furrow_level": 0.0,
            "gaze_direction": "unknown",
            "actionable_hint": "Check if student camera is enabled and visible.",
            "pacing": _get_talk_time_pacing(store),
            "timestamp_ms": now_ms,
            "window_seconds": window_seconds,
            "confused_count": 0,
            "distracted_count": 0,
            "total_faces": 0,
            "confused_pct": 0.0,
            "distracted_pct": 0.0,
            "is_majority_confused": False,
            "is_majority_distracted": False,
        }

    # Scores
    scores = [f["engagement_score"] for f in faces if f.get("engagement_score") is not None]
    avg_score = _safe_mean(scores) if scores else 0.5
    furrows = [f.get("brow_furrow_score", 0) for f in faces]
    avg_furrow = _safe_mean(furrows) or 0.0

    # 3. Categorize individual facial expressions for mode calculation
    # Brow furrow is in the same box as confusion: furrow > 0.35 or att in ("confused", "confused_furrow")
    # Categories: "confused" | "engaged" | "distracted" | "listening"
    expression_counts = {"confused": 0, "engaged": 0, "distracted": 0, "listening": 0}
    for f in faces:
        att = f.get("attention_state", "")
        furrow = f.get("brow_furrow_score", 0.0)
        smile = f.get("smile_score", 0.0)
        gaze = f.get("gaze_direction", "forward")
        eye_contact = f.get("eye_contact", True)

        if furrow > 0.35 or att in ("confused", "confused_furrow"):
            expression_counts["confused"] += 1
        elif smile > 0.25 or att == "engaged_happy":
            expression_counts["engaged"] += 1
        elif (gaze not in ("screen", "forward", "unknown") and not eye_contact) or att == "distracted":
            expression_counts["distracted"] += 1
        else:
            expression_counts["listening"] += 1

    num_faces = len(faces)
    confused_count = expression_counts["confused"]
    distracted_count = expression_counts["distracted"]
    confused_pct = round(100.0 * confused_count / num_faces, 1) if num_faces > 0 else 0.0
    distracted_pct = round(100.0 * distracted_count / num_faces, 1) if num_faces > 0 else 0.0

    # Majority calculation: strictly > 50% over window (requires at least 2 frames)
    is_majority_confused = (confused_count / num_faces > 0.50) if num_faces >= 2 else False
    is_majority_distracted = (distracted_count / num_faces > 0.50) if num_faces >= 2 else False

    # Combined majority check: if total off-track (confusion + distracted) > 50%, attribute to dominant cue
    if not is_majority_confused and not is_majority_distracted and num_faces >= 2:
        if (confused_count + distracted_count) / num_faces > 0.50:
            if confused_count >= distracted_count:
                is_majority_confused = True
            else:
                is_majority_distracted = True

    # Statistical Mode: most frequent expression over the window
    mode_expression = max(expression_counts, key=expression_counts.get)
    mode_frequency_pct = round(100.0 * expression_counts[mode_expression] / len(faces)) if faces else 0

    mode_metadata = {
        "confused": {
            "color": "red",
            "label": "Confused (Brow Furrow)",
            "description": "Student showing brow furrow / puzzlement"
        },
        "engaged": {
            "color": "green",
            "label": "Engaged & Attentive",
            "description": "Attentive, smiling, focused on lesson"
        },
        "distracted": {
            "color": "yellow",
            "label": "Looking Away",
            "description": "Gaze off-screen / looking away"
        },
        "listening": {
            "color": "blue",
            "label": "Listening / Neutral",
            "description": "Calm, neutral listening posture"
        }
    }.get(mode_expression, {
        "color": "blue",
        "label": "Listening / Neutral",
        "description": "Calm listening state"
    })

    # 4. Instantaneous expression (latest frame) for zero-lag reactivity
    latest_face = faces[-1]
    latest_furrow = latest_face.get("brow_furrow_score", 0.0)
    latest_smile = latest_face.get("smile_score", 0.0)
    latest_gaze = latest_face.get("gaze_direction", "forward")
    latest_contact = latest_face.get("eye_contact", True)
    latest_att = latest_face.get("attention_state", "")

    if latest_furrow >= 0.35 or latest_att in ("confused", "confused_furrow"):
        instant_expression = "confused"
        instant_color = "red"
        instant_label = "Confused / Brow Furrow"
    elif latest_smile >= 0.25 or latest_att == "engaged_happy":
        instant_expression = "engaged"
        instant_color = "green"
        instant_label = "Engaged & Smiling"
    elif latest_gaze not in ("screen", "forward", "unknown") and not latest_contact:
        instant_expression = "distracted"
        instant_color = "yellow"
        instant_label = "Looking Away"
    else:
        instant_expression = "listening"
        instant_color = "blue"
        instant_label = "Listening / Neutral"

    # Fast-attack priority for current status:
    # If student is actively writing on whiteboard, highlight that.
    recent_student_actions = [
        el for el in getattr(store, "whiteboard_elements_log", [])
        if el.get("role") == "student" and (now_ms - el.get("timestamp", 0)) <= window_seconds * 1000
    ]
    student_wb_edits = getattr(store, "student_whiteboard_edit_count", 0)
    student_wb_active = len(recent_student_actions) > 0

    # Majority states have priority for status label; instant changes provide zero-lag hints
    if is_majority_confused:
        status_label = "Student Confused (Majority)"
        status_color = "red"
        attention_state = "confused"
        hint = "Majority brow furrow/confusion detected over last 6s. Check in or offer a stepping stone."
    elif is_majority_distracted:
        status_label = "Student Looking Away (Majority)"
        status_color = "yellow"
        attention_state = "distracted"
        hint = "Student attention is off-screen for majority of last 6s. Prompt them to engage with the whiteboard."
    elif instant_expression == "confused" or expression_counts["confused"] / len(faces) >= 0.20 or avg_furrow > 0.35:
        status_label = "Student May Be Confused"
        status_color = "red"
        attention_state = "confused"
        hint = "Elevated brow furrow detected. Check in or offer a stepping stone."
    elif instant_expression == "distracted" and (expression_counts["distracted"] / len(faces) >= 0.25 or avg_score < 0.40):
        status_label = "Student Looking Away"
        status_color = "yellow"
        attention_state = "distracted"
        hint = "Student attention is off-screen. Prompt them to engage with the whiteboard."
    elif instant_expression == "engaged" or avg_score >= 0.65:
        status_label = "Attentive & Engaged"
        status_color = "green"
        attention_state = "attentive"
        hint = "Student is focused on the screen. Great pacing."
    elif student_wb_active:
        status_label = "Student Writing on Whiteboard"
        status_color = "green"
        attention_state = "attentive"
        hint = "Pupil is actively contributing to the whiteboard in response to the session."
    else:
        status_label = "Listening / Neutral"
        status_color = "blue"
        attention_state = "listening"
        hint = "Ask an open-ended question to boost participation."

    return {
        "engagement_score": round(avg_score * 100),
        "status_label": status_label,
        "status_color": status_color,
        "attention_state": attention_state,
        # Rolling Mode Expression (Statistical Mode over window)
        "mode_expression": mode_expression,
        "mode_color": mode_metadata["color"],
        "mode_label": mode_metadata["label"],
        "mode_description": mode_metadata["description"],
        "mode_frequency_pct": mode_frequency_pct,
        # Instantaneous expression (zero-lag reaction)
        "instant_expression": instant_expression,
        "instant_color": instant_color,
        "instant_label": instant_label,
        "student_face_detected": True,
        "has_raw_frames": True,
        "brow_furrow_level": round(avg_furrow, 2),
        "gaze_direction": latest_gaze,
        "student_wb_active": len(recent_student_actions) > 0,
        "student_total_wb_edits": student_wb_edits,
        "actionable_hint": hint,
        "pacing": _get_talk_time_pacing(store),
        "timestamp_ms": now_ms,
        "window_seconds": window_seconds,
        "confused_count": confused_count,
        "distracted_count": distracted_count,
        "total_faces": num_faces,
        "confused_pct": confused_pct,
        "distracted_pct": distracted_pct,
        "is_majority_confused": is_majority_confused,
        "is_majority_distracted": is_majority_distracted,
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

