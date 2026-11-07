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
4. Whiteboard activity, delta changes, and element logs.
5. (Multimodal) The current whiteboard image snapshot showing handwritten work, formulas, and diagrams created by the tutor and student.

WHITEBOARD VISUAL COLOR CODING & ATTRIBUTION RULES:
- The whiteboard image has an explicit visual legend at the top:
  * BLACK/DARK SLATE strokes: Written by the TUTOR (e.g., questions, equation stems like "21 - 1 = ", "12 - 2 = ", diagrams, prompts).
  * GREEN strokes: Written by the PUPIL/STUDENT (e.g., answers like "16", "14", student calculations, student steps).
- Critical Attribution Rule:
  * Distinguish who wrote what based on this color coding!
  * If the tutor wrote an equation stem in black (e.g. "21 - 1 = ") and the pupil wrote the answer in green (e.g. "16"), DO NOT attribute the entire equation to the student. State that the tutor set the problem and the student answered with "16".
  * Set "interaction_with_tutor_work" to "Directly answering / building on tutor work" (NOT "Independent work").
- Topic Relevance & Alignment Scoring:
  * "relevance_to_topic": Evaluates whether the pupil's work relates to the subject/topic being taught (e.g. math addition, subtraction, arithmetic). If the discussion or problems involve arithmetic/subtraction and the pupil is performing subtraction/arithmetic work, "relevance_to_topic" MUST be "High".
  * An arithmetic mistake (e.g., answering 16 instead of 20, or 14 instead of 10) is a MATHEMATICAL COMPREHENSION / CALCULATION ERROR, NOT a topic mismatch! The pupil's topic relevance remains "High" and question relevance is "High".
  * "alignment_score": Reflects how closely the pupil is following and responding to the tutor's prompts (typically 80-100% when answering the tutor's questions).
  * "pedagogical_insight": Critically analyze the pupil's mathematical understanding: identify the specific answers the pupil provided, diagnose their mathematical misconception (e.g., place value error, subtraction vs addition confusion), and advise the tutor how to guide them.

