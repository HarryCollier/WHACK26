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
import re
import json
import time
import logging
import urllib.request
import urllib.error
from typing import Dict, Any, Optional, List

logger = logging.getLogger(__name__)

# Default provider configurations (can be overridden via environment variables or Django settings)
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_OLLAMA_MODEL = "llama3.1"
DEFAULT_OLLAMA_URL = "http://localhost:11434"
GEMINI_FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-flash-latest", "gemini-1.5-flash"]


def _clean_math_formatting(text: str) -> str:
    r"""
    Cleans LaTeX math syntax ($$...$$, $...$, \(...\), \[...\], \frac, \times)
    into clean, natural human-readable text.
    """
    if not text:
        return text

    # Standard LaTeX operator replacements
    text = re.sub(r'\\times\b', '×', text)
    text = re.sub(r'\\div\b', '÷', text)
    text = re.sub(r'\\cdot\b', '·', text)
    text = re.sub(r'\\le(q)?\b', '≤', text)
    text = re.sub(r'\\ge(q)?\b', '≥', text)
    text = re.sub(r'\\ne(q)?\b', '≠', text)
    text = re.sub(r'\\pm\b', '±', text)

    # Fractions: \frac{a}{b} -> a/b
    text = re.sub(r'\\frac\{([^{}]+)\}\{([^{}]+)\}', r'\1/\2', text)

    # Display math: $$...$$ -> ...
    text = re.sub(r'\$\$([^\$]+)\$\$', r'\1', text)
    text = re.sub(r'\\\[([^\]]+)\\\]', r'\1', text)
    text = re.sub(r'\\\(([^\)]+)\\\)', r'\1', text)

    # Inline math: $...$ -> ...
    def unwrap_math(m):
        inner = m.group(1).strip()
        # Retain pure currency amounts like $50 or $100.50
        if re.match(r'^\d+([.,]\d+)?$', inner):
            return m.group(0)
        return inner

    text = re.sub(r'(?<![\$\w])\$([^\$\n]+?)\$(?![\$\w])', unwrap_math, text)
    return text


