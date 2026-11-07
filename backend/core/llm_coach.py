"""
LLM Pedagogical Coaching Service
=================================
Connects multimodal telemetry to an LLM for real-time tutoring feedback.
Supports:
  1. Google Gemini (Gemini 2.0 Flash / 1.5 Flash via REST)
  2. OpenAI (GPT-4o-mini via REST)
  3. Ollama (Local Llama 3.1 / Qwen via REST)
  4. Heuristic Fallback Engine (computes data-driven feedback directly from metrics if no key is set)

Uses Python's standard library (urllib.request) for zero extra dependencies.
"""

import os
import json
import time
import logging
import urllib.request
import urllib.error
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

# Default provider configurations (can be overridden via environment variables or Django settings)
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_OLLAMA_MODEL = "llama3.1"
DEFAULT_OLLAMA_URL = "http://localhost:11434"

COACH_SYSTEM_PROMPT = """You are an expert pedagogical tutoring coach analyzing a live tutoring session.
You are given a multimodal session snapshot containing:
1. Transcript dialogue with timestamps for Tutor and Student.
2. Acoustic signals (speech energy, pitch, hesitation, pause count).
3. Student facial engagement and attention states (gaze direction, brow furrow confusion spikes, head pose).
4. Whiteboard activity and delta changes.

Your job is to provide concise, empathetic, highly actionable coaching advice for the human TUTOR.
Evaluate:
- Pacing & dialogue balance (Is the tutor monologuing? Is the student participating?).
- Comprehension & friction points (Correlate student brow furrow or silence with what was being discussed).
- Whiteboard usage (Are abstract ideas backed up by visual sketches?).

You MUST respond ONLY with a valid JSON object matching this exact schema:
{
  "summary": "2-3 sentences summarizing current dynamic and learning flow",
  "comprehension_rating": "High" | "Moderate" | "Needs Attention",
  "comprehension_score": 0 to 100,
  "pacing": {
    "tutor_talk_pct": 0 to 100,
    "student_talk_pct": 0 to 100,
    "status": "Balanced" | "Tutor-Heavy" | "Student-Led",
    "advice": "1 clear sentence on pacing"
  },
  "friction_points": [
    {
      "time_label": "MM:SS",
      "observation": "brief description of confusion/hesitation moment",
      "recommendation": "specific pedagogical question or check for the tutor"
    }
  ],
  "whiteboard_feedback": "1-2 sentences on whiteboard usage and how to improve it",
  "actionable_tips": [
    "Tip 1 for immediate tutor action",
    "Tip 2 for immediate tutor action"
  ]
}
"""


def _load_env_file():
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", ".env"),
        os.path.join(os.path.dirname(__file__), "..", "..", ".env"),
        os.path.join(os.getcwd(), ".env"),
        os.path.join(os.getcwd(), "backend", ".env")
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip("'\"")
                            if k and k not in os.environ:
                                os.environ[k] = v
            except Exception:
                pass


def generate_coaching_report(telemetry_payload: Dict[str, Any], api_key: Optional[str] = None, provider_override: Optional[str] = None) -> Dict[str, Any]:
    """
    Main entry point: Generates a coaching report from a telemetry payload.
    Automatically detects configured provider (Gemini, OpenAI, Ollama) or falls back
    to the heuristic data-driven engine.
    """
    _load_env_file()
    provider = provider_override or os.environ.get("LLM_PROVIDER", "auto").lower()
    gemini_key = api_key or os.environ.get("GEMINI_API_KEY", "").strip()
    openai_key = api_key or os.environ.get("OPENAI_API_KEY", "").strip()

    # Determine provider if set to 'auto'
    if provider == "auto":
        if gemini_key:
            provider = "gemini"
        elif openai_key:
            provider = "openai"
        elif os.environ.get("OLLAMA_ENABLED", "").lower() in ("true", "1"):
            provider = "ollama"
        else:
            provider = "heuristic"

    logger.info(f"Generating coaching report using provider: {provider}")

    prompt_context = telemetry_payload.get("llm_prompt_context", "")

    report = None
    provider_used = provider

    try:
        if provider == "gemini" and gemini_key:
            report = _call_gemini(prompt_context, gemini_key)
        elif provider == "openai" and openai_key:
            report = _call_openai(prompt_context, openai_key)
        elif provider == "ollama":
            report = _call_ollama(prompt_context)
    except Exception as e:
        logger.warning(f"LLM provider '{provider}' failed ({e}). Falling back to Heuristic Engine.")
        provider_used = f"heuristic (fallback from {provider})"

    if not report:
        report = _generate_heuristic_report(telemetry_payload)
        if provider_used == provider and provider != "heuristic":
            provider_used = "heuristic"

    report["provider_used"] = provider_used
    report["generated_at_ms"] = int(time.time() * 1000)
    return report


