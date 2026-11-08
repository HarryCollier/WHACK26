import unittest
from core.session_store import RoomSessionStore, TranscriptEntry
from core.telemetry import get_rolling_engagement
from core.llm_coach import generate_live_nudge

class TutorAlertRulesTest(unittest.TestCase):
    def test_single_instantaneous_frame_does_not_raise_alert(self):
        """A single confused frame (< 6s window, not majority) should not raise an alert."""
        store = RoomSessionStore("TEST_INSTANT")
        store.video_frame_features["student"].append({
            "timestamp_ms": 1000,
            "face_detected": True,
            "brow_furrow_score": 0.85,
            "attention_state": "confused",
            "engagement_score": 0.3
        })
        pulse = get_rolling_engagement(store, window_seconds=6)
        nudge = generate_live_nudge(store)
        self.assertFalse(pulse["is_majority_confused"])
        self.assertIsNone(nudge)

    def test_minority_confusion_does_not_raise_alert(self):
        """2 confused frames out of 6 (33% < 50%) should not trigger an alert."""
        store = RoomSessionStore("TEST_MINORITY")
        for i in range(4):
            store.video_frame_features["student"].append({
                "timestamp_ms": 1000 + i * 500,
                "face_detected": True,
                "brow_furrow_score": 0.05,
                "attention_state": "focused",
                "engagement_score": 0.85
            })
        for i in range(2):
            store.video_frame_features["student"].append({
                "timestamp_ms": 3000 + i * 500,
                "face_detected": True,
                "brow_furrow_score": 0.70,
                "attention_state": "confused",
                "engagement_score": 0.40
            })
        pulse = get_rolling_engagement(store, window_seconds=6)
        nudge = generate_live_nudge(store)
        self.assertFalse(pulse["is_majority_confused"])
        self.assertIsNone(nudge)

    def test_non_sustained_majority_confusion_triggers_alert(self):
        """
        Alternating confused and neutral frames (4 confused, 2 neutral = 66.7% > 50%).
        This is NOT sustained confusion, but IS a majority over 6 seconds.
        It must raise a tutor alert.
        """
        store = RoomSessionStore("TEST_MAJORITY_NON_SUSTAINED")
        pattern = [True, True, False, True, False, True]  # 4 confused, 2 neutral
        for i, is_conf in enumerate(pattern):
            store.video_frame_features["student"].append({
                "timestamp_ms": 1000 + i * 500,
                "face_detected": True,
                "brow_furrow_score": 0.65 if is_conf else 0.05,
                "attention_state": "confused" if is_conf else "focused",
                "engagement_score": 0.35 if is_conf else 0.85
            })
        pulse = get_rolling_engagement(store, window_seconds=6)
        nudge = generate_live_nudge(store)
        self.assertTrue(pulse["is_majority_confused"])
        self.assertIsNotNone(nudge)
        self.assertEqual(nudge["category"], "visual_confusion")

    def test_majority_brow_furrow_counts_as_confusion(self):
        """
        Brow furrow in the same box: frames with brow furrow > 0.35
        count as confusion and trigger the alert when majority (> 50%).
        """
        store = RoomSessionStore("TEST_BROW_FURROW")
        # 5 frames with elevated brow furrow
        for i in range(5):
            store.video_frame_features["student"].append({
                "timestamp_ms": 1000 + i * 500,
                "face_detected": True,
                "brow_furrow_score": 0.60,
                "attention_state": "focused",
                "engagement_score": 0.50
            })
        store.video_frame_features["student"].append({
            "timestamp_ms": 3500,
            "face_detected": True,
            "brow_furrow_score": 0.10,
            "attention_state": "focused",
            "engagement_score": 0.80
        })
        pulse = get_rolling_engagement(store, window_seconds=6)
        nudge = generate_live_nudge(store)
        self.assertTrue(pulse["is_majority_confused"])
        self.assertIsNotNone(nudge)
        self.assertEqual(nudge["category"], "visual_confusion")

    def test_majority_distracted_over_6s_triggers_alert(self):
        """
        Student looking away for majority of last 6s (4 out of 6 frames = 66.7%).
        Triggers distracted alert.
        """
        store = RoomSessionStore("TEST_DISTRACTED")
        for i in range(4):
            store.video_frame_features["student"].append({
                "timestamp_ms": 1000 + i * 500,
                "face_detected": True,
                "gaze_direction": "left",
                "eye_contact": False,
                "attention_state": "distracted",
                "engagement_score": 0.20
            })
        for i in range(2):
            store.video_frame_features["student"].append({
                "timestamp_ms": 3000 + i * 500,
                "face_detected": True,
                "gaze_direction": "forward",
                "eye_contact": True,
                "attention_state": "focused",
                "engagement_score": 0.85
            })
        pulse = get_rolling_engagement(store, window_seconds=6)
        nudge = generate_live_nudge(store)
        self.assertTrue(pulse["is_majority_distracted"])
        self.assertIsNotNone(nudge)
        self.assertEqual(nudge["category"], "pacing")
        self.assertEqual(nudge["context_badge"], "👀 Looking Away")

    def test_spoken_confusion_remains_active(self):
        """Spoken confusion triggers alert immediately when student speaks confusion cues."""
        store = RoomSessionStore("TEST_SPOKEN")
        store.transcripts.append(TranscriptEntry(
            role="student",
            client_id="student_1",
            timestamp=1000,
            text="wait what how do we divide fractions?"
        ))
        nudge = generate_live_nudge(store)
        self.assertIsNotNone(nudge)
        self.assertEqual(nudge["tier"], "T3")
        self.assertIn(nudge["context_badge"], ("🎯 Board Detection", "Spoken Confusion"))

    def test_calculus_integral_dynamic_intervention(self):
        """Calculus integrals on board must dynamically produce calculus power rule and never 5s and 2s."""
        from core.llm_coach import build_pedagogical_interventions
        intervention = build_pedagogical_interventions("integral of x dx =")
        stepping_stone = intervention["stepping_stone"].lower()
        counter_example = intervention["counter_example"].lower()

        # Must not contain hardcoded 5s and 2s
        self.assertNotIn("5s and 2s", stepping_stone)
        self.assertNotIn("5s and 2s", counter_example)
        self.assertNotIn("friendly 5s", stepping_stone)

        # Must be tailored to calculus / power rule / antiderivative
        self.assertTrue(
            "power rule" in stepping_stone or "integral" in stepping_stone or "antiderivative" in stepping_stone,
            f"Expected calculus concepts, got: {stepping_stone}"
        )
        self.assertEqual(intervention["example_type"], "calculus_integral")

    def test_positive_nudges_are_removed(self):
        """Positive nudges ('Solved correctly', 'New problem started') must never produce a live toast."""
        import time
        store = RoomSessionStore("TEST_POSITIVE_REMOVAL")
        now = int(time.time() * 1000)
        store.last_coaching_timestamp = now - 5000
        store.last_coaching_report = {
            "whiteboard_relevance": {
                "current_active_equation": "21 - 1 = 20",
                "pupil_latest_work": "20",
                "problem_status": "Solved correctly",
                "acknowledgment": "Great job solving correctly!",
                "student_active_on_board": False
            }
        }
        nudge = generate_live_nudge(store)
        self.assertIsNone(nudge, "Positive 'Solved correctly' should not generate a nudge toast.")

        # Test new problem started
        store.last_coaching_report["whiteboard_relevance"]["problem_status"] = "New problem started"
        nudge = generate_live_nudge(store)
        self.assertIsNone(nudge, "Positive 'New problem started' should not generate a nudge toast.")

    def test_nudge_rate_limiting_raises_the_bar(self):
        """A nudge fired within 40 seconds of a previous nudge is suppressed to avoid spamming the tutor."""
        import time
        store = RoomSessionStore("TEST_RATE_LIMIT")
        now = int(time.time() * 1000)
        # Simulate that a nudge fired 10 seconds ago
        store.last_nudge_timestamp = now - 10000

        # Even with spoken confusion, the global rate limiter must hold
        store.transcripts.append(TranscriptEntry(
            role="student",
            client_id="student_1",
            timestamp=now - 2000,
            text="wait what I don't understand"
        ))
        nudge = generate_live_nudge(store)
        self.assertIsNone(nudge, "Nudge should be suppressed within 40s cooldown.")

if __name__ == "__main__":
    unittest.main()