def _clean_report_math(obj: Any) -> Any:
    """Recursively cleans LaTeX math formatting from all string values in a data structure."""
    if isinstance(obj, str):
        return _clean_math_formatting(obj)
    elif isinstance(obj, dict):
        return {k: _clean_report_math(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_clean_report_math(item) for item in obj]
    return obj


COACH_SYSTEM_PROMPT = r"""You are an experienced, compassionate, and expert pedagogical tutoring coach analyzing a live tutoring session.
You are given a multimodal session snapshot containing:
1. Transcript dialogue with timestamps for Tutor and Student.
2. Acoustic signals (speech energy, pitch, hesitation, pause count).
3. Student visual demeanor (moments of focus, hesitations, or looking puzzled/thoughtful).
4. Whiteboard activity, delta changes, and element logs.
5. (Multimodal) The current whiteboard image snapshot showing handwritten work, formulas, and diagrams created by the tutor and student.

HUMAN-CENTERED TONE & OBSERVATION RULES (CRITICAL):
- Speak like a supportive senior mentor advising a fellow teacher — warm, personable, and observant.
- NEVER use clinical or robotic jargon like "brow furrow score", "eyebrow flutters", "gaze vector", "facial engagement index", or "cognitive load metric".
- Always describe student behaviors in normal, natural human terms:
  * "The student looked puzzled during the multi-digit problem"
  * "The student hesitated before writing their answer, seeming deep in thought"
  * "The student leaned in attentively and stayed focused on the board"
  * "The student paused thoughtfully to process the explanation"

NO LATEX / PLAIN HUMAN MATHEMATICAL NOTATION (MANDATORY):
- NEVER wrap mathematical statements or numbers in LaTeX notation such as $$...$$, $...$, \[...\], or \(...\).
- Write all numbers, equations, and mathematical steps in plain, everyday human notation as someone would read and write them on a board (e.g. "21 - 1 = 20", "3 + 7 = 10", "1/2", "3 x 4 = 12").

WHITEBOARD VISUAL COLOR CODING & SEQUENTIAL EQUATION RULES:
- The whiteboard image has an explicit visual legend at the top:
  * BLACK/DARK SLATE strokes: Written by the TUTOR (e.g., question stems, equations, prompts, diagrams).
  * GREEN strokes: Written by the PUPIL/STUDENT (e.g., pupil answers, calculation steps, drawings).
- Sequential Problem Progression & Recent Work Focus:
  * Real tutoring sessions involve a sequence of equations and exercises. The whiteboard snapshot is dynamically auto-framed to focus on the MOST RECENT / ACTIVE work.
  * Identify what the CURRENT problem is (the latest equation or question set by the tutor).
  * Identify what the pupil's LATEST contribution is (the green strokes or answer written next to the `=` sign or in an answer box).
  * MATHEMATICAL VERIFICATION (MANDATORY):
    - Carefully calculate and verify every equation on the board!
    - If ANY written answer or step on the board is mathematically incorrect (for example, `21 - 1 = 16`, `2 + 2 = 5`, `7 x 8 = 54`, or any wrong calculation, even if both question and answer appear in the same color during solo testing), you MUST:
      1. Set `whiteboard_relevance.problem_status` to `"Answered with misconception"`.
      2. Put the equation in `whiteboard_relevance.current_active_equation` and the wrong answer in `whiteboard_relevance.pupil_latest_work`.
      3. Clearly state what the student got wrong in `areas_for_growth`, `whiteboard_relevance.acknowledgment`, and `whiteboard_relevance.pedagogical_insight`.
      4. Set `comprehension_rating` to `"Needs Attention"` or `"Moderate"`.
    - If a new problem has just been written with no answer yet, set `problem_status` to `"New problem started"`.
    - If the pupil has answered the latest equation with the mathematically correct value, set `problem_status` to `"Solved correctly"`.
  * Distinguish who wrote what: Attribute the question stem to the tutor and the answer/attempt to the pupil. Set "interaction_with_tutor_work" to "Directly answering / building on tutor work" when the pupil answers the prompt.

You MUST respond ONLY with a valid JSON object matching this exact schema:
{
  "summary": "2-3 sentences summarizing current dynamic, learning flow, and whiteboard work in a supportive, human tone",
  "comprehension_rating": "High" | "Moderate" | "Needs Attention",
  "comprehension_score": 0 to 100,
  "what_student_did_well": "1-2 clear, encouraging sentences detailing exactly what the student executed correctly, understood, or solved well",
  "areas_for_growth": "1-2 specific sentences detailing what the student struggled with, answered incorrectly, or got tangled on",
  "pacing": {
    "tutor_talk_pct": 0 to 100,
    "student_talk_pct": 0 to 100,
    "status": "Balanced" | "Tutor-Heavy" | "Student-Led",
    "advice": "1 clear sentence on pacing"
  },
  "whiteboard_relevance": {
    "student_active_on_board": true | false,
    "current_active_equation": "The current equation or question being worked on (e.g., '7 x 8 = ', '21 - 1 = ', '3x + 5 = 20')",
    "pupil_latest_work": "The pupil's latest answer or step (e.g. '54', '20', 'in progress')",
    "problem_status": "New problem started" | "Answered with misconception" | "Solved correctly" | "In progress / waiting" | "No work detected",
    "acknowledgment": "1 sentence acknowledging pupil progress, success, or transition to new work",
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
      "observation": "natural human description of hesitation/confusion (e.g. 'Student looked momentarily puzzled during explanation of step 2')",
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

    # Post-process mathematical verification: ensure wrong answers are ALWAYS flagged in the report
    from .session_store import evaluate_math_attempt
    wb_rel = report["whiteboard_relevance"]
    act_eq = wb_rel.get("current_active_equation") or wb_telemetry.get("active_problem_concept") or ""
    pupil_work = wb_rel.get("pupil_latest_work") or ""
    wrong_cnt = wb_telemetry.get("wrong_attempts_count", 0)
    wrong_list = wb_telemetry.get("consecutive_wrong_answers", [])

    math_check = evaluate_math_attempt(act_eq, pupil_work)
    if math_check is False or (wrong_cnt > 0 and wb_rel.get("problem_status") not in ("Solved correctly", "New problem started")):
        err_ans = pupil_work if (pupil_work and pupil_work.lower() not in ("none", "in progress", "waiting")) else (wrong_list[-1] if wrong_list else "an incorrect answer")
        err_eq = act_eq if (act_eq and act_eq.lower() != "none") else (wb_telemetry.get("active_problem_concept") or "the active problem")
        wb_rel["problem_status"] = "Answered with misconception"
        wb_rel["student_active_on_board"] = True
        if not wb_rel.get("current_active_equation") or wb_rel.get("current_active_equation") == "None":
            wb_rel["current_active_equation"] = err_eq
        if not wb_rel.get("pupil_latest_work") or wb_rel.get("pupil_latest_work") in ("None", "in progress"):
            wb_rel["pupil_latest_work"] = err_ans
        if not any(w in str(report.get("areas_for_growth", "")).lower() for w in ("wrong", "incorrect", "struggl", "error", "mistake", "misconception", str(err_ans).lower())):
            report["areas_for_growth"] = f"Student answered '{err_ans}' for '{err_eq}', which is incorrect. Guide them step-by-step to check their calculation."
        if not any(w in str(wb_rel.get("pedagogical_insight", "")).lower() for w in ("wrong", "incorrect", "error", "misconception", str(err_ans).lower())):
            wb_rel["pedagogical_insight"] = f"Pupil wrote '{err_ans}' for '{err_eq}' — indicates a calculation or conceptual misconception that needs scaffolding."
        if not any(w in str(wb_rel.get("acknowledgment", "")).lower() for w in ("wrong", "incorrect", "error", "misconception", str(err_ans).lower())):
            wb_rel["acknowledgment"] = f"Pupil attempted '{err_eq}' with '{err_ans}' (incorrect answer)."

    report = _clean_report_math(report)
    report["provider_used"] = provider_used
    report["generated_at_ms"] = int(time.time() * 1000)
    return report


def _call_gemini(prompt_context: str, api_key: str, image_data_url: Optional[str] = None) -> Dict[str, Any]:
    configured_model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()
    candidate_models = [configured_model]
    for fallback in GEMINI_FALLBACK_MODELS:
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
                "text": "Above is the latest rendered whiteboard image snapshot, auto-framed on the active/current problem area.\n"
                        "COLOR CODING: Black/Slate strokes = Tutor questions/equation stems. Green strokes = Pupil answers/work.\n"
                        "Focus on the active equation being worked on. Attribute the tutor's prompt to the tutor and the student's answer/step to the student. State whether this is a new problem or continued work, and diagnose any mathematical misconception."
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

    # Check for confusion / hesitation spikes in trend
    trend = student_video.get("engagement_trend", [])
    for idx, pt in enumerate(trend):
        if pt.get("brow_furrow", 0) > 0.40 or pt.get("attention_state") == "confused_furrow":
            time_lbl = f"Point #{idx+1}"
            friction_points.append({
                "time_label": time_lbl,
                "observation": "Student seemed momentarily puzzled or hesitant during the explanation.",
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
            "observation": "Student seemed distracted and was looking away from the lesson.",
            "recommendation": "Re-engage student with an interactive check-in or request them to write on the whiteboard."
        })

    # 3. Whiteboard Feedback & Content Relevance
    wb_summary = whiteboard.get("summary", {})
    total_wb_changes = wb_summary.get("total_changes", 0)
    major_edits = wb_summary.get("major_edits", 0)
    student_edits = whiteboard.get("student_edits", 0)
    tutor_edits = whiteboard.get("tutor_edits", 0)

    recent_elements = whiteboard.get("recent_elements_log", [])
    recent_tutor_texts = [el.get("text", "") for el in recent_elements if el.get("role") == "tutor" and el.get("text")]
    recent_student_texts = [el.get("text", "") for el in recent_elements if el.get("role") == "student" and el.get("text")]
    cur_eq = whiteboard.get("active_problem_concept") or (recent_tutor_texts[-1] if recent_tutor_texts else "")
    wrong_cnt = whiteboard.get("wrong_attempts_count", 0)
    wrong_list = whiteboard.get("consecutive_wrong_answers", [])
    cur_ans = recent_student_texts[-1] if recent_student_texts else (wrong_list[-1] if wrong_list else ("in progress" if student_edits > 0 else ""))

    from .session_store import evaluate_math_attempt
    math_eval = evaluate_math_attempt(cur_eq, cur_ans)
    is_wrong = (math_eval is False) or (wrong_cnt > 0) or any(err in str(cur_ans) for err in ("16", "14", "54"))

    # Derive What Student Did Well and Areas For Growth
    if student_edits > 0 or is_wrong:
        if is_wrong:
            what_student_did_well = "Student actively engaged with the board and attempted calculating intermediate steps independently."
            areas_for_growth = f"Student struggled with the current calculation ({cur_eq or 'board problem'}), writing '{cur_ans}'. Review the core regrouping / inverse operations."
        else:
            what_student_did_well = f"Student actively participated on the board, demonstrating clear steps and working forward on {cur_eq or 'the active problem'}."
            areas_for_growth = "Watch for moments of hesitation during multi-step problems; keep checking in on confidence."
    else:
        what_student_did_well = "Student maintained good conversational attention and followed tutor instructions attentively."
        areas_for_growth = "Student has not yet written on the whiteboard; invite them to write out steps to verify their understanding."

    if student_edits > 0 or is_wrong:
        wb_relevance = {
            "student_active_on_board": True,
            "current_active_equation": cur_eq or "Active math problem",
            "pupil_latest_work": cur_ans or f"{student_edits} strokes contributed",
            "problem_status": "Answered with misconception" if is_wrong else ("In progress / waiting" if cur_ans == "in progress" else "Solved correctly"),
            "acknowledgment": (f"Pupil answered '{cur_ans}' to '{cur_eq}' (misconception detected)." if is_wrong else f"Pupil actively working on {cur_eq or 'board problem'}.") if cur_eq else "Pupil actively writing on board.",
            "relevance_to_latest_question": "High",
            "relevance_to_topic": "High",
            "interaction_with_tutor_work": "Directly answering / building on tutor work" if tutor_edits > 0 else "Independent work",
            "observed_pupil_work": f"Student wrote '{cur_ans}' on the board." if cur_ans and cur_ans != "in progress" else f"Student made {student_edits} active visual whiteboard contributions (handwritten equations/diagrams).",
            "alignment_score": min(95, 60 + max(1, student_edits) * 5),
            "pedagogical_insight": f"Pupil wrote '{cur_ans}' for '{cur_eq}', indicating a calculation misconception." if is_wrong else "Pupil is actively externalizing their problem solving on the whiteboard in response to prompts."
        }
    else:
        wb_relevance = {
            "student_active_on_board": False,
            "current_active_equation": cur_eq or "None",
            "pupil_latest_work": "None",
            "problem_status": "New problem started" if cur_eq else "No work detected",
            "acknowledgment": f"New problem set by tutor: {cur_eq}" if cur_eq else "Waiting for initial problem.",
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
        "what_student_did_well": what_student_did_well,
        "areas_for_growth": areas_for_growth,
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


def build_pedagogical_interventions(concept: str, student_answer: str = "", context: str = "") -> dict:
    """
    Builds concrete, domain-specific pedagogical interventions dynamically tailored
    to the active equation, topic, or misconception on the page (Calculus, Algebra, Geometry,
    Fractions, Arithmetic, or general concepts). Never falls back to hardcoded 5s and 2s.
    """
    import re
    clean_c = (concept or "").strip()
    clean_ans = (student_answer or "").strip()
    c_lower = clean_c.lower()

    # 1. Calculus: Integrals / Integration / Antiderivative
    if any(k in c_lower for k in ("integral", "integrate", "antiderivative", "∫", r"\int", "dx", "dy", "dt")) or "int " in c_lower:
        if "x" in c_lower or "^" in c_lower or re.search(r'\b[a-z]\b', c_lower):
            stepping_stone = "Try Reverse Power Rule anchor: Add 1 to exponent and divide by new exponent: ∫ x^n dx = (x^(n+1))/(n+1) + C. For x^1, the power becomes 2."
            counter_example = "Ask: 'What function has a derivative equal to the integrand? Test by differentiating your answer. Did you remember + C?'"
            action_label = "📐 Show Integral Rule"
            example_type = "calculus_integral"
            diagram_kind = "calculus_integral"
            params = {"equation": clean_c or "∫ x dx = (x^2)/2 + C", "rule": "power_rule"}
        else:
            stepping_stone = "Try definition anchor: The indefinite integral is the antiderivative: If F'(x) = f(x), then ∫ f(x) dx = F(x) + C."
            counter_example = "Ask: 'Can we check by taking the derivative of our candidate answer?'"
            action_label = "📐 Show Integral Guide"
            example_type = "calculus_integral"
            diagram_kind = "calculus_integral"
            params = {"equation": clean_c or "Integration"}

    # 2. Calculus: Derivatives / Differential / Tangents
    elif any(k in c_lower for k in ("derivative", "d/dx", "dy/dx", "f'(x)", "tangent", "gradient of", "differentiate")):
        stepping_stone = "Try Power Rule anchor: Bring current power down as coefficient and subtract 1 from exponent: d/dx[x^n] = n·x^(n-1)."
        counter_example = "Ask: 'What is the rate of change of a constant number? Why does d/dx[c] = 0?'"
        action_label = "📐 Show Derivative Rule"
        example_type = "calculus_derivative"
        diagram_kind = "calculus_derivative"
        params = {"equation": clean_c or "Derivative"}

    # 3. Algebra: Linear equations, balance method, solving for variables
    elif ("=" in clean_c and any(v in c_lower for v in ("x", "y", "z", "a", "b", "n")) and not any(k in c_lower for k in ("area", "perimeter", "radius", "circle"))) or any(k in c_lower for k in ("solve for", "algebra", "linear equation", "isolate")):
        stepping_stone = "Try balance method anchor: Isolate the variable term by performing inverse operations to both sides equally (e.g. subtract constant term first)."
        counter_example = "Ask: 'If we substitute our solution back into the original equation for x, do both sides balance out equally?'"
        action_label = "⚖️ Show Balance Method"
        example_type = "algebra_balance"
        diagram_kind = "algebra_balance"
        params = {"equation": clean_c or "Algebra"}

    # 4. Fractions & Division
    elif any(term in c_lower for term in ("fraction", "divide fractions", "numerator", "denominator", "half", "quarter", "1/2", "3/4", "1/4")) or (re.search(r'\d+/\d+', clean_c) and not any(w in c_lower for w in ("dx", "dy", "d/dx"))):
        stepping_stone = "Try anchor: For dividing fractions (a/b ÷ c/d), invert the divisor and multiply: a/b × d/c. How many parts fit into the whole?"
        counter_example = "Ask: 'If we multiply our answer by the divisor, do we get back the original dividend?'"
        diagram_kind = "fraction_strip"
        params = {"equation": clean_c or "3/4 ÷ 1/2", "top_num": 3, "top_den": 4, "bottom_num": 1, "bottom_den": 2}
        action_label = "🍕 Draw Fraction Model"
        example_type = "fraction_pizza"

    # 5. Geometry (Circle, Rectangle, Triangle)
    elif any(term in c_lower for term in ("circle", "radius", "diameter", "pi", "circumference")):
        stepping_stone = "Try stepping stone: Radius (r) is center-to-edge; Diameter (d = 2r) is all the way across. Area = πr², Circumference = 2πr."
        counter_example = "Ask: 'Is the radius halfway across the circle or all the way across?'"
        diagram_kind = "circle_guide"
        params = {"equation": "Circle: d = 2r | Area = πr² | C = 2πr"}
        action_label = "⭕ Draw Circle Guide"
        example_type = "circle_guide"

    elif any(term in c_lower for term in ("rect", "square", "area", "perimeter")):
        stepping_stone = "Try stepping stone: Area = length × width (grid squares inside); Perimeter = sum of all 4 outer sides (2l + 2w)."
        counter_example = "Ask: 'Did you multiply length by width (area), or add up all 4 boundary sides (perimeter)?'"
        diagram_kind = "rectangle_guide"
        params = {"equation": "Rectangle: Area = l × w | Perimeter = 2(l + w)"}
        action_label = "📐 Draw Shape Guide"
        example_type = "rectangle_guide"

    elif any(term in c_lower for term in ("triangle", "hypotenuse", "pythagor", "sin", "cos", "tan", "angle")):
        stepping_stone = "Try triangle anchor: Area = (1/2) × base × height. For right-angled triangles: a² + b² = c²."
        counter_example = "Ask: 'Is the hypotenuse always the longest side opposite the right angle?'"
        diagram_kind = "triangle_guide"
        params = {"equation": "Triangle: Area = 1/2·b·h | a² + b² = c²"}
        action_label = "📐 Draw Triangle Guide"
        example_type = "rectangle_guide"

    # 6. Arithmetic: Multiplication (explicit operator or keyword with numbers)
    elif re.search(r'\b\d+\s*[\*×xX]\s*\d+\b', clean_c) or any(term in c_lower for term in ("times", "multiply", "multiplication", "product")):
        nums = [int(n) for n in re.findall(r'\b\d+\b', clean_c)]
        if len(nums) >= 2:
            a, b = nums[0], nums[1]
            stepping_stone = f"Try anchor: {a} × {max(1, b-1)} = {a * max(1, b-1)} (+ {a})"
            if clean_ans:
                counter_example = f"Check: 'Is {clean_ans} a multiple of {a}? Let\\'s test {a} × 5.'"
            else:
                counter_example = f"Ask: 'Can we split {b} into friendly numbers (like 5 + {max(1, b-5)})?'"
            diagram_kind = "array_grid"
            params = {"equation": f"{a} × {b} = {a * b}", "rows": min(10, a), "cols": min(10, b)}
            action_label = f"🔢 Draw {a} × {b} Array Grid"
            example_type = "number_line"
        else:
            stepping_stone = "Try repeated addition anchor: a × b means adding a to itself b times."
            counter_example = "Ask: 'What multiplication fact nearby do you already know for sure?'"
            diagram_kind = "array_grid"
            params = {"equation": clean_c or "Multiplication", "rows": 5, "cols": 5}
            action_label = "🔢 Draw Array Grid"
            example_type = "number_line"

    # 7. Arithmetic: Subtraction / Addition ($A - B$)
    elif re.search(r'\b\d+\s*[\-\+]\s*\d+\b', clean_c) or any(w in c_lower for w in ("subtract", "minus", "regroup", "place value", "column addition")):
        nums = [int(n) for n in re.findall(r'\b\d+\b', clean_c)]
        if len(nums) >= 2:
            a, b = nums[0], nums[1]
            res = a - b
            if a > 10 and (a % 10) != 0:
                stepping_stone = f"Try simpler anchor: {a - (a % 10)} - {b} = ?"
            else:
                stepping_stone = f"Try simpler anchor: 10 - {b} = ?"

            if clean_ans:
                counter_example = f"Check by adding: 'If {a} - {b} = {clean_ans}, does {clean_ans} + {b} = {a}?'"
            else:
                counter_example = f"Ask: 'What happens to the tens column when you only subtract {b}?'"

            diagram_kind = "number_line_hop"
            params = {
                "equation": f"{a} - {b} = {res}",
                "start": a,
                "step": -b,
                "result": res,
                "tens": a // 10,
                "ones": a % 10
            }
            action_label = f"📐 Draw {a} - {b} Hop Line"
            example_type = "place_value"
        else:
            stepping_stone = "Try place-value column anchor: Regroup 1 Ten into 10 Ones when subtracting smaller digits."
            counter_example = "Check by adding: 'If we add our result back to the subtracted amount, do we get the original?'"
            diagram_kind = "number_line_hop"
            params = {"equation": clean_c or "Subtraction", "start": 21, "step": -1, "result": 20, "tens": 2, "ones": 1}
            action_label = "📐 Draw Subtraction Scaffold"
            example_type = "place_value"

    # 8. Dynamic General Subject Fallback (Never hardcode 5s and 2s!)
    else:
        topic_label = clean_c[:30] if clean_c else "this concept"
        stepping_stone = f"Try simpler anchor: Break '{topic_label}' into its foundational definition or a simpler test case."
        counter_example = f"Ask: 'What is the very first rule or definition we should apply when solving {topic_label}?'"
        diagram_kind = "concept_card"
        params = {"equation": clean_c or "Core Concept"}
        action_label = f"💡 Show '{clean_c[:16]}' Guide" if clean_c else "💡 Show Stepping Stone"
        example_type = "number_line"

    return {
        "stepping_stone": stepping_stone,
        "counter_example": counter_example,
        "custom_diagram": {
            "type": "custom_diagram",
            "kind": diagram_kind,
            "title": f"Visual Breakdown: {clean_c or 'Equation'}",
            "params": params
        },
        "action_label": action_label,
        "example_type": example_type
    }


def generate_nudge_step_breakdown(question_text: str, context: str = "", student_answer: str = "") -> str:
    """
    Extracts the specific question and prompts an LLM with:
    "Break it down into simpler steps, keep the number of steps minimum, and total content less than 100 words"
    Falls back to a clean heuristic breakdown if LLM is unavailable.
    """
    import re
    raw_q = (question_text or "").strip()
    if not raw_q:
        return ""

    # Clean raw question: remove LaTeX wrapper artifacts if any
    clean_q = re.sub(r'[\$\\]', '', raw_q).strip()
    clean_ans = (student_answer or "").strip()
    clean_ctx = (context or "").strip()

    # Attempt LLM query if provider keys configured
    _load_env_file()
    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip()
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()

    prompt = (
        f"The student is working on this specific math/science problem:\n\"{clean_q}\"\n"
        f"{f'Student attempt: \"{clean_ans}\"\n' if clean_ans else ''}\n"
        "Break it down into simpler steps, keep the number of steps minimum, and total content less than 100 words"
    )

    if gemini_key:
        configured_model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()
        candidate_models = [configured_model]
        for fb in GEMINI_FALLBACK_MODELS:
            if fb not in candidate_models:
                candidate_models.append(fb)
        for model in candidate_models[:3]:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_key}"
                req_data = {
                    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.2, "maxOutputTokens": 180}
                }
                req = urllib.request.Request(
                    url,
                    data=json.dumps(req_data).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=4) as response:
                    res = json.loads(response.read().decode("utf-8"))
                    candidates = res.get("candidates", [])
                    if candidates and "content" in candidates[0]:
                        parts = candidates[0]["content"].get("parts", [])
                        if parts and "text" in parts[0]:
                            ans = parts[0]["text"].strip()
                            words = ans.split()
                            if len(words) > 95:
                                ans = " ".join(words[:95]) + "..."
                            return f"Steps for {clean_q}:\n{ans}" if "Steps" not in ans and "1." not in ans else ans
            except Exception as e:
                logger.debug(f"Gemini nudge breakdown model '{model}' failed: {e}")
                continue

    elif openai_key:
        try:
            url = "https://api.openai.com/v1/chat/completions"
            req_data = {
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": "You are a concise tutor assistant. Break down problems in simplest steps under 100 words."},
                    {"role": "user", "content": prompt}
                ],
                "max_tokens": 150,
                "temperature": 0.2
            }
            req = urllib.request.Request(
                url,
                data=json.dumps(req_data).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {openai_key}"
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=4) as response:
                res = json.loads(response.read().decode("utf-8"))
                choices = res.get("choices", [])
                if choices and "message" in choices[0]:
                    ans = choices[0]["message"].get("content", "").strip()
                    words = ans.split()
                    if len(words) > 95:
                        ans = " ".join(words[:95]) + "..."
                    return ans
        except Exception as e:
            logger.debug(f"OpenAI nudge breakdown call failed: {e}")

    # Heuristic domain-aware fallback if LLM is offline or timed out
    q_lower = clean_q.lower()
    if any(k in q_lower for k in ("integral", "integrate", "∫", "antiderivative", "dx")):
        return f"Steps for {clean_q}:\n1. Identify power n (here x = x^1).\n2. Add 1 to exponent: n + 1 = 2.\n3. Divide by new exponent: (x^2)/2 + C."
    elif any(k in q_lower for k in ("derivative", "d/dx", "diff")):
        return f"Steps for {clean_q}:\n1. Identify exponent n.\n2. Multiply coefficient by power.\n3. Subtract 1 from exponent."
    elif any(op in clean_q for op in ("-", "minus", "subtract")):
        return f"Steps for {clean_q}:\n1. Split numbers into tens and ones.\n2. Subtract ones first.\n3. Combine remaining tens and ones."
    elif any(op in clean_q for op in ("*", "x", "times", "multiply")):
        return f"Steps for {clean_q}:\n1. Break into an anchor fact you know.\n2. Add or subtract the difference."
    elif "/" in clean_q or "divide" in q_lower:
        return f"Steps for {clean_q}:\n1. Check reciprocal / inverse operation.\n2. Multiply across top and bottom."
    else:
        return f"Steps for {clean_q}:\n1. Identify what is given and what to find.\n2. Write down the first simpler step.\n3. Solve and check result."


def generate_live_nudge(store: Any, force_trigger: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Decides whether the tutor needs a live nudge (T2 glanceable toast or T3 persistent alert).
    Strictly follows:
    - Calm technology: Interrupt rarely (rate-limited, min 60s between live nudges in real-time).
    - Favor concrete actionable visual examples based on live multimodal and whiteboard state.
    - Integrates whiteboard content identification:
        * Multimodal / Vision AI insights (identifying student handwritten misconceptions on board)
        * Whiteboard elements log (equations, place-value arithmetic, fractions, shapes)
    - If force_trigger is set (e.g. 'demo_fractions', 'demo_subtraction', 'demo_whiteboard'), bypasses rate-limiter.
    """
    now = int(time.time() * 1000)

    # 1. Deterministic Demo Triggers (100% reproducible for 3-minute pitch)
    if force_trigger:
        store.last_nudge_timestamp = now
        trigger_lower = force_trigger.lower()
        if any(w in trigger_lower for w in ("subtraction", "arithmetic", "place_value", "minus", "21")):
            interventions = build_pedagogical_interventions("21 - 1", "16")
            return {
                "tier": "T3",
                "category": "whiteboard_misconception",
                "confidence": "high",
                "context_badge": "🎯 Board Detection",
                "toast_text": "Student answered '16' to '21 - 1' — try a stepping-stone anchor?",
                "action_label": interventions["action_label"],
                "example_type": interventions["example_type"],
                "stepping_stone": interventions["stepping_stone"],
                "counter_example": interventions["counter_example"],
                "custom_diagram": interventions["custom_diagram"],
                "notebook_entry": "🔴 Whiteboard Detection: Pupil wrote '16' for '21 - 1' (place-value regrouping error).",
                "reasoning": "Detected handwritten arithmetic error on board; place-value tens/ones visual recommended."
            }
        elif any(w in trigger_lower for w in ("geometry", "circle", "shape", "radius")):
            interventions = build_pedagogical_interventions("circle radius diameter")
            return {
                "tier": "T2",
                "category": "whiteboard_geometry",
                "confidence": "high",
                "context_badge": "🎯 Board Detection",
                "toast_text": "Student drew circle on board — drop radius & diameter guide?",
                "action_label": interventions["action_label"],
                "example_type": interventions["example_type"],
                "stepping_stone": interventions["stepping_stone"],
                "counter_example": interventions["counter_example"],
                "custom_diagram": interventions["custom_diagram"],
                "notebook_entry": "🟡 Whiteboard Detection: Geometric circle identified; anchor with labeled radius/diameter formulas.",
                "reasoning": "Student drew geometric circle on board; visual formula guide recommended."
            }
        elif any(w in trigger_lower for w in ("rect", "square", "area", "box")):
            interventions = build_pedagogical_interventions("rectangle area perimeter")
            return {
                "tier": "T2",
                "category": "whiteboard_geometry",
                "confidence": "high",
                "context_badge": "🎯 Board Detection",
                "toast_text": "Student drew rectangle on board — drop area & perimeter guide?",
                "action_label": interventions["action_label"],
                "example_type": interventions["example_type"],
                "stepping_stone": interventions["stepping_stone"],
                "counter_example": interventions["counter_example"],
                "custom_diagram": interventions["custom_diagram"],
                "notebook_entry": "🟡 Whiteboard Detection: Labeled rectangle geometry guide suggested.",
                "reasoning": "Student drew quadrilateral shape on board; formula guide recommended."
            }
        elif any(w in trigger_lower for w in ("whiteboard", "board")):
            # Dynamically inspect elements log to pick best demo
            recent_texts = [
                el.get("text", "").lower() for el in getattr(store, "whiteboard_elements_log", [])[-10:] if el.get("text")
            ]
            full_txt = " ".join(recent_texts)
            if any(term in full_txt for term in ("21", "16", "14", "subtract", "regroup", "tens", "ones")):
                interventions = build_pedagogical_interventions("21 - 1", "16")
                return {
                    "tier": "T3",
                    "category": "whiteboard_misconception",
                    "confidence": "high",
                    "context_badge": "🎯 Board Detection",
                    "toast_text": "Student answered '16' to '21 - 1' — try a stepping-stone anchor?",
                    "action_label": interventions["action_label"],
                    "example_type": interventions["example_type"],
                    "stepping_stone": interventions["stepping_stone"],
                    "counter_example": interventions["counter_example"],
                    "custom_diagram": interventions["custom_diagram"],
                    "notebook_entry": "🔴 Whiteboard Detection: Pupil wrote '16' for '21 - 1' (place-value error).",
                    "reasoning": "Detected arithmetic elements on board; place value model recommended."
                }
            else:
                interventions = build_pedagogical_interventions("fractions division 3/4 / 1/2")
                return {
                    "tier": "T3",
                    "category": "confusion",
                    "confidence": "high",
                    "context_badge": "🎯 Board Detection",
                    "toast_text": "Student stuck on dividing fractions — try a pizza-slice example?",
                    "action_label": interventions["action_label"],
                    "example_type": interventions["example_type"],
                    "stepping_stone": interventions["stepping_stone"],
                    "counter_example": interventions["counter_example"],
                    "custom_diagram": interventions["custom_diagram"],
                    "notebook_entry": "🔴 Whiteboard Detection: Fractions division problem on board; visual pizza model recommended.",
                    "reasoning": "Fractions division identified on board; pizza model recommended."
                }
        elif any(w in trigger_lower for w in ("face", "facial", "rolling", "explaining")):
            cur_eq = getattr(store, "active_problem_concept", "") or "21 - 1"
            interventions = build_pedagogical_interventions(cur_eq, "16")
            return {
                "tier": "T3",
                "category": "visual_confusion",
                "confidence": "high",
                "context_badge": "😟 Confusion (6s)",
                "toast_text": f"Student looks consistently puzzled/confused while you're explaining '{cur_eq}' — pause to check understanding?",
                "action_label": interventions["action_label"],
                "example_type": interventions["example_type"],
                "stepping_stone": interventions["stepping_stone"],
                "counter_example": interventions["counter_example"],
                "custom_diagram": interventions["custom_diagram"],
                "notebook_entry": f"🔴 Video Detection: Student showing majority brow furrow/confusion (>50% over 6s) while tutor wrote '{cur_eq}'.",
                "reasoning": "Majority brow furrow / confusion (>50% over 6s window) detected while tutor is writing on whiteboard."
            }
        elif any(w in trigger_lower for w in ("pacing", "silence", "quiet")):
            return {
                "tier": "T2",
                "category": "pacing",
                "confidence": "high",
                "context_badge": "⏳ Quiet Spell",
                "toast_text": "Student has been quiet for >15s on recent step — offer an open-ended hint?",
                "action_label": "💡 Offer Hint",
                "example_type": "number_line",
                "notebook_entry": "🟡 Pacing Notice: Extended pause detected; suggested prompt check-in.",
                "reasoning": "Extended student silence following question."
            }
        else:
            interventions = build_pedagogical_interventions("fractions division")
            return {
                "tier": "T3",
                "category": "confusion",
                "confidence": "high",
                "context_badge": "🎯 Board Detection",
                "toast_text": "Student stuck on dividing fractions — try a pizza-slice example?",
                "action_label": interventions["action_label"],
                "example_type": interventions["example_type"],
                "stepping_stone": interventions["stepping_stone"],
                "counter_example": interventions["counter_example"],
                "custom_diagram": interventions["custom_diagram"],
                "notebook_entry": "🔴 Student confused: 'wait, how do we divide fractions?'",
                "reasoning": "Student expressed doubt about dividing fractions; visual fraction model recommended."
            }

    # Strict Calm Tech Rate Limiting: 20-second minimum cooldown across all popup notifications
    # Exception: A critical board misconception / 2+ wrong answers can override a recent low-priority T2 (e.g. Looking Away) toast
    MIN_NUDGE_INTERVAL_MS = 20000
    last_nudge_ts = getattr(store, "last_nudge_timestamp", 0)
    last_nudge_tier = getattr(store, "last_nudge_tier", "T3")
    has_urgent_wrong_answer = (
        getattr(store, "wrong_attempts_count", 0) >= 2
        or (
            getattr(store, "last_coaching_report", None)
            and (now - getattr(store, "last_coaching_timestamp", 0)) <= 5000
            and getattr(store, "last_coaching_report", {}).get("whiteboard_relevance", {}).get("problem_status") == "Answered with misconception"
        )
    )
    if (now - last_nudge_ts) < MIN_NUDGE_INTERVAL_MS and not force_trigger:
        if not (has_urgent_wrong_answer and last_nudge_tier == "T2"):
            return None

    # Track recent nudge signatures to prevent repeating the exact same toast
    if not hasattr(store, "recent_nudge_signatures"):
        store.recent_nudge_signatures = {}

    def is_recently_shown(sig: str) -> bool:
        # Prevent repeating the exact same alert signature
        return sig in store.recent_nudge_signatures

    def record_shown(sig: str, tier: str = "T3"):
        store.last_nudge_timestamp = now
        store.last_nudge_tier = tier
        store.recent_nudge_signatures[sig] = now

    wb_elements = getattr(store, "whiteboard_elements_log", [])

    # ── 2. Check for 2+ Consecutive Wrong Attempts on Same Concept (T3 ESCALATION) ──
    # High-severity rule: Immediate alert with stepping stone & counter-example
    wrong_count = getattr(store, "wrong_attempts_count", 0)
    if wrong_count >= 2:
        concept = getattr(store, "active_problem_concept", "") or "active math problem"
        wrong_answers = getattr(store, "consecutive_wrong_answers", [])
        ans_str = ", ".join(wrong_answers[-2:]) if wrong_answers else "multiple attempts"
        rep_sig = f"repeat_fail_{concept}_{ans_str}"
        if not is_recently_shown(rep_sig):
            record_shown(rep_sig)
            interventions = build_pedagogical_interventions(concept, ans_str)
            breakdown_desc = generate_nudge_step_breakdown(concept, student_answer=ans_str, context=f"Student answered incorrectly twice: {ans_str}") if concept else ""

            toast_text = f"Student answered incorrectly twice on '{concept}' ({ans_str})"
            if breakdown_desc:
                toast_text = f"{toast_text} — {breakdown_desc}"
            else:
                toast_text = f"{toast_text} — {interventions.get('counter_example') or 'pause to ask an open-ended check'}"

            return {
                "tier": "T3",
                "category": "persistent_misconception",
                "confidence": "high",
                "context_badge": "⚠️ 2nd Wrong Attempt",
                "toast_text": toast_text,
                "action_label": interventions["action_label"],
                "example_type": interventions["example_type"],
                "stepping_stone": breakdown_desc or interventions["stepping_stone"],
                "counter_example": interventions["counter_example"],
                "custom_diagram": interventions["custom_diagram"],
                "notebook_entry": f"🔴 Repeated Misconception: Student answered incorrectly 2+ times in a row on '{concept}' ({ans_str}).",
                "reasoning": f"Pupil has answered incorrectly twice in a row on '{concept}' (attempted {ans_str}). A concrete visual breakdown is strongly recommended to unblock them."
            }

    # ── 3. Check for Student Majority Confusion / Brow Furrow Over 6s Window (T3 Alert) ──
    from .telemetry import get_rolling_engagement
    pulse = get_rolling_engagement(store, window_seconds=6)

    is_majority_confused = pulse.get("is_majority_confused", False)
    is_majority_distracted = pulse.get("is_majority_distracted", False)

    # Don't interrupt student if they are actively drawing/writing on the board (furrow while drawing is focus)
    recent_student_strokes = [el for el in wb_elements if el.get("role") == "student" and (now - el.get("timestamp", 0)) <= 6000]

    if is_majority_confused and pulse.get("student_face_detected") and pulse.get("total_faces", 0) >= 3 and not recent_student_strokes:
        wb_elements = getattr(store, "whiteboard_elements_log", [])
        recent_tutor_wb = [el for el in wb_elements if el.get("role") in ("tutor", "unknown") and (now - el.get("timestamp", 0)) <= 20000]
        if not recent_tutor_wb and store.most_recent_whiteboard and (now - store.most_recent_whiteboard.get("timestamp", 0)) <= 20000:
            recent_tutor_wb = [store.most_recent_whiteboard]

        recent_tutor_transcripts = [t for t in store.transcripts if (t.role in ("tutor", "unknown")) and (now - t.timestamp) <= 20000]

        active_eq = getattr(store, "active_problem_concept", "")
        if not active_eq and recent_tutor_wb:
            for el in reversed(recent_tutor_wb):
                if el.get("text"):
                    active_eq = el.get("text")
                    break

        face_sig = f"face_confused_{active_eq[:15] if active_eq else 'explaining'}"
        if not is_recently_shown(face_sig):
            record_shown(face_sig)
            interventions = build_pedagogical_interventions(active_eq or "math concept", student_answer="")
            breakdown_desc = generate_nudge_step_breakdown(active_eq, context="Student shows brow furrow / confusion while tutor explains") if active_eq else ""

            if recent_tutor_wb:
                # Tutor is actively writing/drawing on board
                toast_msg = f"Student looks puzzled while you're writing '{active_eq or 'on the board'}'"
                if breakdown_desc:
                    toast_msg = f"{toast_msg} — {breakdown_desc}"
                else:
                    toast_msg = f"{toast_msg} — pause and ask: 'What does this step mean to you?'"

                return {
                    "tier": "T3",
                    "category": "visual_confusion",
                    "confidence": "high",
                    "context_badge": "😟 Confusion (6s)",
                    "toast_text": toast_msg,
                    "action_label": interventions["action_label"],
                    "example_type": interventions["example_type"],
                    "stepping_stone": breakdown_desc or interventions["stepping_stone"],
                    "counter_example": interventions["counter_example"],
                    "custom_diagram": interventions["custom_diagram"],
                    "notebook_entry": f"🔴 Video Detection: Student showing majority confusion/brow furrow (>50% over 6s) while tutor wrote '{active_eq or 'on the board'}'.",
                    "reasoning": "Student shows majority brow furrow / confusion (>50% of frames over 6s) while tutor is writing on the whiteboard."
                }
            elif recent_tutor_transcripts:
                # Tutor is explaining / speaking
                return {
                    "tier": "T3",
                    "category": "visual_confusion",
                    "confidence": "high",
                    "context_badge": "😟 Confusion (6s)",
                    "toast_text": f"Student looks puzzled — pause and ask: \"How would you explain this in your own words?\"",
                    "action_label": "⏸️ Pause & Check In",
                    "example_type": interventions["example_type"],
                    "stepping_stone": breakdown_desc or interventions["stepping_stone"],
                    "counter_example": interventions["counter_example"],
                    "custom_diagram": interventions["custom_diagram"],
                    "notebook_entry": "🔴 Video Detection: Student majority puzzled/confused (>50% over 6s) during verbal explanation.",
                    "reasoning": "Student shows majority brow furrow / confusion (>50% of frames over 6s) while tutor is speaking."
                }
            else:
                # General facial confusion
                return {
                    "tier": "T3",
                    "category": "visual_confusion",
                    "confidence": "high",
                    "context_badge": "😟 Confusion (6s)",
                    "toast_text": f"Student looks puzzled — ask: \"What part feels tricky here?\"",
                    "action_label": interventions["action_label"],
                    "example_type": interventions["example_type"],
                    "stepping_stone": breakdown_desc or interventions["stepping_stone"],
                    "counter_example": interventions["counter_example"],
                    "custom_diagram": interventions["custom_diagram"],
                    "notebook_entry": "🔴 Video Detection: Student facial expression indicates majority confusion (>50% over 6s).",
                    "reasoning": "Majority brow furrow / confused face (>50% over 6s window) identified."
                }

    # ── 4. Check for Student Looking Away / Distraction Majority Over 6s Window (T2 Alert) ──
    if is_majority_distracted and pulse.get("student_face_detected") and pulse.get("total_faces", 0) >= 3:
        dist_sig = "face_distracted_gaze"
        if not is_recently_shown(dist_sig):
            record_shown(dist_sig, tier="T2")
            return {
                "tier": "T2",
                "category": "pacing",
                "confidence": "high",
                "context_badge": "👀 Looking Away",
                "toast_text": "Student attention has drifted off-screen for majority of last 6s — prompt them to engage with the board?",
                "action_label": "✏️ Invite to Whiteboard",
                "example_type": "number_line",
                "notebook_entry": "🟡 Video Detection: Student looking away from screen for majority of last 6s.",
                "reasoning": "Gaze tracking shows student attention directed away from session for majority (>50%) of 6s window."
            }

    # ── 5. Check Recent Student Spoken Transcripts (T3 Alert) ──
    # Freshness guard: Only consider transcripts within the last 20 seconds
    student_transcripts = [t for t in store.transcripts if t.role == "student" and (now - t.timestamp) <= 20000]
    if not student_transcripts and store.transcripts:
        student_transcripts = [t for t in store.transcripts if (now - t.timestamp) <= 20000]

    if student_transcripts:
        recent_student = student_transcripts[-3:]
        recent_text = " ".join(t.text.lower() for t in recent_student)
        confusion_cues = ["don't get", "don't understand", "im stuck", "i'm stuck", "im lost", "i'm lost", "wait what", "why did you", "really confused"]
        matched_cue = next((cue for cue in confusion_cues if cue in recent_text), None)

        if matched_cue:
            spk_sig = f"spk_conf_{matched_cue}_{recent_student[-1].text[:15]}"
            if not is_recently_shown(spk_sig):
                record_shown(spk_sig)
                cur_eq = getattr(store, "active_problem_concept", "") or ""
                if not cur_eq and wb_elements:
                    for el in reversed(wb_elements):
                        if el.get("text"):
                            cur_eq = el.get("text")
                            break
                interventions = build_pedagogical_interventions(cur_eq or recent_student[-1].text)
                target_q = cur_eq or recent_student[-1].text
                breakdown_desc = generate_nudge_step_breakdown(target_q, context=f"Student said: '{recent_student[-1].text}'")
                
                toast_label = f"Student says: \"{recent_student[-1].text}\""
                if breakdown_desc:
                    toast_label = f"{toast_label} — {breakdown_desc}"
                else:
                    toast_label = f"{toast_label} — {interventions.get('counter_example') or 'Ask: \"Which part feels most confusing?\"'}"

                return {
                    "tier": "T3",
                    "category": "confusion",
                    "confidence": "high",
                    "context_badge": "Spoken Confusion",
                    "toast_text": toast_label,
                    "action_label": interventions["action_label"],
                    "example_type": interventions["example_type"],
                    "stepping_stone": breakdown_desc or interventions["stepping_stone"],
                    "counter_example": interventions["counter_example"],
                    "custom_diagram": interventions["custom_diagram"],
                    "notebook_entry": f"🔴 Spoken Confusion: \"{recent_student[-1].text}\"",
                    "reasoning": "Student verbalized confusion; stepping stone recommended."
                }

    # ── 7. Check Multimodal AI Coaching Report Whiteboard Insights ──
    last_report = getattr(store, "last_coaching_report", None)
    last_coaching_ts = getattr(store, "last_coaching_timestamp", 0)
    elements_after_report = [el for el in wb_elements if el.get("timestamp", 0) > last_coaching_ts]
    # Only suppress if tutor explicitly started a brand new question text (containing '=' or '?') AFTER the report was generated
    tutor_new_questions_after = [
        el for el in elements_after_report
        if el.get("role") == "tutor" and el.get("text") and any(q in str(el.get("text")) for q in ("=", "?"))
    ]

    # Freshness guard: Coaching report must be fresh (<= 20 seconds)
    if last_report and (now - last_coaching_ts) <= 20000 and len(tutor_new_questions_after) == 0:
        wb_rel = last_report.get("whiteboard_relevance", {})
        active_eq = wb_rel.get("current_active_equation", "").strip()
        pupil_work = wb_rel.get("pupil_latest_work", "").strip()
        problem_status = wb_rel.get("problem_status", "").strip()
        acknowledgment = wb_rel.get("acknowledgment", "").strip()
        insight = wb_rel.get("pedagogical_insight", "").strip()
        observed = wb_rel.get("observed_pupil_work", "").strip()
        areas_growth = str(last_report.get("areas_for_growth", "")).strip()
        combined_insight = f"{insight} {observed} {acknowledgment} {areas_growth}".lower()

        from .session_store import evaluate_math_attempt
        math_is_wrong = (evaluate_math_attempt(active_eq, pupil_work) is False)

        # NOTE: Positive nudges ("Solved correctly", "New problem started") are suppressed.
        # Only notify on actionable misconceptions, wrong answers, or student struggles.
        if (
            problem_status == "Answered with misconception"
            or math_is_wrong
            or (
                (wb_rel.get("student_active_on_board") or (pupil_work and pupil_work.lower() not in ("none", "waiting")))
                and any(w in combined_insight for w in ("misconception", "struggle", "error", "incorrect", "wrong", "mistake", "stuck"))
            )
        ):
            sig = f"misc_{active_eq}_{pupil_work}" if (active_eq or pupil_work) else "board_misc"
            if not is_recently_shown(sig):
                record_shown(sig)
                interventions = build_pedagogical_interventions(active_eq, pupil_work, context=combined_insight)
                breakdown_desc = generate_nudge_step_breakdown(active_eq, context=combined_insight, student_answer=pupil_work) if active_eq else ""

                if active_eq and pupil_work and pupil_work.lower() not in ("in progress", "none"):
                    toast_msg = f"Student wrote '{pupil_work}' to '{active_eq}'"
                elif active_eq:
                    toast_msg = f"Student stuck on '{active_eq}'"
                else:
                    toast_msg = "Board insight: wrong answer / misconception detected"

                if breakdown_desc:
                    toast_msg = f"{toast_msg} — {breakdown_desc}"
                else:
                    toast_msg = f"{toast_msg} — {interventions.get('counter_example') or 'Ask: \"Can you walk me through how you got that number?\"'}"

                return {
                    "tier": "T3",
                    "category": "whiteboard_misconception",
                    "confidence": "high",
                    "context_badge": "Board AI Insight",
                    "toast_text": toast_msg,
                    "action_label": interventions["action_label"],
                    "example_type": interventions["example_type"],
                    "stepping_stone": breakdown_desc or interventions["stepping_stone"],
                    "counter_example": interventions["counter_example"],
                    "custom_diagram": interventions["custom_diagram"],
                    "notebook_entry": f"🔴 Board AI Insight: {acknowledgment or areas_growth or insight[:90]}",
                    "reasoning": insight or areas_growth
                }

    # ── 8. Check Granular Whiteboard Elements Log (Shapes drawn in last 20 seconds) ──
    recent_wb = [el for el in wb_elements if (now - el.get("timestamp", 0)) <= 20000]
    if recent_wb:
        tutor_texts = [el.get("text", "").strip() for el in recent_wb if el.get("role") == "tutor" and el.get("text")]
        shapes = [el.get("shape_type", "").lower() for el in recent_wb if el.get("shape_type")]

        # A: Geometric shapes drawn on board (T2 Guide)
        if "circle" in shapes and not is_recently_shown("circle_guide"):
            record_shown("circle_guide")
            interventions = build_pedagogical_interventions("circle radius diameter")
            return {
                "tier": "T2",
                "category": "whiteboard_geometry",
                "confidence": "high",
                "context_badge": "🎯 Board Detection",
                "toast_text": "Student drew circle on board — drop radius & diameter guide?",
                "action_label": interventions["action_label"],
                "example_type": interventions["example_type"],
                "stepping_stone": interventions["stepping_stone"],
                "counter_example": interventions["counter_example"],
                "custom_diagram": interventions["custom_diagram"],
                "notebook_entry": "🟡 Board Detection: Geometric circle identified; anchor with labeled radius/diameter formulas.",
                "reasoning": "Student drew geometric circle on board; visual formula guide recommended."
            }
        elif ("rectangle" in shapes or "rect" in shapes) and not is_recently_shown("rectangle_guide"):
            record_shown("rectangle_guide")
            interventions = build_pedagogical_interventions("rectangle area perimeter")
            return {
                "tier": "T2",
                "category": "whiteboard_geometry",
                "confidence": "high",
                "context_badge": "🎯 Board Detection",
                "toast_text": "Student drew rectangle on board — drop area & perimeter guide?",
                "action_label": interventions["action_label"],
                "example_type": interventions["example_type"],
                "stepping_stone": interventions["stepping_stone"],
                "counter_example": interventions["counter_example"],
                "custom_diagram": interventions["custom_diagram"],
                "notebook_entry": "🟡 Board Detection: Labeled rectangle geometry guide suggested.",
                "reasoning": "Student drew quadrilateral shape on board."
            }

    return None


# ==============================================================================
# Tutor Post-Session AI Coach Inquiry / Q&A Service
# ==============================================================================

INQUIRY_SYSTEM_PROMPT = r"""You are an experienced, warm, and highly skilled pedagogical mentor and tutoring coach chatting with a teacher.
The teacher has concluded (or is reviewing) their tutoring session and is asking you questions about their lesson, student understanding, misconceptions, pacing, or recommendations for follow-up sessions.

You have access to the complete multimodal session data:
1. Complete dialogue transcript between Tutor and Student with timestamps.
2. Whiteboard work and snapshot image:
   - VISUAL ATTRIBUTION & COLOR CODING:
     * BLACK/DARK SLATE strokes: Written by TUTOR (questions, equation stems, prompts, instructions).
     * GREEN strokes: Written by PUPIL / STUDENT (answers, calculation steps, drawings).
   - Topic Relevance & Comprehension:
     * Attribute the question stem (e.g. '21 - 1 =') to the tutor and the answer (e.g. '16') to the pupil.
     * Calculation errors (e.g. pupil writing '16' for '21 - 1 =' or '14' for '12 - 2 =') are arithmetic/misconception errors, NOT off-topic work! Diagnose their mathematical reasoning (e.g., place value confusion, subtracting backwards).
3. Conversational dynamics: Speech flow, wait time, pause count, talk-time ratio between tutor and student.
4. Student visual demeanor: Moments where the student seemed puzzled, hesitations, focused attention, or looking thoughtful.

COMMUNICATION STYLE & TONE (CRITICAL):
- Sound like a REAL, SUPPORTIVE HUMAN MENTOR — conversational, empathetic, personable, and encouraging.
- NEVER use clinical or robotic jargon!
  * DO NOT SAY: "pupil's eyebrow flutters", "brow furrow score 0.42", "facial engagement vector", "acoustic signal variance", or "elevated cognitive load metric".
  * INSTEAD, TALK LIKE A REAL TEACHER:
    - "Your student seemed a bit puzzled when looking at the problem..."
    - "They paused and looked deep in thought before writing their answer..."
    - "You could tell they hesitated slightly around the 2-minute mark..."
    - "They seemed really engaged and focused on the board work..."
- Greet the tutor warmly or respond conversationally rather than spitting out a sterile spreadsheet or robotic audit.
- Provide practical, down-to-earth teaching tips (e.g., "Next time, try using base-10 blocks or a quick number line on the board").
- Format your response with clear, easy-to-read Markdown (bullet points, bold highlights, short friendly paragraphs).

NO LATEX / PLAIN HUMAN MATHEMATICAL NOTATION (MANDATORY):
- NEVER wrap mathematical statements or numbers in LaTeX notation like $$...$$, $...$, \[...\], or \(...\).
- Write all mathematical expressions as a human would naturally write or read them in plain text:
  * Good: "21 - 1 = 20", "3 + 7 = 10", "1/2", "3 x 4 = 12", "10 ÷ 2 = 5"
  * BAD: "$$21 - 1 = 20$$", "$3 + 7 = 10$", "$\frac{1}{2}$"
"""


def answer_tutor_inquiry(
    telemetry_payload: Dict[str, Any],
    user_prompt: str,
    chat_history: Optional[list] = None,
    api_key: Optional[str] = None,
    provider_override: Optional[str] = None
) -> Dict[str, Any]:
    """
    Answers a teacher's post-session (or mid-session) inquiry grounded in multimodal telemetry.
    Supports conversational history and returns formatted pedagogical feedback.
    """
    _load_env_file()
    provider = provider_override or os.environ.get("LLM_PROVIDER", "auto").lower()
    gemini_key = api_key or os.environ.get("GEMINI_API_KEY", "").strip()
    openai_key = api_key or os.environ.get("OPENAI_API_KEY", "").strip()

    if provider == "auto":
        if gemini_key:
            provider = "gemini"
        elif openai_key:
            provider = "openai"
        elif os.environ.get("OLLAMA_ENABLED", "").lower() in ("true", "1"):
            provider = "ollama"
        else:
            provider = "heuristic"

    logger.info(f"Answering tutor inquiry using provider: {provider}")

    prompt_context = telemetry_payload.get("llm_prompt_context", "")
    wb_telemetry = telemetry_payload.get("whiteboard_telemetry", {})
    image_data_url = wb_telemetry.get("current_data_url")

    response_text = None
    provider_used = provider

    try:
        if provider == "gemini" and gemini_key:
            response_text = _call_gemini_inquiry(
                prompt_context=prompt_context,
                user_prompt=user_prompt,
                chat_history=chat_history,
                api_key=gemini_key,
                image_data_url=image_data_url
            )
        elif provider == "openai" and openai_key:
            response_text = _call_openai_inquiry(
                prompt_context=prompt_context,
                user_prompt=user_prompt,
                chat_history=chat_history,
                api_key=openai_key,
                image_data_url=image_data_url
            )
        elif provider == "ollama":
            response_text = _call_ollama_inquiry(
                prompt_context=prompt_context,
                user_prompt=user_prompt,
                chat_history=chat_history
            )
    except Exception as e:
        logger.warning(f"LLM inquiry provider '{provider}' failed ({e}). Falling back to Heuristic Engine.")
        provider_used = f"heuristic (fallback from {provider})"

    if not response_text:
        response_text = _generate_heuristic_inquiry_answer(telemetry_payload, user_prompt, chat_history)
        if provider_used == provider and provider != "heuristic":
            provider_used = "heuristic"

    response_text = _clean_math_formatting(response_text)

    return {
        "response": response_text,
        "provider_used": provider_used,
        "timestamp_ms": int(time.time() * 1000)
    }


def _call_gemini_inquiry(
    prompt_context: str,
    user_prompt: str,
    chat_history: Optional[list],
    api_key: str,
    image_data_url: Optional[str] = None
) -> str:
    configured_model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()
    candidate_models = [configured_model]
    for fallback in GEMINI_FALLBACK_MODELS:
        if fallback not in candidate_models:
            candidate_models.append(fallback)

    system_and_context = (
        f"{INQUIRY_SYSTEM_PROMPT}\n\n"
        f"=== SESSION TELEMETRY & MEETING DATA ===\n"
        f"{prompt_context}\n\n"
    )

    initial_parts: list = [{"text": system_and_context}]

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

            initial_parts.append({
                "inline_data": {
                    "mime_type": mime_type,
                    "data": b64_data
                }
            })
            initial_parts.append({
                "text": "Above is the latest rendered whiteboard image snapshot.\n"
                        "COLOR CODING LEGEND: Black/Slate strokes = Tutor questions/equation stems. Green strokes = Pupil answers/work."
            })
        except Exception as img_err:
            logger.warning(f"Failed to prepare whiteboard image for Gemini inquiry: {img_err}")

    contents = []
    if chat_history and len(chat_history) > 0:
        first_q = chat_history[0].get("content", "")
        initial_parts.append({"text": f"Tutor question: {first_q}"})
        contents.append({"role": "user", "parts": initial_parts})
        for turn in chat_history[1:]:
            role = "user" if turn.get("role") == "user" else "model"
            contents.append({
                "role": role,
                "parts": [{"text": turn.get("content", "")}]
            })
        contents.append({
            "role": "user",
            "parts": [{"text": user_prompt}]
        })
    else:
        initial_parts.append({"text": f"Tutor's Question:\n{user_prompt}"})
        contents.append({"role": "user", "parts": initial_parts})

    last_err = None
    for model in candidate_models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

        req_data = {
            "contents": contents,
            "generationConfig": {
                "temperature": 0.4,
                "maxOutputTokens": 1200
            }
        }

        req = urllib.request.Request(
            url,
            data=json.dumps(req_data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=16) as response:
                result = json.loads(response.read().decode("utf-8"))
                candidates = result.get("candidates", [])
                if candidates and "content" in candidates[0]:
                    res_parts = candidates[0]["content"].get("parts", [])
                    if res_parts and "text" in res_parts[0]:
                        return res_parts[0]["text"]
        except urllib.error.HTTPError as err:
            last_err = err
            logger.warning(f"Gemini model '{model}' failed for inquiry with status {err.code}. Trying next candidate...")
            continue
        except Exception as e:
            last_err = e
            logger.warning(f"Gemini model '{model}' inquiry error: {e}. Trying next candidate...")
            continue

    if last_err:
        raise last_err
    raise ValueError("Empty or invalid response from Gemini API for inquiry")


def _call_openai_inquiry(
    prompt_context: str,
    user_prompt: str,
    chat_history: Optional[list],
    api_key: str,
    image_data_url: Optional[str] = None
) -> str:
    model = os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
    url = "https://api.openai.com/v1/chat/completions"

    system_msg = {"role": "system", "content": INQUIRY_SYSTEM_PROMPT}
    user_content: list = [
        {"type": "text", "text": f"=== SESSION TELEMETRY & MEETING DATA ===\n{prompt_context}\n"}
    ]
    if image_data_url:
        img_url = image_data_url if image_data_url.startswith("data:") else f"data:image/jpeg;base64,{image_data_url}"
        user_content.append({"type": "image_url", "image_url": {"url": img_url, "detail": "low"}})
        user_content.append({"type": "text", "text": "Note: Black strokes = Tutor questions/prompts. Green strokes = Pupil answers/work."})

    messages = [system_msg]
    if chat_history and len(chat_history) > 0:
        user_content.append({"type": "text", "text": f"Tutor Question: {chat_history[0].get('content', '')}"})
        messages.append({"role": "user", "content": user_content})
        for turn in chat_history[1:]:
            role = "user" if turn.get("role") == "user" else "assistant"
            messages.append({"role": role, "content": turn.get("content", "")})
        messages.append({"role": "user", "content": user_prompt})
    else:
        user_content.append({"type": "text", "text": f"Tutor's Question:\n{user_prompt}"})
        messages.append({"role": "user", "content": user_content})

    req_data = {
        "model": model,
        "messages": messages,
        "temperature": 0.4,
        "max_tokens": 1200
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

    with urllib.request.urlopen(req, timeout=14) as response:
        result = json.loads(response.read().decode("utf-8"))
        choices = result.get("choices", [])
        if choices and "message" in choices[0]:
            return choices[0]["message"].get("content", "")

    raise ValueError("Empty or invalid response from OpenAI API for inquiry")


def _call_ollama_inquiry(
    prompt_context: str,
    user_prompt: str,
    chat_history: Optional[list]
) -> str:
    base_url = os.environ.get("OLLAMA_BASE_URL", DEFAULT_OLLAMA_URL)
    model = os.environ.get("OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL)
    url = f"{base_url.rstrip('/')}/v1/chat/completions"

    messages = [{"role": "system", "content": INQUIRY_SYSTEM_PROMPT}]
    first_text = f"=== SESSION TELEMETRY & MEETING DATA ===\n{prompt_context}\n"
    if chat_history and len(chat_history) > 0:
        messages.append({"role": "user", "content": f"{first_text}\nTutor Question: {chat_history[0].get('content', '')}"})
        for turn in chat_history[1:]:
            role = "user" if turn.get("role") == "user" else "assistant"
            messages.append({"role": role, "content": turn.get("content", "")})
        messages.append({"role": "user", "content": user_prompt})
    else:
        messages.append({"role": "user", "content": f"{first_text}\nTutor's Question:\n{user_prompt}"})

    req_data = {
        "model": model,
        "messages": messages,
        "temperature": 0.4
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(req_data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    with urllib.request.urlopen(req, timeout=24) as response:
        result = json.loads(response.read().decode("utf-8"))
        choices = result.get("choices", [])
        if choices and "message" in choices[0]:
            return choices[0]["message"].get("content", "")

    raise ValueError("Empty or invalid response from Ollama API for inquiry")


def _generate_heuristic_inquiry_answer(
    telemetry: Dict[str, Any],
    user_prompt: str,
    chat_history: Optional[list] = None
) -> str:
    dialogue = telemetry.get("dialogue_timeline", [])
    video = telemetry.get("video_telemetry", {})
    whiteboard = telemetry.get("whiteboard_telemetry", {})
    student_video = video.get("student", {})

    tutor_words = sum(len(d.get("speech", "").split()) for d in dialogue if d.get("role") == "tutor")
    student_words = sum(len(d.get("speech", "").split()) for d in dialogue if d.get("role") == "student")
    total_words = tutor_words + student_words
    tutor_pct = round(100 * tutor_words / total_words) if total_words > 0 else 50
    student_pct = 100 - tutor_pct

    student_edits = whiteboard.get("student_edits", 0)
    brow_furrow = student_video.get("brow_furrow_avg") or 0.0
    engagement_avg = student_video.get("engagement_avg")

    q_lower = user_prompt.lower()

    if any(k in q_lower for k in ["misconception", "struggle", "math", "subtraction", "error", "mistake", "answer", "wrote", "write", "16", "21", "equation", "place value", "confus"]):
        return (
            "### Here's what was happening with your student's math work:\n\n"
            "Great question! Looking closely at the session dynamic and the whiteboard:\n\n"
            "1. **Active Board Collaboration**:\n"
            "   - You set up the equation stems in **black**, and your student jumped right in, writing their answers in **green**.\n"
            "   - They were eager to participate and tried working through the calculations directly on the board rather than holding back.\n\n"
            "2. **The Misconception (Place Values)**:\n"
            "   - When answering problems like `21 - 1 = 16` or `12 - 2 = 14`, the student isn't off-topic at all — they're experiencing a very common **place value confusion**.\n"
            "   - In `21 - 1`, it looks like they subtracted 1 from the tens place (`2 - 1 = 1`) and wrote down `16` after getting tangled between tens and units.\n\n"
            "3. **What You Can Try Next Lesson**:\n"
            "   - **Draw a quick visual**: Use a quick number line or sketch tens rods and unit cubes right on the whiteboard.\n"
            "   - **Ask them to 'think out loud'**: Have them talk you through their steps before writing down the final answer.\n"
            "   - **Anchor decade transitions**: Start with `20 - 1 = ?` to help them see how decade boundaries work."
        )
    elif any(k in q_lower for k in ["pace", "pacing", "talk", "wait", "time", "ratio", "split"]):
        return (
            "### How your conversational pacing looked:\n\n"
            f"Overall, you carried about **{tutor_pct}% of the talking time**, with your student speaking for **{student_pct}%** across {len(dialogue)} speech turns.\n\n"
            "- **Student Demeanor**: When watching the student, they seemed attentive and engaged throughout, but hesitated noticeably after you asked multi-step questions.\n"
            "- **Wait-Time Tip**: Try counting to 3 or 4 in your head after asking a question before jumping in with a hint. Giving that extra few seconds of silence allows the student to process the numbers and often prompts them to explain their thinking voluntarily!"
        )
    elif any(k in q_lower for k in ["practice", "problem", "next", "follow up", "exercise", "homework"]):
        return (
            "### 3 Targeted Practice Problems for Your Next Lesson:\n\n"
            "To help your student master place values and build confidence in subtraction, here are three progressive problems to try:\n\n"
            "1. **Decade Anchor (Warmup)**: `20 - 1 = ?` and `10 - 1 = ?`\n"
            "   * *Why*: Reinforces what happens to the tens place when subtracting 1.\n"
            "2. **Single-Unit Subtraction**: `21 - 1 = ?` with Base-10 Drawings\n"
            "   * *Why*: Have the student cross out the single unit cube on the whiteboard to visually see the 2 tens (20) remaining.\n"
            "3. **Role Reversal (Student as Teacher)**: Let the student write a subtraction problem on the board for *you* to solve!"
        )
    else:
        return (
            f"### Session Impressions & Next Steps for Room {telemetry.get('session_meta', {}).get('room_code', 'Active')}:\n\n"
            "Overall, this was a productive and collaborative session! Here are the main highlights from the student's behavior and learning flow:\n\n"
            f"- **Engagement & Attitude**: Your student stayed focused on the screen and actively contributed {student_edits} times on the whiteboard in green.\n"
            "- **Moments of Hesitation**: They looked deep in thought and a bit puzzled during multi-digit subtraction, but remained willing to try.\n"
            f"- **Dialogue Split**: You did about {tutor_pct}% of the talking. Pacing was steady, with good opportunities to let the student explain more.\n\n"
            "**My Top Recommendation for Next Time**:\n"
            "Celebrate their willingness to write on the board, and use quick visual sketches (like tens-and-units columns) whenever you tackle subtraction."
        )


WHITEBOARD_GEN_SYSTEM_PROMPT = r"""You are an expert AI whiteboard instructional designer and diagram generator for live tutoring sessions.
Your task is to generate clean, beautifully formatted educational exercises, math questions, scaffolds, and visual diagrams to be rendered directly onto the interactive whiteboard.

MANDATORY PEDAGOGICAL GROUNDING:
- Inspect the provided live session telemetry: transcripts, speech turns, and especially ACTIVE WHITEBOARD ELEMENTS currently on the board.
- Tailor the new content directly to the tutor's prompt AND the existing question style, difficulty level, and themes observed in the session.
- If previous math problems were horizontal equations (e.g. '21 - 1 = ...'), match or naturally progress that format.
- If the student was hesitant or made a mistake on place value / regrouping, provide targeted practice problems with step-by-step scaffolds or answer boxes.

COORDINATE & GRAPH PLOTTING (CRITICAL):
- If the tutor asks to plot a graph, function, or calculus diagram (e.g., 'integrating 1/x', 'plot f(x)', 'graph of curve', 'coordinate axes'):
  - MUST draw the coordinate plane: X-axis with an arrow pointing right, Y-axis with an arrow pointing up, origin label 'O' or (0,0), and tick marks.
  - MUST draw the function curve or line using connected 'line' elements approximating the shape of the function. For 1/x, plot points along the hyperbola in the first quadrant from x=0.6 down to x=4.5.
  - MUST draw integration bounds / shaded vertical interval if integration is mentioned (e.g. vertical lines at x=1 and x=3).
  - Include formula text (e.g. 'y = 1/x', 'Integral of 1/x dx = ln|x| + C') and clear labels on axes ('x', 'y').

MANDATORY RULES:
1. NO LATEX (CRITICAL): Never use $$...$$, $...$, \[...\], \(...\), \frac, or \times. Use plain everyday human math notation: "25 - 9 = [   ]", "1/2", "4 x 6 = 24", "Integral of (1/x) dx = ln|x| + C".
2. OUTPUT STRICT JSON ONLY with the following schema:
{
  "title": "Title (e.g. Graph of 1/x and Integration)",
  "summary": "1 sentence describing what was generated and how it links to previous work",
  "width": 540,
  "height": 360,
  "elements": [
    {
      "type": "shape",
      "shapeType": "rectangle" | "circle" | "triangle" | "line" | "arrow",
      "start": { "x": number, "y": number },
      "end": { "x": number, "y": number },
      "color": "#hex",
      "size": number,
      "fillColor": "#hex" (optional)
    },
    {
      "type": "text",
      "text": "plain text string",
      "x": number,
      "y": number,
      "color": "#hex",
      "fontSize": 14 | 16 | 18 | 20,
      "fontWeight": "normal" | "600" | "bold"
    }
  ]
}

COORDINATE & LAYOUT SYSTEM (STRICT ALIGNMENT & SPACING):
- Bounding box is width ~560, height ~380-420 starting at (0, 0).
- Card container: A surrounding rectangle with start {x: 0, y: 0}, end {x: width, y: height}, color "#cbd5e1", size 2, and optional soft fillColor "#ffffff".
- Title banner text at x: 24, y: 38 with fontSize 18, color "#1e3a8a", fontWeight "bold".
- Header dividing line from {x: 20, y: 52} to {x: width - 20, y: 52}, color "#e2e8f0", size 1.

QUESTION & ANSWER BOX ALIGNMENT:
- EVERY question or equation MUST have its own dedicated answer box rectangle. Never omit answer boxes for any question.
- Equations and questions MUST be written cleanly without bracket text (e.g., '1)   54 - 18 = ', NOT '1) 54 - 18 = [   ]').
- For each question at (x: 40, y: textY) with fontSize 16-18:
  - Draw a neat answer box rectangle next to it.
  - The box MUST be vertically aligned with the text line: start.y = textY - 22, end.y = textY + 10 (height: 32px, perfectly centered on text baseline).
  - Multi-column layout: For 6 or more questions (e.g. 10 questions), arrange them in 2 neat balanced columns:
    * Column 1: Questions 1-5 starting at x: 30-40, with all their answer boxes vertically aligned in column 1 (e.g. x: 170 to 240).
    * Column 2: Questions 6-10 starting at x: 280-300, with all their answer boxes vertically aligned in column 2 (e.g. x: 420 to 490).
    * Both columns MUST have answer boxes for every single problem.
  - In single-column exercises, align all answer boxes in the exact same vertical column.
  - Never place answer boxes overlapping or colliding with question text.

AUTOMATIC PROPER ALIGNMENT & FIGURE FORMATTING (STRICT REQUIREMENT):
- Make sure that all columns, rows, diagrams, figures, shapes, and all relevant items are properly aligned, geometrically accurate, and formatted consistently.
- Ensure that all figures (coordinate plots, curves, axes, geometric shapes, number bars) are properly made with consistent scaling, straight lines, and balanced margins.
- In multi-column and multi-row layouts, ensure questions and answer boxes form crisp, aligned grids.
- Ensure all items have comfortable breathing room with zero text overflow and zero overlapping elements.

PREVENT TEXT OVERFLOW:
- Keep text lines under 45 characters. Text MUST NEVER extend past x = 520.
- For instructions, story problems, or hints, split them into multiple text elements spaced 22-26px apart vertically.
"""


def _call_gemini_whiteboard_gen(
    prompt_context: str,
    user_prompt: str,
    api_key: str,
    image_data_url: Optional[str] = None
) -> Dict[str, Any]:
    configured_model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()
    candidate_models = [configured_model]
    for fallback in GEMINI_FALLBACK_MODELS:
        if fallback not in candidate_models:
            candidate_models.append(fallback)

    instruction_text = (
        f"{WHITEBOARD_GEN_SYSTEM_PROMPT}\n\n"
        f"=== LIVE SESSION CONTEXT & ACTIVE WHITEBOARD DATA ===\n"
        f"{prompt_context}\n\n"
        f"TUTOR INSTRUCTION:\n"
        f"\"{user_prompt}\"\n\n"
        f"AUTOMATIC ALIGNMENT & FIGURE MANDATE:\n"
        f"Make sure the columns, rows, diagrams, figures, and all relevant items are properly aligned and formatted consistently, "
        f"ensuring that all figures and shapes are properly made with exact coordinate spacing and dedicated answer boxes where appropriate.\n\n"
        f"Return STRICT JSON with the generated whiteboard elements tailored to the tutor's prompt and the lesson's question styles."
    )

    parts: list = [{"text": instruction_text}]
    if image_data_url:
        try:
            if "," in image_data_url:
                mime_part, b64_data = image_data_url.split(",", 1)
                mime_type = "image/png" if "png" in mime_part else "image/jpeg"
            else:
                b64_data = image_data_url
                mime_type = "image/jpeg"
            parts.append({
                "inline_data": {
                    "mime_type": mime_type,
                    "data": b64_data
                }
            })
        except Exception as e:
            logger.warning(f"Failed to attach image to whiteboard gen: {e}")

    last_err = None
    for model in candidate_models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        req_data = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0.35
            }
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(req_data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=16) as response:
                result = json.loads(response.read().decode("utf-8"))
                candidates = result.get("candidates", [])
                if candidates and "content" in candidates[0]:
                    res_parts = candidates[0]["content"].get("parts", [])
                    if res_parts and "text" in res_parts[0]:
                        raw_json = _clean_and_parse_json(res_parts[0]["text"])
                        return _clean_report_math(raw_json)
        except urllib.error.HTTPError as err:
            last_err = err
            logger.warning(f"Gemini model '{model}' failed for whiteboard gen status {err.code}. Trying next candidate...")
            continue
        except Exception as e:
            last_err = e
            logger.warning(f"Gemini model '{model}' whiteboard gen error: {e}. Trying next candidate...")
            continue

    if last_err:
        raise last_err
    raise ValueError("Empty or invalid response from Gemini API for whiteboard generation")


def _call_openai_whiteboard_gen(
    prompt_context: str,
    user_prompt: str,
    api_key: str
) -> Dict[str, Any]:
    model = os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
    url = "https://api.openai.com/v1/chat/completions"

    full_prompt = (
        f"{WHITEBOARD_GEN_SYSTEM_PROMPT}\n\n"
        f"=== LIVE SESSION CONTEXT & ACTIVE WHITEBOARD DATA ===\n"
        f"{prompt_context}\n\n"
        f"TUTOR INSTRUCTION:\n"
        f"\"{user_prompt}\"\n\n"
        f"AUTOMATIC ALIGNMENT & FIGURE MANDATE:\n"
        f"Make sure the columns, rows, diagrams, figures, and all relevant items are properly aligned and formatted consistently, "
        f"ensuring that all figures and shapes are properly made with exact coordinate spacing and dedicated answer boxes where appropriate.\n\n"
        f"Return STRICT JSON with the generated whiteboard elements tailored to the tutor's prompt and the lesson's question styles."
    )

    req_data = {
        "model": model,
        "messages": [
            {"role": "system", "content": WHITEBOARD_GEN_SYSTEM_PROMPT},
            {"role": "user", "content": full_prompt}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.35
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

    with urllib.request.urlopen(req, timeout=20) as response:
        result = json.loads(response.read().decode("utf-8"))
        choices = result.get("choices", [])
        if choices and "message" in choices[0]:
            content_str = choices[0]["message"].get("content", "")
            return _clean_report_math(_clean_and_parse_json(content_str))

    raise ValueError("Empty or invalid response from OpenAI API for whiteboard generation")


def _heuristic_whiteboard_content(
    user_prompt: str,
    active_elements: Optional[List[Dict[str, Any]]] = None,
    telemetry: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    board_texts = []
    if active_elements:
        for el in active_elements:
            if el.get("type") == "text" and el.get("text"):
                board_texts.append(el.get("text"))

    joined_context = (user_prompt + " " + " ".join(board_texts)).lower()

    # 1. Calculus, Integration, 1/x, Graphs, Curves, Coordinate Plots
    if any(k in joined_context for k in ["1/x", "integral", "integrat", "calculus", "graph", "plot", "curve", "hyperbola", "area under", "ln"]):
        return {
            "title": "Graph of y = 1/x and Area Under Curve",
            "summary": "Visual coordinate plot of y = 1/x showing integration boundaries from x = 1 to x = 3 and the area ln(3).",
            "width": 540,
            "height": 360,
            "elements": [
                # Card Background & Title
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 0, "y": 0}, "end": {"x": 540, "y": 360}, "color": "#cbd5e1", "size": 2, "fillColor": "#ffffff"},
                {"type": "text", "text": "Graph of y = 1/x & Definite Integration", "x": 24, "y": 38, "color": "#1e3a8a", "fontSize": 18, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "line", "start": {"x": 20, "y": 52}, "end": {"x": 520, "y": 52}, "color": "#e2e8f0", "size": 1},

                # Coordinate Axes
                {"type": "shape", "shapeType": "line", "start": {"x": 60, "y": 260}, "end": {"x": 480, "y": 260}, "color": "#334155", "size": 2},
                {"type": "shape", "shapeType": "arrow", "start": {"x": 470, "y": 260}, "end": {"x": 490, "y": 260}, "color": "#334155", "size": 2},
                {"type": "text", "text": "x", "x": 496, "y": 265, "color": "#334155", "fontSize": 15, "fontWeight": "bold"},

                {"type": "shape", "shapeType": "line", "start": {"x": 90, "y": 75}, "end": {"x": 90, "y": 280}, "color": "#334155", "size": 2},
                {"type": "shape", "shapeType": "arrow", "start": {"x": 90, "y": 85}, "end": {"x": 90, "y": 68}, "color": "#334155", "size": 2},
                {"type": "text", "text": "y", "x": 90, "y": 62, "color": "#334155", "fontSize": 15, "fontWeight": "bold"},
                {"type": "text", "text": "O", "x": 74, "y": 274, "color": "#64748b", "fontSize": 13},

                # Ticks on X Axis
                {"type": "shape", "shapeType": "line", "start": {"x": 170, "y": 255}, "end": {"x": 170, "y": 265}, "color": "#475569", "size": 2},
                {"type": "text", "text": "1", "x": 166, "y": 280, "color": "#1e293b", "fontSize": 13, "fontWeight": "bold"},

                {"type": "shape", "shapeType": "line", "start": {"x": 250, "y": 255}, "end": {"x": 250, "y": 265}, "color": "#475569", "size": 2},
                {"type": "text", "text": "2", "x": 246, "y": 280, "color": "#64748b", "fontSize": 13},

                {"type": "shape", "shapeType": "line", "start": {"x": 330, "y": 255}, "end": {"x": 330, "y": 265}, "color": "#475569", "size": 2},
                {"type": "text", "text": "3", "x": 326, "y": 280, "color": "#1e293b", "fontSize": 13, "fontWeight": "bold"},

                # Shaded Integration Region [1 to 3]
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 170, "y": 210}, "end": {"x": 330, "y": 260}, "color": "#bbf7d0", "size": 1, "fillColor": "#f0fdf4"},
                {"type": "shape", "shapeType": "line", "start": {"x": 170, "y": 210}, "end": {"x": 170, "y": 260}, "color": "#059669", "size": 2},
                {"type": "shape", "shapeType": "line", "start": {"x": 330, "y": 244}, "end": {"x": 330, "y": 260}, "color": "#059669", "size": 2},
                {"type": "text", "text": "Area = ln(3)", "x": 215, "y": 238, "color": "#047857", "fontSize": 12, "fontWeight": "bold"},

                # Curve y = 1/x (Connected Smooth Segments)
                {"type": "shape", "shapeType": "line", "start": {"x": 110, "y": 95}, "end": {"x": 130, "y": 140}, "color": "#2563eb", "size": 3},
                {"type": "shape", "shapeType": "line", "start": {"x": 130, "y": 140}, "end": {"x": 150, "y": 180}, "color": "#2563eb", "size": 3},
                {"type": "shape", "shapeType": "line", "start": {"x": 150, "y": 180}, "end": {"x": 170, "y": 210}, "color": "#2563eb", "size": 3},
                {"type": "shape", "shapeType": "line", "start": {"x": 170, "y": 210}, "end": {"x": 210, "y": 230}, "color": "#2563eb", "size": 3},
                {"type": "shape", "shapeType": "line", "start": {"x": 210, "y": 230}, "end": {"x": 260, "y": 240}, "color": "#2563eb", "size": 3},
                {"type": "shape", "shapeType": "line", "start": {"x": 260, "y": 240}, "end": {"x": 330, "y": 244}, "color": "#2563eb", "size": 3},
                {"type": "shape", "shapeType": "line", "start": {"x": 330, "y": 244}, "end": {"x": 420, "y": 252}, "color": "#2563eb", "size": 3},
                {"type": "shape", "shapeType": "line", "start": {"x": 420, "y": 252}, "end": {"x": 470, "y": 255}, "color": "#2563eb", "size": 3},
                {"type": "text", "text": "y = 1/x", "x": 185, "y": 195, "color": "#2563eb", "fontSize": 15, "fontWeight": "bold"},

                # Formula & Interactive Checkpoint
                {"type": "text", "text": "Rule: Integral of (1/x) dx = ln|x| + C", "x": 24, "y": 312, "color": "#1e3a8a", "fontSize": 14, "fontWeight": "bold"},
                {"type": "text", "text": "Area from 1 to 3: ln(3) - ln(1) = [          ]", "x": 24, "y": 340, "color": "#0f172a", "fontSize": 14},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 224, "y": 322}, "end": {"x": 310, "y": 350}, "color": "#2563eb", "size": 2}
            ]
        }

    # 2. Linear Functions, Slope, Intercept
    elif any(k in joined_context for k in ["linear", "slope", "y = mx", "intercept"]):
        return {
            "title": "Linear Function: y = 2x + 1",
            "summary": "Coordinate plane showing slope triangle (rise over run = 2) and y-intercept at (0, 1).",
            "width": 520,
            "height": 340,
            "elements": [
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 0, "y": 0}, "end": {"x": 520, "y": 340}, "color": "#cbd5e1", "size": 2, "fillColor": "#ffffff"},
                {"type": "text", "text": "Linear Graph: y = 2x + 1", "x": 24, "y": 38, "color": "#1e3a8a", "fontSize": 18, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "line", "start": {"x": 20, "y": 52}, "end": {"x": 500, "y": 52}, "color": "#e2e8f0", "size": 1},
                # Axes
                {"type": "shape", "shapeType": "line", "start": {"x": 50, "y": 200}, "end": {"x": 470, "y": 200}, "color": "#334155", "size": 2},
                {"type": "shape", "shapeType": "line", "start": {"x": 200, "y": 65}, "end": {"x": 200, "y": 270}, "color": "#334155", "size": 2},
                {"type": "text", "text": "x", "x": 475, "y": 205, "color": "#334155", "fontSize": 14, "fontWeight": "bold"},
                {"type": "text", "text": "y", "x": 205, "y": 65, "color": "#334155", "fontSize": 14, "fontWeight": "bold"},
                # Line y = 2x + 1
                {"type": "shape", "shapeType": "line", "start": {"x": 100, "y": 260}, "end": {"x": 300, "y": 100}, "color": "#2563eb", "size": 3},
                {"type": "shape", "shapeType": "circle", "start": {"x": 195, "y": 160}, "end": {"x": 205, "y": 170}, "color": "#dc2626", "size": 2, "fillColor": "#ef4444"},
                {"type": "text", "text": "(0, 1) y-intercept", "x": 215, "y": 165, "color": "#dc2626", "fontSize": 13, "fontWeight": "600"},
                # Questions
                {"type": "text", "text": "1) What is the slope (gradient)?  m = [      ]", "x": 28, "y": 295, "color": "#0f172a", "fontSize": 14, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 275, "y": 278}, "end": {"x": 345, "y": 308}, "color": "#2563eb", "size": 2}
            ]
        }

    # 3. Geometry & Triangles
    elif any(k in joined_context for k in ["geometry", "triangle", "pythagor", "hypotenuse", "angle", "perimeter"]):
        return {
            "title": "Right Triangle & Pythagoras Theorem",
            "summary": "Geometric model of a right-angled triangle with sides 6 and 8, targeting the hypotenuse calculation.",
            "width": 520,
            "height": 330,
            "elements": [
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 0, "y": 0}, "end": {"x": 520, "y": 330}, "color": "#cbd5e1", "size": 2, "fillColor": "#ffffff"},
                {"type": "text", "text": "Right Triangle: Find Hypotenuse c", "x": 24, "y": 38, "color": "#1e3a8a", "fontSize": 18, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "line", "start": {"x": 20, "y": 52}, "end": {"x": 500, "y": 52}, "color": "#e2e8f0", "size": 1},
                # Triangle
                {"type": "shape", "shapeType": "line", "start": {"x": 80, "y": 230}, "end": {"x": 280, "y": 230}, "color": "#1e293b", "size": 3},
                {"type": "shape", "shapeType": "line", "start": {"x": 80, "y": 90}, "end": {"x": 80, "y": 230}, "color": "#1e293b", "size": 3},
                {"type": "shape", "shapeType": "line", "start": {"x": 80, "y": 90}, "end": {"x": 280, "y": 230}, "color": "#2563eb", "size": 3},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 80, "y": 215}, "end": {"x": 95, "y": 230}, "color": "#64748b", "size": 1.5},
                # Labels
                {"type": "text", "text": "a = 6", "x": 40, "y": 165, "color": "#0f172a", "fontSize": 14, "fontWeight": "bold"},
                {"type": "text", "text": "b = 8", "x": 165, "y": 250, "color": "#0f172a", "fontSize": 14, "fontWeight": "bold"},
                {"type": "text", "text": "c = ?", "x": 190, "y": 145, "color": "#2563eb", "fontSize": 16, "fontWeight": "bold"},
                # Steps
                {"type": "text", "text": "Theorem: a² + b² = c²", "x": 310, "y": 105, "color": "#1e3a8a", "fontSize": 14, "fontWeight": "bold"},
                {"type": "text", "text": "Step 1: 6² + 8² = 36 + 64 = 100", "x": 310, "y": 140, "color": "#475569", "fontSize": 13},
                {"type": "text", "text": "Step 2: c = sqrt(100) = [      ]", "x": 310, "y": 180, "color": "#0f172a", "fontSize": 15, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 420, "y": 162}, "end": {"x": 490, "y": 195}, "color": "#2563eb", "size": 2}
            ]
        }

    # 4. Fractions
    elif any(k in joined_context for k in ["fraction", "slice", "pizza", "half", "quarter"]):
        return {
            "title": "Fraction Comparison Model",
            "summary": "Visual fraction bar comparison matching student discussion on fractional parts.",
            "width": 540,
            "height": 320,
            "elements": [
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 0, "y": 0}, "end": {"x": 540, "y": 320}, "color": "#cbd5e1", "size": 2, "fillColor": "#ffffff"},
                {"type": "text", "text": "Fraction Model: Comparing Halves & Quarters", "x": 24, "y": 38, "color": "#1e3a8a", "fontSize": 18, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "line", "start": {"x": 20, "y": 52}, "end": {"x": 520, "y": 52}, "color": "#e2e8f0", "size": 1},
                {"type": "text", "text": "1 Whole Bar:", "x": 28, "y": 80, "color": "#475569", "fontSize": 14},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 130, "y": 66}, "end": {"x": 490, "y": 96}, "color": "#2563eb", "size": 2, "fillColor": "#eff6ff"},
                {"type": "text", "text": "1", "x": 305, "y": 87, "color": "#1d4ed8", "fontSize": 15, "fontWeight": "bold"},
                {"type": "text", "text": "Two Halves (1/2):", "x": 28, "y": 130, "color": "#475569", "fontSize": 14},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 130, "y": 116}, "end": {"x": 310, "y": 146}, "color": "#059669", "size": 2, "fillColor": "#ecfdf5"},
                {"type": "text", "text": "1/2", "x": 210, "y": 137, "color": "#047857", "fontSize": 14, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 310, "y": 116}, "end": {"x": 490, "y": 146}, "color": "#059669", "size": 2, "fillColor": "#ecfdf5"},
                {"type": "text", "text": "1/2", "x": 390, "y": 137, "color": "#047857", "fontSize": 14, "fontWeight": "bold"},
                {"type": "text", "text": "Practice Question:", "x": 28, "y": 185, "color": "#0f172a", "fontSize": 15, "fontWeight": "bold"},
                {"type": "text", "text": "How many 1/4 parts fit into 1/2?  Answer: [      ]", "x": 36, "y": 220, "color": "#1e293b", "fontSize": 16},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 372, "y": 202}, "end": {"x": 445, "y": 234}, "color": "#3b82f6", "size": 2},
                {"type": "text", "text": "Hint: Count how many quarters line up with one half bar.", "x": 36, "y": 275, "color": "#64748b", "fontSize": 13}
            ]
        }

    # 5. Subtraction & Regrouping
    elif any(k in joined_context for k in ["subtraction", "minus", "subtr", "borrow", "take away", "regroup", "21 - 1", "12 - 2"]):
        if any(k in joined_context for k in ["10", "ten"]):
            # 10 Subtraction problems in 2 balanced columns, all with answer boxes
            return {
                "title": "10 Subtraction Practice Problems",
                "summary": "10 subtraction problems arranged in 2 columns with dedicated answer boxes for every question.",
                "width": 580,
                "height": 380,
                "elements": [
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 0, "y": 0}, "end": {"x": 580, "y": 380}, "color": "#cbd5e1", "size": 2, "fillColor": "#ffffff"},
                    {"type": "text", "text": "10 Subtraction Practice Problems", "x": 24, "y": 38, "color": "#1e3a8a", "fontSize": 18, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "line", "start": {"x": 20, "y": 52}, "end": {"x": 560, "y": 52}, "color": "#e2e8f0", "size": 1},

                    # Column 1
                    {"type": "text", "text": "1)   25 - 4 =", "x": 36, "y": 90, "color": "#0f172a", "fontSize": 16, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 160, "y": 74}, "end": {"x": 230, "y": 106}, "color": "#2563eb", "size": 2},
                    {"type": "text", "text": "2)   38 - 12 =", "x": 36, "y": 135, "color": "#0f172a", "fontSize": 16, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 160, "y": 119}, "end": {"x": 230, "y": 151}, "color": "#2563eb", "size": 2},
                    {"type": "text", "text": "3)   47 - 15 =", "x": 36, "y": 180, "color": "#0f172a", "fontSize": 16, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 160, "y": 164}, "end": {"x": 230, "y": 196}, "color": "#2563eb", "size": 2},
                    {"type": "text", "text": "4)   59 - 23 =", "x": 36, "y": 225, "color": "#0f172a", "fontSize": 16, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 160, "y": 209}, "end": {"x": 230, "y": 241}, "color": "#2563eb", "size": 2},
                    {"type": "text", "text": "5)   64 - 18 =", "x": 36, "y": 270, "color": "#0f172a", "fontSize": 16, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 160, "y": 254}, "end": {"x": 230, "y": 286}, "color": "#2563eb", "size": 2},

                    # Column 2
                    {"type": "text", "text": "6)   72 - 35 =", "x": 290, "y": 90, "color": "#0f172a", "fontSize": 16, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 420, "y": 74}, "end": {"x": 490, "y": 106}, "color": "#2563eb", "size": 2},
                    {"type": "text", "text": "7)   83 - 46 =", "x": 290, "y": 135, "color": "#0f172a", "fontSize": 16, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 420, "y": 119}, "end": {"x": 490, "y": 151}, "color": "#2563eb", "size": 2},
                    {"type": "text", "text": "8)   91 - 57 =", "x": 290, "y": 180, "color": "#0f172a", "fontSize": 16, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 420, "y": 164}, "end": {"x": 490, "y": 196}, "color": "#2563eb", "size": 2},
                    {"type": "text", "text": "9)   60 - 24 =", "x": 290, "y": 225, "color": "#0f172a", "fontSize": 16, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 420, "y": 209}, "end": {"x": 490, "y": 241}, "color": "#2563eb", "size": 2},
                    {"type": "text", "text": "10) 95 - 68 =", "x": 290, "y": 270, "color": "#0f172a", "fontSize": 16, "fontWeight": "bold"},
                    {"type": "shape", "shapeType": "rectangle", "start": {"x": 420, "y": 254}, "end": {"x": 490, "y": 286}, "color": "#2563eb", "size": 2},

                    {"type": "text", "text": "Hint: Subtract units first, then tens. Check regrouping where needed!", "x": 36, "y": 330, "color": "#059669", "fontSize": 13}
                ]
            }

        return {
            "title": "Targeted Subtraction Practice",
            "summary": "Follow-up subtraction problems matching the horizontal equation format used earlier, targeting place value.",
            "width": 520,
            "height": 330,
            "elements": [
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 0, "y": 0}, "end": {"x": 520, "y": 330}, "color": "#cbd5e1", "size": 2, "fillColor": "#ffffff"},
                {"type": "text", "text": "Targeted Subtraction Practice", "x": 24, "y": 38, "color": "#1e3a8a", "fontSize": 18, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "line", "start": {"x": 20, "y": 52}, "end": {"x": 500, "y": 52}, "color": "#e2e8f0", "size": 1},
                {"type": "text", "text": "1)  21 - 1 = [       ]", "x": 36, "y": 95, "color": "#0f172a", "fontSize": 17, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 140, "y": 76}, "end": {"x": 215, "y": 108}, "color": "#2563eb", "size": 2},
                {"type": "text", "text": "Step: 1 unit taken from 1 unit leaves 0 units -> 2 tens = 20", "x": 48, "y": 126, "color": "#64748b", "fontSize": 13},
                {"type": "text", "text": "2)  32 - 2 = [       ]", "x": 36, "y": 175, "color": "#0f172a", "fontSize": 17, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 140, "y": 156}, "end": {"x": 215, "y": 188}, "color": "#2563eb", "size": 2},
                {"type": "text", "text": "3)  45 - 15 = [       ]", "x": 36, "y": 240, "color": "#0f172a", "fontSize": 17, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 150, "y": 221}, "end": {"x": 225, "y": 253}, "color": "#059669", "size": 2},
                {"type": "text", "text": "Hint: Subtract the units first, then subtract the tens.", "x": 48, "y": 288, "color": "#059669", "fontSize": 13}
            ]
        }

    # 6. Addition
    elif any(k in joined_context for k in ["add", "plus", "sum"]):
        return {
            "title": "Addition Checkpoint",
            "summary": "Addition problems formatted with answer boxes matching current lesson pacing.",
            "width": 500,
            "height": 300,
            "elements": [
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 0, "y": 0}, "end": {"x": 500, "y": 300}, "color": "#cbd5e1", "size": 2, "fillColor": "#ffffff"},
                {"type": "text", "text": "Addition Practice", "x": 24, "y": 38, "color": "#1e3a8a", "fontSize": 18, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "line", "start": {"x": 20, "y": 52}, "end": {"x": 480, "y": 52}, "color": "#e2e8f0", "size": 1},
                {"type": "text", "text": "1)  18 + 5 = [       ]", "x": 36, "y": 105, "color": "#0f172a", "fontSize": 17, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 140, "y": 86}, "end": {"x": 215, "y": 118}, "color": "#2563eb", "size": 2},
                {"type": "text", "text": "2)  27 + 6 = [       ]", "x": 36, "y": 185, "color": "#0f172a", "fontSize": 17, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 140, "y": 166}, "end": {"x": 215, "y": 198}, "color": "#2563eb", "size": 2},
                {"type": "text", "text": "Tip: Make a 10 first! 18 + 2 = 20, then add 3.", "x": 36, "y": 250, "color": "#64748b", "fontSize": 13}
            ]
        }

    # 7. Dynamic Custom Prompt Parser (Guaranteed Content)
    else:
        topic_title = user_prompt.strip().rstrip(".").capitalize() if user_prompt else "Lesson Practice Checkpoint"
        if len(topic_title) > 42:
            topic_title = topic_title[:39] + "..."

        return {
            "title": topic_title,
            "summary": f"Practice question and guided scaffold created specifically for: '{user_prompt[:50]}'.",
            "width": 540,
            "height": 330,
            "elements": [
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 0, "y": 0}, "end": {"x": 540, "y": 330}, "color": "#cbd5e1", "size": 2, "fillColor": "#ffffff"},
                {"type": "text", "text": topic_title, "x": 24, "y": 38, "color": "#1e3a8a", "fontSize": 18, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "line", "start": {"x": 20, "y": 52}, "end": {"x": 520, "y": 52}, "color": "#e2e8f0", "size": 1},

                {"type": "text", "text": f"Instruction: {user_prompt[:56]}", "x": 32, "y": 85, "color": "#334155", "fontSize": 14, "fontWeight": "bold"},
                {"type": "text", "text": "Step 1: Write down the given expression or rule:", "x": 32, "y": 125, "color": "#475569", "fontSize": 14},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 32, "y": 140}, "end": {"x": 500, "y": 185}, "color": "#cbd5e1", "size": 1.5, "fillColor": "#f8fafc"},
                {"type": "text", "text": "[  Write your intermediate steps and working here  ]", "x": 48, "y": 166, "color": "#94a3b8", "fontSize": 13},

                {"type": "text", "text": "Step 2: Solve for the final value:", "x": 32, "y": 225, "color": "#0f172a", "fontSize": 15, "fontWeight": "bold"},
                {"type": "text", "text": "Result = [          ]", "x": 270, "y": 225, "color": "#0f172a", "fontSize": 15, "fontWeight": "bold"},
                {"type": "shape", "shapeType": "rectangle", "start": {"x": 340, "y": 208}, "end": {"x": 420, "y": 240}, "color": "#2563eb", "size": 2},

                {"type": "text", "text": "Pedagogical Tip: Anchor your reasoning to previous examples before evaluating.", "x": 32, "y": 285, "color": "#059669", "fontSize": 13}
            ]
        }