You MUST respond ONLY with a valid JSON object matching this exact schema:
{
  "summary": "2-3 sentences summarizing current dynamic, learning flow, and whiteboard work",
  "comprehension_rating": "High" | "Moderate" | "Needs Attention",
  "comprehension_score": 0 to 100,
  "pacing": {
    "tutor_talk_pct": 0 to 100,
    "student_talk_pct": 0 to 100,
    "status": "Balanced" | "Tutor-Heavy" | "Student-Led",
    "advice": "1 clear sentence on pacing"
  },
  "whiteboard_relevance": {
    "student_active_on_board": true | false,
    "relevance_to_latest_question": "High" | "Moderate" | "Low" | "None" | "N/A",
    "relevance_to_topic": "High" | "Moderate" | "Low" | "None",
    "interaction_with_tutor_work": "Directly answering / building on tutor work" | "Independent work" | "Off-topic" | "No work detected",
    "observed_pupil_work": "1-2 sentences describing what the pupil wrote or drew on the board",
    "alignment_score": 0 to 100,
    "pedagogical_insight": "Specific insight into the pupil's mathematical/conceptual understanding based on their visual work"
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
    wb_telemetry = telemetry_payload.get("whiteboard_telemetry", {})
    image_data_url = wb_telemetry.get("current_data_url")

    report = None
    provider_used = provider

    try:
        if provider == "gemini" and gemini_key:
            report = _call_gemini(prompt_context, gemini_key, image_data_url=image_data_url)
        elif provider == "openai" and openai_key:
            report = _call_openai(prompt_context, openai_key, image_data_url=image_data_url)
        elif provider == "ollama":
            report = _call_ollama(prompt_context)
    except Exception as e:
        logger.warning(f"LLM provider '{provider}' failed ({e}). Falling back to Heuristic Engine.")
        provider_used = f"heuristic (fallback from {provider})"

    if not report:
        report = _generate_heuristic_report(telemetry_payload)
        if provider_used == provider and provider != "heuristic":
            provider_used = "heuristic"

    # Guarantee whiteboard_relevance exists so UI always displays alignment breakdown
    if not report.get("whiteboard_relevance") or not isinstance(report.get("whiteboard_relevance"), dict):
        heuristic = _generate_heuristic_report(telemetry_payload)
        report["whiteboard_relevance"] = heuristic.get("whiteboard_relevance", {})

    report["provider_used"] = provider_used
    report["generated_at_ms"] = int(time.time() * 1000)
    return report


def _call_gemini(prompt_context: str, api_key: str, image_data_url: Optional[str] = None) -> Dict[str, Any]:
    configured_model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()
    candidate_models = [configured_model]
    for fallback in ["gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-1.5-flash", "gemini-2.0-flash"]:
        if fallback not in candidate_models:
            candidate_models.append(fallback)

    parts: list = [{"text": f"{COACH_SYSTEM_PROMPT}\n\nHere is the current live session data:\n\n{prompt_context}"}]

    # Attach the whiteboard visual snapshot if present
    if image_data_url:
        try:
            if "," in image_data_url:
                mime_part, b64_data = image_data_url.split(",", 1)
                mime_type = "image/jpeg"
                if "png" in mime_part:
                    mime_type = "image/png"
            else:
                b64_data = image_data_url
                mime_type = "image/jpeg"

            parts.append({
                "inline_data": {
                    "mime_type": mime_type,
                    "data": b64_data
                }
            })
            parts.append({
                "text": "Above is the latest rendered whiteboard image snapshot.\n"
                        "COLOR CODING: Black/Slate strokes = Tutor questions/equation stems. Green strokes = Pupil answers/work.\n"
                        "Note: Attribute the question stem (e.g. '21 - 1 =') to the tutor and the answer (e.g. '16') to the pupil. Set interaction_with_tutor_work to 'Directly answering / building on tutor work'."
            })
        except Exception as img_err:
            logger.warning(f"Failed to prepare whiteboard image for Gemini: {img_err}")

    last_err = None
    for model in candidate_models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

        req_data = {
            "contents": [
                {
                    "role": "user",
                    "parts": parts
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
                    res_parts = candidates[0]["content"].get("parts", [])
                    if res_parts and "text" in res_parts[0]:
                        return _clean_and_parse_json(res_parts[0]["text"])
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


def _call_openai(prompt_context: str, api_key: str, image_data_url: Optional[str] = None) -> Dict[str, Any]:
    model = os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
    url = "https://api.openai.com/v1/chat/completions"

    full_prompt = f"Here is the current live session data:\n\n{prompt_context}"

    user_content: list = [{"type": "text", "text": full_prompt}]
    if image_data_url:
        img_url = image_data_url if image_data_url.startswith("data:") else f"data:image/jpeg;base64,{image_data_url}"
        user_content.append({
            "type": "image_url",
            "image_url": {"url": img_url, "detail": "low"}
        })

    req_data = {
        "model": model,
        "messages": [
            {"role": "system", "content": COACH_SYSTEM_PROMPT},
            {"role": "user", "content": user_content}
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

    # 3. Whiteboard Feedback & Content Relevance
    wb_summary = whiteboard.get("summary", {})
    total_wb_changes = wb_summary.get("total_changes", 0)
    major_edits = wb_summary.get("major_edits", 0)
    student_edits = whiteboard.get("student_edits", 0)
    tutor_edits = whiteboard.get("tutor_edits", 0)

    if student_edits > 0:
        wb_relevance = {
            "student_active_on_board": True,
            "relevance_to_latest_question": "High",
            "relevance_to_topic": "High",
            "interaction_with_tutor_work": "Directly answering / building on tutor work" if tutor_edits > 0 else "Independent work",
            "observed_pupil_work": f"Student made {student_edits} active visual whiteboard contributions (handwritten equations/diagrams).",
            "alignment_score": min(95, 60 + student_edits * 5),
            "pedagogical_insight": "Pupil is actively externalizing their problem solving on the whiteboard in response to prompts."
        }
    else:
        wb_relevance = {
            "student_active_on_board": False,
            "relevance_to_latest_question": "N/A",
            "relevance_to_topic": "Moderate",
            "interaction_with_tutor_work": "No work detected",
            "observed_pupil_work": "No student writing or drawing detected on the whiteboard yet.",
            "alignment_score": 50,
            "pedagogical_insight": "Encourage the pupil to write down their intermediate steps on the whiteboard to assess their reasoning."
        }

    if total_wb_changes == 0:
        wb_feedback = "Whiteboard has not been used yet. Consider drawing diagrams or equations to anchor visual understanding."
    elif student_edits > 0:
        wb_feedback = f"Active collaborative whiteboard utilization: Student contributed {student_edits} edits, directly interacting with session material."
    elif major_edits > 0:
        wb_feedback = f"Active whiteboard utilization with {major_edits} significant updates from tutor. Prompt student to write on the board."
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
        "whiteboard_relevance": wb_relevance,
        "friction_points": friction_points,
        "whiteboard_feedback": wb_feedback,
        "actionable_tips": actionable_tips
    }


def generate_live_nudge(store: Any, force_trigger: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Decides whether the tutor needs a live nudge (T2 glanceable toast or T3 persistent alert).
    Strictly follows:
    - Interrupt as rarely as possible (rate-limited, min 90s between live nudges in real-time).
    - Favor concrete actionable examples (e.g. pizza slice, number line).
    - If force_trigger is set (e.g. 'demo_fractions' from demo hotkey), bypasses rate-limiter.
    """
    now = int(time.time() * 1000)

    # 1. Deterministic / Demo Trigger (100% reproducible for 3-minute hackathon pitch)
    if force_trigger in ("demo_fractions", "demo", "seed"):
        store.last_nudge_timestamp = now
        return {
            "tier": "T3",
            "category": "confusion",
            "confidence": "high",
            "toast_text": "Student stuck on dividing fractions — try a pizza-slice example?",
            "action_label": "🍕 Drop on Board",
            "example_type": "fraction_pizza",
            "notebook_entry": "🔴 Student confused: 'wait, how do we divide fractions?'",
            "reasoning": "Student expressed doubt about dividing fractions; visual fraction model recommended."
        }

    # 2. Rate Limiting: at most 1 live toast per 90 seconds in live session
    last_nudge = getattr(store, "last_nudge_timestamp", 0)
    if (now - last_nudge) < 90000:
        return None

    # 3. Check recent student transcripts (last 45 seconds)
    student_transcripts = [t for t in store.transcripts if t.role == "student"]
    if not student_transcripts:
        return None

    recent_student = student_transcripts[-3:]
    recent_text = " ".join(t.text.lower() for t in recent_student)

    # Keywords indicating confusion
    confusion_cues = ["don't get", "don't understand", "wait what", "why did you", "huh?", "confused", "stuck", "lost"]
    has_confusion = any(cue in recent_text for cue in confusion_cues)

    if has_confusion:
        store.last_nudge_timestamp = now
        # Detect topic if mentioned
        if "fraction" in recent_text or "divide" in recent_text:
            return {
                "tier": "T3",
                "category": "confusion",
                "confidence": "high",
                "toast_text": "Student stuck on dividing fractions — try a pizza-slice example?",
                "action_label": "🍕 Drop on Board",
                "example_type": "fraction_pizza",
                "notebook_entry": f"🔴 Confusion: \"{recent_student[-1].text}\"",
                "reasoning": "Student verbalized confusion; visual pizza model recommended."
            }
        else:
            return {
                "tier": "T3",
                "category": "confusion",
                "confidence": "high",
                "toast_text": "Student expresses confusion — draw a number line visual?",
                "action_label": "📏 Drop on Board",
                "example_type": "number_line",
                "notebook_entry": f"🔴 Confusion: \"{recent_student[-1].text}\"",
                "reasoning": "Student verbalized confusion; number line recommended."
            }

    # 4. Check for sustained silence after a tutor question (pacing T2 toast)
    if len(store.transcripts) >= 2:
        last_t = store.transcripts[-1]
        if last_t.role == "tutor" and "?" in last_t.text and (now - last_t.timestamp) > 15000:
            store.last_nudge_timestamp = now
            return {
                "tier": "T2",
                "category": "pacing",
                "confidence": "high",
                "toast_text": "Quiet spell — check in with an open-ended hint?",
                "action_label": "📏 Drop on Board",
                "example_type": "number_line",
                "notebook_entry": "🟡 Pacing: student silent >15s after tutor question",
                "reasoning": "Extended silence detected; suggested prompt check-in."
            }

    return None
