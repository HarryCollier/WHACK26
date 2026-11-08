"""
Whiteboard Math Error Checker
=============================
Dedicated, self-contained pipeline that detects mathematical errors in HANDWRITTEN
equations anywhere on the whiteboard (e.g. tutor writes "12 - 4 =", pupil writes "81").

Pipeline:
  1. Vision transcription (Gemini / OpenAI): the model ONLY reads the board and returns every
     equation as {"lhs": ..., "rhs": ...}. It is not asked to judge correctness.
  2. Deterministic verification (Python AST): the LHS is evaluated safely and compared
     to the pupil's RHS. No LLM guesswork decides right vs wrong.
  3. LLM explanation (Gemini / OpenAI + heuristic fallback): for each wrong answer, a short
     description of the likely misconception and the next steps for the tutor.
  4. Returns ready-to-broadcast `live_coach_toast` payloads. Each wrong equation on the board
     is flagged immediately on the 1st wrong attempt (and only once while it remains on board).
"""

import ast
import base64
import hashlib
import io
import json
import logging
import operator
import os
import re
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 1. Deterministic arithmetic evaluation
# ---------------------------------------------------------------------------

_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
}
_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}


def _safe_eval(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
        left, right = _safe_eval(node.left), _safe_eval(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > 12:
            raise ValueError("exponent too large")
        return _BIN_OPS[type(node.op)](left, right)
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _UNARY_OPS[type(node.op)](_safe_eval(node.operand))
    raise ValueError(f"unsupported expression node: {type(node).__name__}")


def normalize_expression(expr: str) -> str:
    """Converts handwritten / human math notation into a Python arithmetic expression."""
    s = (expr or "").strip()
    # Strip surrounding brackets/boxes if a student wrote inside [ ... ]
    s = re.sub(r"^[\[\{\(\s]+|[\]\}\)\s\?]+$", "", s) if re.fullmatch(r"[\[\{\s]*-?\d+(?:\.\d+)?[\]\}\s\?]*", s) else s
    s = s.replace("×", "*").replace("·", "*").replace("∙", "*")
    s = s.replace("÷", "/").replace(":", "/")
    s = s.replace("−", "-").replace("–", "-").replace("—", "-")
    s = s.replace("^", "**").replace("²", "**2").replace("³", "**3")
    # 'x' / 'X' between numbers (or brackets) is multiplication in handwritten arithmetic
    s = re.sub(r"(?<=[\d\)])\s*[xX]\s*(?=[\d\(])", "*", s)
    # Implicit multiplication: 2(3+4) or (1+2)(3+4)
    s = re.sub(r"(?<=\d)\s*\(", "*(", s)
    s = re.sub(r"\)\s*(?=[\d\(])", ")*", s)
    s = s.replace(",", "")  # thousands separators
    return s.strip()


def evaluate_expression(expr: str) -> Optional[float]:
    """Safely evaluates a pure arithmetic expression. Returns None if not evaluable."""
    norm = normalize_expression(expr)
    if not norm or not re.fullmatch(r"[\d\s\.\+\-\*/\(\)]+", norm):
        return None
    try:
        return _safe_eval(ast.parse(norm, mode="eval"))
    except Exception:
        return None


def parse_answer(ans: str) -> Optional[float]:
    """Parses the pupil's answer (integer, decimal, fraction, or simple expression)."""
    s = (ans or "").strip().rstrip(".?")
    s = re.sub(r"^[\[\{\s]+|[\]\}\s]+$", "", s)
    if not s:
        return None
    frac = re.fullmatch(r"(-?\d+)\s*/\s*(\d+)", s)
    if frac and int(frac.group(2)) != 0:
        return int(frac.group(1)) / int(frac.group(2))
    return evaluate_expression(s)


def _format_number(v: float) -> str:
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return f"{v:.4f}".rstrip("0").rstrip(".")


def verify_equation(lhs: str, rhs: str) -> Dict[str, Any]:
    """
    Deterministically verifies `lhs = rhs`.
    Returns {"status": "correct" | "incorrect" | "unverifiable", "expected": str|None}
    """
    expected = evaluate_expression(lhs)
    given = parse_answer(rhs)
    if expected is None or given is None:
        return {"status": "unverifiable", "expected": None}
    ok = abs(expected - given) <= 1e-6 * max(1.0, abs(expected))
    return {"status": "correct" if ok else "incorrect", "expected": _format_number(expected)}


# ---------------------------------------------------------------------------
# 2. Server-side Pillow fallback renderer (when vector elements exist without snapshot)
# ---------------------------------------------------------------------------

def render_elements_to_data_url(elements: List[Dict[str, Any]]) -> Optional[str]:
    """Renders vector strokes/shapes/text from store.active_whiteboard_elements into a PNG data URL."""
    if not elements:
        return None
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return None

    min_x, min_y, max_x, max_y = float("inf"), float("inf"), float("-inf"), float("-inf")
    for el in elements:
        pts = el.get("points") or []
        if pts:
            for pt in pts:
                px, py = float(pt.get("x", 0)), float(pt.get("y", 0))
                min_x, max_x = min(min_x, px), max(max_x, px)
                min_y, max_y = min(min_y, py), max(max_y, py)
        elif el.get("start") and el.get("end"):
            sx, sy = float(el["start"].get("x", 0)), float(el["start"].get("y", 0))
            ex, ey = float(el["end"].get("x", 0)), float(el["end"].get("y", 0))
            min_x, max_x = min(min_x, sx, ex), max(max_x, sx, ex)
            min_y, max_y = min(min_y, sy, ey), max(max_y, sy, ey)
        elif el.get("x") is not None and el.get("y") is not None:
            tx, ty = float(el["x"]), float(el["y"])
            min_x, max_x = min(min_x, tx), max(max_x, tx + 160)
            min_y, max_y = min(min_y, ty - 24), max(max_y, ty + 24)

    if not (min_x < float("inf") and min_y < float("inf")):
        return None

    pad = 50.0
    span_w = max(max_x - min_x + pad * 2, 400.0)
    span_h = max(max_y - min_y + pad * 2, 260.0)
    target_w, target_h = 800, 560
    scale = min((target_w - 40) / span_w, (target_h - 40) / span_h, 1.5)
    cx, cy = (min_x + max_x) / 2.0, (min_y + max_y) / 2.0

    def to_px(wx: float, wy: float):
        return (
            int(round(target_w / 2.0 + (wx - cx) * scale)),
            int(round(target_h / 2.0 + (wy - cy) * scale)),
        )

    img = Image.new("RGB", (target_w, target_h), (248, 250, 252))
    draw = ImageDraw.Draw(img)

    for el in elements:
        el_type = el.get("type", "stroke")
        pts = el.get("points") or []
        width = max(2, int(round(float(el.get("size", 4)) * scale)))
        if el_type == "stroke" and pts:
            coords = [to_px(float(p.get("x", 0)), float(p.get("y", 0))) for p in pts]
            if len(coords) == 1:
                x, y = coords[0]
                draw.ellipse((x - width, y - width, x + width, y + width), fill=(15, 23, 42))
            else:
                draw.line(coords, fill=(15, 23, 42), width=width, joint="curve")
        elif el_type == "text" and el.get("text"):
            tx, ty = to_px(float(el.get("x", 0)), float(el.get("y", 0)) - 14)
            draw.text((tx, ty), str(el.get("text", "")), fill=(15, 23, 42))

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# ---------------------------------------------------------------------------
# 3. Gemini / OpenAI helpers (vision transcription + explanation)
# ---------------------------------------------------------------------------

TRANSCRIBE_PROMPT = """You are a precise handwriting transcriber for a maths whiteboard.
Read EVERY handwritten or typed equation visible anywhere on the board image.
For each equation or line that contains an '=' sign (or an answer box/bracket to the right of '='), output the left-hand side ("lhs") and the right-hand side ("rhs") EXACTLY as written.
Rules:
- Do NOT correct, solve or judge anything. Transcribe literally, even if the maths is wrong (e.g. if the board shows '12 - 4 = 81', output lhs: "12 - 4", rhs: "81").
- Use ASCII operators: + - * / ( ). A handwritten 'x' or '×' between numbers means multiply, write it as '*'.
- If the pupil wrote their answer inside or next to brackets/boxes after '=', put only the pupil's written answer in "rhs" (without '[' or ']').
- If nothing is written to the right of '=', set "rhs" to "".
- Ignore the coloured legend bar at the very top of the image and any UI chrome.
Respond ONLY with JSON: {"equations": [{"lhs": "12 - 4", "rhs": "81"}]}"""

_DEPRECATED_MODELS = {"gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-1.5-flash", "gemini-3.8-flash"}
_FAST_GEMINI_MODELS = [
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
]


def _load_llm_config(api_key: Optional[str]) -> Dict[str, Any]:
    try:
        from .llm_coach import _load_env_file
        _load_env_file()
    except Exception:
        pass

    explicit_key = (api_key or "").strip()
    gemini_key = explicit_key if (explicit_key and not explicit_key.startswith("sk-")) else os.environ.get("GEMINI_API_KEY", "").strip()
    openai_key = explicit_key if explicit_key.startswith("sk-") else os.environ.get("OPENAI_API_KEY", "").strip()

    configured_model = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest").strip()
    if not configured_model or configured_model in _DEPRECATED_MODELS:
        configured_model = "gemini-flash-lite-latest"

    models = [configured_model]
    for m in _FAST_GEMINI_MODELS:
        if m not in models:
            models.append(m)

    return {"gemini_key": gemini_key, "openai_key": openai_key, "models": models[:4]}


def _gemini_generate(parts: List[Dict[str, Any]], api_key: Optional[str], json_mode: bool,
                     timeout: int = 8) -> Optional[str]:
    cfg = _load_llm_config(api_key)
    if not cfg["gemini_key"]:
        return None

    for model in cfg["models"]:
        gen_cfg: Dict[str, Any] = {"temperature": 0.0}
        if json_mode:
            gen_cfg["responseMimeType"] = "application/json"
        if "3.6" in model or "3.7" in model or "3.8" in model or "3-flash" in model:
            gen_cfg["thinkingConfig"] = {"thinkingBudget": 0}

        body = json.dumps({
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": gen_cfg,
        }).encode("utf-8")

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={cfg['gemini_key']}"
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            cand = (result.get("candidates") or [{}])[0]
            texts = [
                p.get("text", "")
                for p in cand.get("content", {}).get("parts", [])
                if p.get("text") and not p.get("thought")
            ]
            if texts:
                return "".join(texts).strip()
        except Exception as e:
            logger.warning(f"[MathChecker] Gemini model '{model}' failed: {e}")
    return None


def _openai_generate(prompt: str, api_key: Optional[str], image_data_url: Optional[str] = None,
                     timeout: int = 10) -> Optional[str]:
    cfg = _load_llm_config(api_key)
    if not cfg["openai_key"]:
        return None
    content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    if image_data_url:
        img_url = image_data_url if image_data_url.startswith("data:") else f"data:image/jpeg;base64,{image_data_url}"
        content.append({"type": "image_url", "image_url": {"url": img_url, "detail": "low"}})
    body = json.dumps({
        "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        "messages": [{"role": "user", "content": content}],
        "response_format": {"type": "json_object"},
        "temperature": 0.0,
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {cfg['openai_key']}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        choices = result.get("choices") or []
        if choices and "message" in choices[0]:
            return (choices[0]["message"].get("content") or "").strip()
    except Exception as e:
        logger.warning(f"[MathChecker] OpenAI fallback failed: {e}")
    return None


def _split_data_url(data_url: str) -> Optional[Dict[str, str]]:
    if not data_url:
        return None
    if "," in data_url:
        header, b64 = data_url.split(",", 1)
        mime = "image/png" if "png" in header else "image/jpeg"
    else:
        b64, mime = data_url, "image/jpeg"
    return {"mime_type": mime, "data": b64}


def _parse_json_object(raw: str) -> Any:
    cleaned = re.sub(r"^```(?:json)?|```$", "", (raw or "").strip()).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        match = re.search(r"\{[\s\S]*\}|\[[\s\S]*\]", cleaned)
        if match:
            return json.loads(match.group(0))
        raise


def transcribe_equations(image_data_url: str, api_key: Optional[str] = None) -> Optional[List[Dict[str, str]]]:
    """Uses Gemini (or OpenAI) vision to transcribe all handwritten equations on the board."""
    inline = _split_data_url(image_data_url)
    if not inline:
        return None
    text = _gemini_generate(
        [{"text": TRANSCRIBE_PROMPT}, {"inline_data": inline}],
        api_key, json_mode=True, timeout=8
    )
    if not text:
        text = _openai_generate(TRANSCRIBE_PROMPT, api_key, image_data_url=image_data_url, timeout=10)
    if not text:
        return None
    try:
        data = _parse_json_object(text)
        eqs = data.get("equations", []) if isinstance(data, dict) else data
        out = []
        for e in eqs or []:
            if not isinstance(e, dict):
                continue
            lhs, rhs = str(e.get("lhs", "")).strip(), str(e.get("rhs", "")).strip()
            if lhs:
                out.append({"lhs": lhs, "rhs": rhs})
        return out
    except Exception as e:
        logger.warning(f"[MathChecker] Could not parse transcription JSON: {e} | raw={text[:200]}")
        return None


def explain_error(lhs: str, given: str, expected: str, api_key: Optional[str] = None) -> Dict[str, str]:
    """Gets a short LLM description of the misconception plus next steps for the tutor."""
    prompt = (
        f"A pupil answered the maths question '{lhs} = ?' with '{given}'. The correct answer is {expected}.\n"
        "You are coaching the TUTOR live. Respond ONLY with JSON:\n"
        '{"misconception": "one short sentence describing the most likely mistake the pupil made", '
        '"next_steps": "2-3 numbered short steps the tutor should take next, under 60 words total", '
        '"ask": "one short question the tutor can ask the pupil"}\n'
        "Use plain human maths notation (e.g. 12 - 4 = 8), no LaTeX."
    )
    text = _gemini_generate([{"text": prompt}], api_key, json_mode=True, timeout=6)
    if not text:
        text = _openai_generate(prompt, api_key, timeout=6)
    if text:
        try:
            data = _parse_json_object(text)
            if isinstance(data, dict) and data.get("misconception"):
                return {
                    "misconception": str(data.get("misconception", "")).strip(),
                    "next_steps": str(data.get("next_steps", "")).strip(),
                    "ask": str(data.get("ask", "")).strip(),
                }
        except Exception as e:
            logger.warning(f"[MathChecker] Could not parse explanation JSON: {e}")
    return _heuristic_explanation(lhs, given, expected)


def _heuristic_explanation(lhs: str, given: str, expected: str) -> Dict[str, str]:
    norm = normalize_expression(lhs)
    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*([\+\-\*/])\s*(-?\d+(?:\.\d+)?)\s*", norm)
    misconception = f"The pupil wrote {given}, but {lhs} = {expected}."
    if m:
        a, op, b = float(m.group(1)), m.group(2), float(m.group(3))
        g = parse_answer(given)
        alt = {"+": a - b, "-": a + b, "*": a + b, "/": a * b}
        if g is not None and abs(alt[op] - g) < 1e-9:
            wrong_op = {"+": "subtracted", "-": "added", "*": "added", "/": "multiplied"}[op]
            misconception = f"The pupil appears to have {wrong_op} instead of using '{op}'."
        elif g is not None and abs(abs(g - float(expected)) - 1) < 1e-9:
            misconception = "The answer is off by one - likely a counting slip."
    return {
        "misconception": misconception,
        "next_steps": "1. Ask the pupil to explain how they got their answer.\n"
                      "2. Rework the problem together with a simpler example.\n"
                      f"3. Have them check: does their answer fit {lhs}?",
        "ask": "Can you talk me through how you worked that out?",
    }


# ---------------------------------------------------------------------------
# 4. Board check orchestration & report integration
# ---------------------------------------------------------------------------

def _eq_signature(lhs: str, rhs: str) -> str:
    return f"{normalize_expression(lhs).replace(' ', '')}={normalize_expression(rhs).replace(' ', '')}"


def _compute_elements_signature(store: Any) -> str:
    active_els = getattr(store, "active_whiteboard_elements", None)
    if not active_els:
        return ""
    items = []
    for el_id, el in sorted(active_els.items(), key=lambda kv: str(kv[0])):
        pts = el.get("points") or []
        txt = el.get("text") or ""
        st = el.get("start") or {}
        en = el.get("end") or {}
        items.append(f"{el_id}:{len(pts)}:{txt}:{st.get('x')},{st.get('y')}-{en.get('x')},{en.get('y')}")
    return hashlib.sha1("|".join(items).encode("utf-8")).hexdigest()


def build_error_nudge(lhs: str, rhs: str, expected: str, explanation: Dict[str, str]) -> Dict[str, Any]:
    human_lhs = lhs.replace("*", "×").strip()
    question = f"{human_lhs} ="
    steps = explanation.get("next_steps", "")
    ask = explanation.get("ask", "")
    misconception = explanation.get("misconception", "")
    stepping_stone = f"{misconception}\nNext steps: {steps}".strip() if steps else misconception

    # Include custom_diagram metadata so "Drop on Board" / notebook actions work seamlessly
    custom_diagram = None
    action_label = "✨ Show Steps on Board"
    example_type = "ai_steps"
    try:
        from .llm_coach import build_pedagogical_interventions
        interventions = build_pedagogical_interventions(f"{lhs} = {expected}", rhs)
        custom_diagram = interventions.get("custom_diagram")
        action_label = interventions.get("action_label") or action_label
        example_type = interventions.get("example_type") or example_type
    except Exception:
        pass

    return {
        "tier": "T3",
        "category": "whiteboard_math_error",
        "confidence": "high",
        "context_badge": "⚠️ Calculation Error",
        "toast_text": f"Student wrote '{rhs}' for '{question}' (correct: {expected}) — {misconception}",
        "action_label": action_label,
        "example_type": example_type,
        "stepping_stone": stepping_stone,
        "counter_example": f"Ask: \"{ask}\"" if ask else "",
        "custom_diagram": custom_diagram,
        "notebook_entry": f"🔴 Calculation Error: {question} {rhs} (expected {expected}). {misconception}",
        "reasoning": f"{misconception}\n{steps}".strip(),
        "equation": question,
        "student_answer": rhs,
        "expected_answer": expected,
    }


def apply_nudge_to_coaching_report(report: Dict[str, Any], nudge: Dict[str, Any]) -> Dict[str, Any]:
    """Enriches a coaching report dict with the deterministic math error nudge."""
    if not report or not nudge:
        return report
    eq = nudge.get("equation", "")
    ans = nudge.get("student_answer", "")
    exp = nudge.get("expected_answer", "")
    reason = nudge.get("reasoning", "")

    wb_rel = report.setdefault("whiteboard_relevance", {})
    wb_rel["problem_status"] = "Answered with misconception"
    wb_rel["student_active_on_board"] = True
    wb_rel["current_active_equation"] = eq
    wb_rel["pupil_latest_work"] = ans
    wb_rel["acknowledgment"] = f"Pupil wrote '{ans}' for '{eq}' (correct answer: {exp})."
    wb_rel["pedagogical_insight"] = reason
    wb_rel["is_aligned_with_speech"] = True
    wb_rel["alignment_score"] = 95

    report["areas_for_growth"] = f"Student answered '{ans}' for '{eq}' (expected {exp}). {reason}"
    report["live_nudge"] = nudge
    return report


def check_board_for_errors(store: Any, image_data_url: Optional[str] = None,
                           api_key: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Thread-safe board math checker.
    Reads the board snapshot (or renders store.active_whiteboard_elements if snapshot is empty),
    verifies every equation and returns a toast payload for each NEW wrong answer.
    """
    sync_lock = getattr(store, "_math_sync_lock", None)
    if sync_lock is None:
        sync_lock = threading.Lock()
        store._math_sync_lock = sync_lock

    with sync_lock:
        if not image_data_url:
            snap = getattr(store, "most_recent_whiteboard", None) or {}
            image_data_url = snap.get("dataUrl") or ""
        if not image_data_url:
            active_els = list((getattr(store, "active_whiteboard_elements", None) or {}).values())
            image_data_url = render_elements_to_data_url(active_els) or ""
        if not image_data_url:
            return []

        img_hash = hashlib.sha1(image_data_url.encode("utf-8")).hexdigest()
        if getattr(store, "_math_last_image_hash", None) == img_hash:
            return []
        store._math_last_image_hash = img_hash

        equations = transcribe_equations(image_data_url, api_key=api_key)
        if equations is None:
            return []
        logger.info(f"[MathChecker] Transcribed board equations: {equations}")

        flagged = getattr(store, "_math_flagged_signatures", None)
        if flagged is None:
            flagged = set()
            store._math_flagged_signatures = flagged

        # Keep signatures of equations currently visible on the board; if a student erases
        # an equation and rewrites it later, it will be checked fresh.
        current_sigs = {_eq_signature(eq["lhs"], eq["rhs"]) for eq in equations if eq.get("rhs")}
        flagged.intersection_update(current_sigs)

        nudges = []
        for eq in equations:
            lhs, rhs = eq["lhs"], eq["rhs"]
            if not rhs:
                continue
            result = verify_equation(lhs, rhs)
            logger.info(f"[MathChecker] {lhs} = {rhs} -> {result}")
            if result["status"] == "correct":
                try:
                    store.record_answer_attempt(f"{lhs} =", rhs, is_correct=True)
                except Exception:
                    pass
                continue
            if result["status"] != "incorrect":
                continue

            sig = _eq_signature(lhs, rhs)
            if sig in flagged:
                continue
            flagged.add(sig)

            try:
                store.record_answer_attempt(f"{lhs} =", rhs, is_correct=False)
            except Exception:
                pass

            explanation = explain_error(lhs, rhs, result["expected"], api_key=api_key)
            nudge = build_error_nudge(lhs, rhs, result["expected"], explanation)
            nudges.append(nudge)

        if nudges:
            store._latest_math_nudge = nudges[-1]
            store._latest_math_nudge_ts = int(time.time() * 1000)

        return nudges