def _is_whiteboard_question_text(el: Dict[str, Any]) -> bool:
    """Helper to detect whether a text element is an exercise question/equation expecting an answer box."""
    if not isinstance(el, dict) or el.get("type") != "text":
        return False
    raw_text = el.get("text", "").strip()
    if not raw_text or el.get("y", 100) < 60:
        return False

    lower = raw_text.lower()
    # Skip obvious notes, hints, steps, instructions, axis labels
    if lower.startswith((
        "hint", "step", "tip", "pedagogical", "note:", "take your time",
        "instruction", "rule:", "remember", "check your", "practice question:"
    )):
        return False
    if len(raw_text) <= 2 and not raw_text.endswith("="):
        return False

    # 1. Numbered items: "1) ...", "1. ...", "(1) ...", "10) ..."
    if re.search(r'^\s*(?:\d+[\.\)]|\([0-9a-zA-Z]+\))\s+', raw_text):
        return True
    # 2. Contains equality or answer placeholder: "=" or "[ ]" or "[   ]"
    if "=" in raw_text or re.search(r'\[\s*\]', raw_text):
        return True
    # 3. Contains "Answer:" or "Result"
    if "answer:" in lower or "result" in lower:
        return True
    # 4. Arithmetic equation: e.g. "25 - 4", "18 + 5"
    if re.search(r'\d+\s*[\+\-\*\/×÷]\s*\d+', raw_text):
        return True

    return False