def _call_gemini(prompt_context: str, api_key: str) -> Dict[str, Any]:
    configured_model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()
    candidate_models = [configured_model]
    for fallback in ["gemini-3.5-flash-lite", "gemini-3-flash-preview", "gemini-flash-latest"]:
        if fallback not in candidate_models:
            candidate_models.append(fallback)

    last_err = None
    for model in candidate_models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

        full_prompt = f"{COACH_SYSTEM_PROMPT}\n\nHere is the current live session data:\n\n{prompt_context}"

        req_data = {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": full_prompt}]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0.3
            }
        }

        req = urllib.request.Request(
            url,
            data=json.dumps(req_data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=14) as response:
                result = json.loads(response.read().decode("utf-8"))
                candidates = result.get("candidates", [])
                if candidates and "content" in candidates[0]:
                    parts = candidates[0]["content"].get("parts", [])
                    if parts and "text" in parts[0]:
                        return _clean_and_parse_json(parts[0]["text"])
        except urllib.error.HTTPError as err:
            last_err = err
            logger.warning(f"Gemini model '{model}' failed with status {err.code}. Trying next candidate...")
            continue
        except Exception as e:
            last_err = e
            logger.warning(f"Gemini model '{model}' encountered error: {e}. Trying next candidate...")
            continue

    if last_err:
        raise last_err
    raise ValueError("Empty or invalid response from Gemini API")


def _call_openai(prompt_context: str, api_key: str) -> Dict[str, Any]:
    model = os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
    url = "https://api.openai.com/v1/chat/completions"

    full_prompt = f"Here is the current live session data:\n\n{prompt_context}"

    req_data = {
        "model": model,
        "messages": [
            {"role": "system", "content": COACH_SYSTEM_PROMPT},
            {"role": "user", "content": full_prompt}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.3
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(req_data).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        },
        method="POST"
    )

    with urllib.request.urlopen(req, timeout=12) as response:
        result = json.loads(response.read().decode("utf-8"))
        choices = result.get("choices", [])
        if choices and "message" in choices[0]:
            content_str = choices[0]["message"].get("content", "")
            return _clean_and_parse_json(content_str)

    raise ValueError("Empty or invalid response from OpenAI API")


def _call_ollama(prompt_context: str) -> Dict[str, Any]:
    base_url = os.environ.get("OLLAMA_BASE_URL", DEFAULT_OLLAMA_URL)
    model = os.environ.get("OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL)
    url = f"{base_url.rstrip('/')}/v1/chat/completions"

    full_prompt = f"Here is the current live session data:\n\n{prompt_context}"

    req_data = {
        "model": model,
        "messages": [
            {"role": "system", "content": COACH_SYSTEM_PROMPT},
            {"role": "user", "content": full_prompt}
        ],
        "format": "json",
        "temperature": 0.3
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(req_data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    with urllib.request.urlopen(req, timeout=20) as response:
        result = json.loads(response.read().decode("utf-8"))
        choices = result.get("choices", [])
        if choices and "message" in choices[0]:
            content_str = choices[0]["message"].get("content", "")
            return _clean_and_parse_json(content_str)

    raise ValueError("Empty or invalid response from Ollama API")


def _clean_and_parse_json(text: str) -> Dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    return json.loads(cleaned.strip())


def _generate_heuristic_report(telemetry: Dict[str, Any]) -> Dict[str, Any]:
    """
    Intelligent heuristic engine that inspects the real telemetry numbers
    (transcript word counts, brow furrow spikes, attention states, whiteboard deltas)
    and constructs a genuine, data-driven pedagogical coaching report.
    """
    dialogue = telemetry.get("dialogue_timeline", [])
    video = telemetry.get("video_telemetry", {})
    whiteboard = telemetry.get("whiteboard_telemetry", {})

    student_video = video.get("student", {})
    tutor_video = video.get("tutor", {})

    # 1. Talk-Time Ratio
    tutor_words = sum(len(d.get("speech", "").split()) for d in dialogue if d.get("role") == "tutor")
    student_words = sum(len(d.get("speech", "").split()) for d in dialogue if d.get("role") == "student")
    total_words = tutor_words + student_words

    if total_words > 0:
        tutor_pct = round(100 * tutor_words / total_words)
        student_pct = 100 - tutor_pct
    else:
        tutor_pct = 50
        student_pct = 50

    if tutor_pct > 75:
        pacing_status = "Tutor-Heavy"
        pacing_advice = f"Tutor is doing {tutor_pct}% of the talking. Pause for 3–5 seconds after asking questions to allow the student time to respond."
    elif student_pct > 65:
        pacing_status = "Student-Led"
        pacing_advice = "Great student engagement and active participation. Provide structured scaffolding when needed."
    else:
        pacing_status = "Balanced"
        pacing_advice = f"Well-balanced turn taking ({tutor_pct}% tutor / {student_pct}% student)."

    # 2. Visual Confusion & Attention
    student_eng_avg = student_video.get("engagement_avg") or 0.75
    student_furrow = student_video.get("brow_furrow_avg") or 0.15
    current_att = student_video.get("current_attention", "attentive_screen")

    friction_points = []

    # Check for brow furrow / confusion spikes in trend
    trend = student_video.get("engagement_trend", [])
    for idx, pt in enumerate(trend):
        if pt.get("brow_furrow", 0) > 0.40 or pt.get("attention_state") == "confused_furrow":
            time_lbl = f"Point #{idx+1}"
            friction_points.append({
                "time_label": time_lbl,
                "observation": f"Elevated brow furrow ({round(pt.get('brow_furrow', 0)*100)}%) detected during explanation.",
                "recommendation": "Ask the student: 'Does that step make sense, or would you like to see another example?'"
            })
            if len(friction_points) >= 2:
                break

    # If no friction points from trend but student has gaze away
    gaze_summary = student_video.get("gaze_summary", {})
    screen_gazes = gaze_summary.get("screen", 0)
    total_gazes = sum(gaze_summary.values()) or 1
    if (screen_gazes / total_gazes) < 0.50 and total_gazes > 5:
        friction_points.append({
            "time_label": "Recent",
            "observation": "Student frequently looking away from screen (over 50% of recent time).",
            "recommendation": "Re-engage student with an interactive check-in or request them to write on the whiteboard."
        })

    # 3. Whiteboard Feedback
    wb_summary = whiteboard.get("summary", {})
    total_wb_changes = wb_summary.get("total_changes", 0)
    major_edits = wb_summary.get("major_edits", 0)

    if total_wb_changes == 0:
        wb_feedback = "Whiteboard has not been used yet. Consider drawing diagrams or equations to anchor visual understanding."
    elif major_edits > 0:
        wb_feedback = f"Active whiteboard utilization with {major_edits} significant diagram/formula updates."
    else:
        wb_feedback = "Whiteboard contains initial content but has been idle. Use the pen to highlight key terms as you talk."

    # 4. Comprehension Score & Rating
    if student_eng_avg >= 0.70 and student_furrow < 0.30:
        comprehension_rating = "High"
        comprehension_score = min(95, int(student_eng_avg * 100))
    elif student_eng_avg >= 0.45:
        comprehension_rating = "Moderate"
        comprehension_score = max(55, int(student_eng_avg * 100))
    else:
        comprehension_rating = "Needs Attention"
        comprehension_score = max(30, int(student_eng_avg * 100))

    summary = (
        f"The session dynamic is currently {pacing_status.lower()} with {tutor_pct}% tutor talk time. "
        f"Student attention indicates {comprehension_rating.lower()} comprehension ({comprehension_score}% score). "
        f"{wb_feedback}"
    )

    actionable_tips = [
        "Ask the student to summarize the last concept in their own words.",
        "Prompt the student to use the whiteboard to solve the next step."
    ]
    if tutor_pct > 70:
        actionable_tips.insert(0, "Increase wait time after asking questions to 4–5 seconds.")

    return {
        "summary": summary,
        "comprehension_rating": comprehension_rating,
        "comprehension_score": comprehension_score,
        "pacing": {
            "tutor_talk_pct": tutor_pct,
            "student_talk_pct": student_pct,
            "status": pacing_status,
            "advice": pacing_advice
        },
        "friction_points": friction_points,
        "whiteboard_feedback": wb_feedback,
        "actionable_tips": actionable_tips
    }
