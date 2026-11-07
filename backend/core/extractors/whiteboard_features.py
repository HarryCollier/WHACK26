"""
Whiteboard Delta Extractor
==========================
Compares two whiteboard snapshot data-URLs (base64 JPEG/PNG) and returns
a structured dict describing how much changed, the direction of change,
and the estimated whiteboard idle time.

Features:
  - change_percent          : 0.0–100.0 percentage of pixels that changed
  - change_level            : "none" | "minor" | "moderate" | "major"
  - dominant_change_region  : "top" | "bottom" | "left" | "right" | "centre" | "spread"
  - is_blank                : True if the new snapshot appears completely blank/white
  - pixel_diff_count        : raw count of changed pixels
"""

import base64
import logging

import numpy as np

logger = logging.getLogger(__name__)

# Threshold (0–255) for considering a pixel "changed"
PIXEL_CHANGE_THRESHOLD = 20


def _decode_image(data_url: str):
    """Decode a data-URL or raw base64 string to an ndarray (RGB)."""
    import cv2
    if "," in data_url:
        _, b64data = data_url.split(",", 1)
    else:
        b64data = data_url
    img_bytes = base64.b64decode(b64data)
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    return img


def extract_whiteboard_delta(previous_data_url: str, current_data_url: str) -> dict:
    """
    Args:
        previous_data_url: Base64 data-URL of the previous whiteboard snapshot.
        current_data_url:  Base64 data-URL of the current whiteboard snapshot.

    Returns:
        Dict with whiteboard delta features.
    """
    base_result = {
        "change_percent": 0.0,
        "change_level": "none",
        "dominant_change_region": None,
        "is_blank": False,
        "pixel_diff_count": 0,
        "error": None,
    }

    try:
        import cv2
    except ImportError as e:
        base_result["error"] = str(e)
        return base_result

    # ── Decode both images ────────────────────────────────────────────────────
    try:
        prev_img = _decode_image(previous_data_url)
        curr_img = _decode_image(current_data_url)
    except Exception as e:
        base_result["error"] = f"image decode failed: {e}"
        return base_result

    if prev_img is None or curr_img is None:
        base_result["error"] = "cv2 could not decode one or both images"
        return base_result

    # ── Resize to common resolution for comparison ────────────────────────────
    target_h, target_w = 240, 320
    try:
        prev_small = cv2.resize(prev_img, (target_w, target_h), interpolation=cv2.INTER_AREA)
        curr_small = cv2.resize(curr_img, (target_w, target_h), interpolation=cv2.INTER_AREA)
    except Exception as e:
        base_result["error"] = f"resize failed: {e}"
        return base_result

    # ── Blank detection (is the board mostly white/light?) ────────────────────
    curr_gray = cv2.cvtColor(curr_small, cv2.COLOR_BGR2GRAY)
    mean_brightness = float(np.mean(curr_gray))
    base_result["is_blank"] = mean_brightness > 240  # near-white

    # ── Pixel difference ──────────────────────────────────────────────────────
    prev_gray = cv2.cvtColor(prev_small, cv2.COLOR_BGR2GRAY)
    diff = cv2.absdiff(prev_gray, curr_gray)
    changed_mask = diff > PIXEL_CHANGE_THRESHOLD
    pixel_diff_count = int(np.sum(changed_mask))
    total_pixels = target_w * target_h
    change_percent = round((pixel_diff_count / total_pixels) * 100, 2)

    base_result["pixel_diff_count"] = pixel_diff_count
    base_result["change_percent"] = change_percent

    # ── Change level ──────────────────────────────────────────────────────────
    if change_percent < 0.5:
        change_level = "none"
    elif change_percent < 5.0:
        change_level = "minor"
    elif change_percent < 20.0:
        change_level = "moderate"
    else:
        change_level = "major"
    base_result["change_level"] = change_level

    # ── Dominant change region ────────────────────────────────────────────────
    if pixel_diff_count > 0:
        try:
            ys, xs = np.where(changed_mask)
            cx = float(np.mean(xs)) / target_w  # 0.0 (left) → 1.0 (right)
            cy = float(np.mean(ys)) / target_h  # 0.0 (top)  → 1.0 (bottom)

            spread_x = float(np.std(xs)) / target_w
            spread_y = float(np.std(ys)) / target_h

            if spread_x > 0.3 and spread_y > 0.3:
                region = "spread"
            elif cx < 0.35:
                region = "left"
            elif cx > 0.65:
                region = "right"
            elif cy < 0.35:
                region = "top"
            elif cy > 0.65:
                region = "bottom"
            else:
                region = "centre"
            base_result["dominant_change_region"] = region
        except Exception:
            pass

    return base_result


def compare_whiteboard_history(history: list, most_recent: dict) -> dict:
    """
    Given the full whiteboard history list and the current snapshot,
    compute the delta between the most recent pair.

    Args:
        history: List of previous whiteboard snapshot dicts (each has 'dataUrl', 'timestamp', 'role')
        most_recent: Current whiteboard snapshot dict

    Returns:
        Delta feature dict, plus 'previous_timestamp' and 'current_timestamp' metadata.
    """
    if most_recent is None:
        return {"change_level": "none", "note": "no current whiteboard data"}

    if not history:
        return {
            "change_level": "none",
            "note": "no history to compare against (first snapshot)",
            "is_blank": False,
            "change_percent": 0.0,
        }

    previous = history[-1]
    result = extract_whiteboard_delta(
        previous_data_url=previous.get("dataUrl", ""),
        current_data_url=most_recent.get("dataUrl", "")
    )
    result["previous_timestamp"] = previous.get("timestamp")
    result["current_timestamp"] = most_recent.get("timestamp")
    result["snapshots_in_history"] = len(history)
    return result