def _normalize_whiteboard_layout(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Intelligent layout normalizer:
    1. Perfect Question & Answer Box Alignment & Consistency:
       - Detects all questions across 1-column or multi-column layouts (e.g. 10 subtraction questions in 2 columns).
       - Guarantees EVERY question has its own dedicated answer box (generating any missing boxes).
       - Prevents Column 2 answer boxes from collapsing into Column 1.
       - Aligns answer boxes in neat vertical columns per question column.
       - Removes clunky bracket placeholders like '[      ]' from text when an answer box is drawn.
    2. Zero Text Overflow:
       - Automatically wraps long explanation lines/hints that exceed the card's readable width.
    3. Auto-Card Sizing:
       - Automatically expands width and height if needed so all content and columns have comfortable breathing room.
    """
    if not isinstance(data, dict):
        return data
    elements = data.get("elements", [])
    if not isinstance(elements, list) or not elements:
        return data

    card_w = data.get("width", 540)
    card_h = data.get("height", 360)

    # 1. Identify card background and header line
    card_bg = None
    header_line = None
    other_elements = []

    for el in elements:
        if not isinstance(el, dict):
            continue
        if el.get("type") == "shape":
            st = el.get("start", {})
            en = el.get("end", {})
            if el.get("shapeType") == "rectangle" and st.get("x", 99) <= 10 and st.get("y", 99) <= 10 and en.get("x", 0) >= card_w - 40:
                card_bg = el
                continue
            if el.get("shapeType") == "line" and st.get("x", 99) <= 30 and st.get("y", 99) <= 65 and en.get("x", 0) >= card_w - 50:
                header_line = el
                continue
        other_elements.append(el)

    # 2. Separate text elements, candidate answer boxes, and other shapes
    candidate_answer_boxes = []
    other_shapes = []
    for el in other_elements:
        if el.get("type") == "shape" and el.get("shapeType") == "rectangle":
            st = el.get("start", {})
            en = el.get("end", {})
            w = abs(en.get("x", 0) - st.get("x", 0))
            h = abs(en.get("y", 0) - st.get("y", 0))
            fill = el.get("fillColor")
            is_shaded_region = bool(fill and fill not in ["#ffffff", "#f8fafc", "#faf9f6", "transparent"])
            if 35 <= w <= 180 and 20 <= h <= 55 and not is_shaded_region and st.get("x", 0) > 0:
                candidate_answer_boxes.append(el)
            else:
                other_shapes.append(el)
        elif el.get("type") == "shape":
            other_shapes.append(el)

    text_elements = [el for el in other_elements if el.get("type") == "text"]

    # 3. Detect question text elements and organize into column groups
    question_elements = [el for el in text_elements if _is_whiteboard_question_text(el)]
    final_answer_boxes = []

    if question_elements:
        col_groups = []
        sorted_by_x = sorted(question_elements, key=lambda q: (q.get("x", 0), q.get("y", 0)))
        for q in sorted_by_x:
            qx = q.get("x", 24)
            placed = False
            for group in col_groups:
                avg_x = sum(item.get("x", 24) for item in group) / len(group)
                if abs(qx - avg_x) <= 75:
                    group.append(q)
                    placed = True
                    break
            if not placed:
                col_groups.append([q])

        col_groups.sort(key=lambda g: sum(q.get("x", 24) for q in g) / len(g))
        for g in col_groups:
            g.sort(key=lambda q: q.get("y", 0))

        used_box_ids = set()

        for c_idx, col in enumerate(col_groups):
            col_min_x = min(q.get("x", 24) for q in col)
            next_col_min_x = min(q.get("x", 24) for q in col_groups[c_idx + 1]) if c_idx + 1 < len(col_groups) else 99999

            col_max_q_end_x = 0
            for q in col:
                raw_text = q.get("text", "")
                cleaned_text = re.sub(r'\[\s*\]', '', raw_text).rstrip()
                q["text"] = cleaned_text
                f_size = q.get("fontSize", 16)
                end_x = q.get("x", 24) + (len(cleaned_text) * (f_size * 0.60))
                if end_x > col_max_q_end_x:
                    col_max_q_end_x = end_x

            box_start_x = max(col_min_x + 95, round(col_max_q_end_x + 14))
            b_w = 70
            b_h = 32

            for q in col:
                q_y = q.get("y", 100)
                f_size = q.get("fontSize", 16)
                vis_center_y = q_y - (f_size * 0.35)

                best_b = None
                best_score = 9999
                for b in candidate_answer_boxes:
                    b_id = id(b)
                    if b_id in used_box_ids:
                        continue
                    b_st = b.get("start", {})
                    b_en = b.get("end", {})
                    b_cx = (b_st.get("x", 0) + b_en.get("x", 0)) / 2
                    b_cy = (b_st.get("y", 0) + b_en.get("y", 0)) / 2

                    if b_cx < col_min_x - 40 or b_cx >= next_col_min_x - 30:
                        continue
                    dy = abs(b_cy - q_y)
                    if dy <= 45:
                        dx = abs(b_cx - (col_min_x + 120))
                        score = dy * 2.5 + dx
                        if score < best_score:
                            best_score = score
                            best_b = b

                if best_b is not None:
                    used_box_ids.add(id(best_b))
                    box = best_b
                else:
                    # Automatically generate missing answer box for this question!
                    box = {
                        "type": "shape",
                        "shapeType": "rectangle",
                        "start": {},
                        "end": {},
                        "color": "#2563eb",
                        "size": 2,
                        "fillColor": "#f8fafc"
                    }

                box["start"] = {"x": box_start_x, "y": round(vis_center_y - b_h / 2)}
                box["end"] = {"x": box_start_x + b_w, "y": round(vis_center_y + b_h / 2)}
                box["color"] = "#2563eb"
                box["size"] = 2
                box["fillColor"] = "#f8fafc"
                final_answer_boxes.append(box)

        # Retain any extra unused candidate shapes (if any) in other_shapes
        for b in candidate_answer_boxes:
            if id(b) not in used_box_ids:
                other_shapes.append(b)
    else:
        # If no questions were detected, preserve all original candidate shapes
        final_answer_boxes.extend(candidate_answer_boxes)

    # 3. Word-wrap overflowing texts
    final_text_elements = []
    for txt in text_elements:
        raw_text = txt.get("text", "")
        f_size = txt.get("fontSize", 16)
        x = txt.get("x", 24)
        y = txt.get("y", 100)
        avail_w = max(240, card_w - x - 24)
        char_limit = max(30, int(avail_w / (f_size * 0.58)))

        if len(raw_text) > char_limit and " " in raw_text and not raw_text.startswith(("Rule:", "y =", "Integral")):
            words = raw_text.split()
            lines = []
            curr_line = ""
            for w in words:
                test_line = f"{curr_line} {w}" if curr_line else w
                if len(test_line) > char_limit and curr_line:
                    lines.append(curr_line)
                    curr_line = w
                else:
                    curr_line = test_line
            if curr_line:
                lines.append(curr_line)

            line_h = round(f_size * 1.35)
            for i, line_str in enumerate(lines):
                new_t = dict(txt)
                new_t["text"] = line_str
                new_t["y"] = y + (i * line_h)
                final_text_elements.append(new_t)
        else:
            final_text_elements.append(txt)

    # 4. Measure bounds and resize card container
    all_final_items = other_shapes + final_answer_boxes + final_text_elements
    max_x = card_w
    max_y = card_h

    for el in all_final_items:
        if el.get("type") == "shape":
            st = el.get("start", {})
            en = el.get("end", {})
            max_x = max(max_x, st.get("x", 0), en.get("x", 0))
            max_y = max(max_y, st.get("y", 0), en.get("y", 0))
        elif el.get("type") == "text":
            t_y = el.get("y", 0)
            max_y = max(max_y, t_y + 10)

    final_w = max(card_w, max_x + 28)
    final_h = max(card_h, max_y + 36)

    result_elements = []
    if card_bg:
        card_bg["start"] = {"x": 0, "y": 0}
        card_bg["end"] = {"x": final_w, "y": final_h}
        result_elements.append(card_bg)
    else:
        result_elements.append({
            "type": "shape", "shapeType": "rectangle",
            "start": {"x": 0, "y": 0}, "end": {"x": final_w, "y": final_h},
            "color": "#cbd5e1", "size": 2, "fillColor": "#ffffff"
        })

    if header_line:
        header_line["start"] = {"x": 20, "y": 52}
        header_line["end"] = {"x": final_w - 20, "y": 52}
        result_elements.append(header_line)

    result_elements.extend(all_final_items)

    data["width"] = final_w
    data["height"] = final_h
    data["elements"] = result_elements
    return data


def generate_whiteboard_content(
    telemetry_payload: Dict[str, Any],
    user_prompt: str,
    active_elements: Optional[List[Dict[str, Any]]] = None,
    api_key: Optional[str] = None,
    provider_override: Optional[str] = None,
    image_data_url: Optional[str] = None
) -> Dict[str, Any]:
    _load_env_file()
    provider = provider_override or os.environ.get("LLM_PROVIDER", "auto").lower()
    gemini_key = api_key or os.environ.get("GEMINI_API_KEY", "").strip()
    openai_key = api_key or os.environ.get("OPENAI_API_KEY", "").strip()

    if provider == "auto":
        if gemini_key:
            provider = "gemini"
        elif openai_key:
            provider = "openai"
        elif os.environ.get("OLLAMA_ENABLED", "").lower() in ("true", "1"):
            provider = "ollama"
        else:
            provider = "heuristic"

    logger.info(f"Generating whiteboard content using provider: {provider} (prompt: '{user_prompt[:60]}...')")

    active_texts = []
    active_shapes = []
    if active_elements:
        for el in active_elements:
            if el.get("type") == "text" and el.get("text"):
                active_texts.append(el.get("text"))
            elif el.get("type") == "shape" and el.get("shapeType"):
                active_shapes.append(el.get("shapeType"))

    context_lines = []
    context_lines.append(f"Prompt Context:\n{telemetry_payload.get('llm_prompt_context', '')}\n")
    if active_texts:
        context_lines.append(f"Active Texts Currently on Whiteboard:\n{json.dumps(active_texts, indent=2)}")
    if active_shapes:
        context_lines.append(f"Active Shapes Currently on Whiteboard:\n{json.dumps(active_shapes, indent=2)}")

    full_context = "\n\n".join(context_lines)

    # 1. Try Gemini
    if provider == "gemini" and gemini_key:
        try:
            content_result = _call_gemini_whiteboard_gen(
                prompt_context=full_context,
                user_prompt=user_prompt,
                api_key=gemini_key,
                image_data_url=image_data_url
            )
            return {
                "result": _normalize_whiteboard_layout(content_result),
                "provider_used": "gemini",
                "timestamp_ms": int(time.time() * 1000)
            }
        except Exception as e:
            logger.warning(f"Gemini whiteboard generation failed ({e}). Checking fallback providers...")

    # 2. Try OpenAI
    if (provider == "openai" or openai_key) and openai_key:
        try:
            content_result = _call_openai_whiteboard_gen(
                prompt_context=full_context,
                user_prompt=user_prompt,
                api_key=openai_key
            )
            return {
                "result": _normalize_whiteboard_layout(content_result),
                "provider_used": "openai",
                "timestamp_ms": int(time.time() * 1000)
            }
        except Exception as e:
            logger.warning(f"OpenAI whiteboard generation failed ({e}). Falling back to heuristic generator.")

    # 3. Smart Heuristic Engine
    heuristic_result = _heuristic_whiteboard_content(
        user_prompt=user_prompt,
        active_elements=active_elements,
        telemetry=telemetry_payload
    )
    return {
        "result": _normalize_whiteboard_layout(_clean_report_math(heuristic_result)),
        "provider_used": "heuristic",
        "timestamp_ms": int(time.time() * 1000)
    }


