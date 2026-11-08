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
        import time
        now = int(time.time() * 1000)
        store = RoomSessionStore("TEST_SPOKEN")
        store.transcripts.append(TranscriptEntry(
            role="student",
            client_id="student_1",
            timestamp=now - 1000,
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

    def test_nudge_fires_based_on_signal_strength_without_artificial_time_cooldown(self):
        """Nudges fire on strong signals without artificial time-based blocking."""
        import time
        store = RoomSessionStore("TEST_SIGNAL_STRENGTH")
        now = int(time.time() * 1000)

        # Spoken confusion triggers immediately when signal occurs
        store.transcripts.append(TranscriptEntry(
            role="student",
            client_id="student_1",
            timestamp=now - 2000,
            text="wait what I don't understand"
        ))
        nudge = generate_live_nudge(store)
        self.assertIsNotNone(nudge, "Strong spoken signal should trigger nudge directly.")
        self.assertEqual(nudge["category"], "confusion")

    def test_20s_minimum_cooldown_between_popups(self):
        """Once a popup is created, there must be at least a 20s cooldown before another popup can trigger."""
        import time
        now = int(time.time() * 1000)
        store = RoomSessionStore("TEST_COOLDOWN_20S")
        store.last_nudge_timestamp = now - 5000  # Only 5 seconds ago

        # Strong signal arrives
        store.transcripts.append(TranscriptEntry(
            role="student",
            client_id="student_1",
            timestamp=now - 1000,
            text="wait what I don't understand"
        ))
        nudge = generate_live_nudge(store)
        self.assertIsNone(nudge, "Nudge should be blocked during the 20-second cooldown window.")

        # Once 20 seconds have elapsed, nudge is allowed again
        store.last_nudge_timestamp = now - 20001
        nudge_after = generate_live_nudge(store)
        self.assertIsNotNone(nudge_after, "Nudge should trigger after 20 seconds cooldown.")

    def test_coaching_report_includes_right_and_wrong_work(self):
        """AI Coach report schema must include what_student_did_well and areas_for_growth."""
        from core.llm_coach import generate_coaching_report
        telemetry = {
            "dialogue_timeline": [
                {"role": "tutor", "speech": "What is 21 - 1?"},
                {"role": "student", "speech": "I wrote 16 on the board."}
            ],
            "video_telemetry": {},
            "whiteboard_telemetry": {
                "student_edits": 3,
                "recent_elements_log": [
                    {"role": "tutor", "text": "21 - 1 ="},
                    {"role": "student", "text": "16"}
                ]
            }
        }
        report = generate_coaching_report(telemetry, provider_override="heuristic")
        self.assertIn("what_student_did_well", report)
        self.assertIn("areas_for_growth", report)
        self.assertTrue(len(report["what_student_did_well"]) > 0)
        self.assertTrue(len(report["areas_for_growth"]) > 0)

    def test_2_wrong_attempts_triggers_popup(self):
        """When student gets 2 attempts wrong, it must trigger a T3 popup."""
        store = RoomSessionStore("TEST_WRONG_2")
        store.active_problem_concept = "21 - 1"
        store.record_answer_attempt("21 - 1", "16", is_correct=False)
        self.assertEqual(store.wrong_attempts_count, 1)
        # 1st attempt should not trigger 2nd-wrong-attempt popup
        nudge1 = generate_live_nudge(store)
        self.assertIsNone(nudge1)

        # 2nd wrong attempt
        store.record_answer_attempt("21 - 1", "14", is_correct=False)
        self.assertEqual(store.wrong_attempts_count, 2)
        nudge2 = generate_live_nudge(store)
        self.assertIsNotNone(nudge2, "2nd wrong attempt should immediately trigger live nudge popup!")
        self.assertEqual(nudge2["tier"], "T3")
        self.assertEqual(nudge2["category"], "persistent_misconception")
        self.assertEqual(nudge2["context_badge"], "⚠️ 2nd Wrong Attempt")

    def test_nudge_step_breakdown_under_100_words(self):
        """Nudge advice breakdown must provide actionable guidance and stay strictly under 100 words."""
        from core.llm_coach import generate_nudge_step_breakdown
        breakdown = generate_nudge_step_breakdown("integral of x dx")
        word_count = len(breakdown.split())
        self.assertLess(word_count, 100)
        self.assertTrue("Ask:" in breakdown or "Steps" in breakdown)

    def test_arbitrary_wrong_math_answer_flags_in_report_and_popup(self):
        """Any wrong math answer (e.g. 25 - 4 = 19 or 8 x 6 = 42) must flag as misconception in report and trigger a popup."""
        from core.session_store import evaluate_math_attempt
        from core.telemetry import build_telemetry_payload
        from core.llm_coach import generate_coaching_report

        self.assertFalse(evaluate_math_attempt("25 - 4 =", "19"))
        self.assertTrue(evaluate_math_attempt("25 - 4 =", "21"))
        self.assertFalse(evaluate_math_attempt("8 x 6 =", "42"))
        self.assertTrue(evaluate_math_attempt("8 x 6 =", "48"))

        store = RoomSessionStore("TEST_ARBITRARY_WRONG")
        store.record_whiteboard_element({"id": "q1", "type": "text", "text": "25 - 4 ="}, "tutor", "t1")
        store.record_whiteboard_element({"id": "a1", "type": "text", "text": "19"}, "student", "s1")
        self.assertEqual(store.wrong_attempts_count, 1)

        payload = build_telemetry_payload(store)
        report = generate_coaching_report(payload, provider_override="heuristic")
        store.add_coaching_report(report)

        self.assertEqual(report["whiteboard_relevance"]["problem_status"], "Answered with misconception")
        self.assertIn("19", report["areas_for_growth"])

        nudge = generate_live_nudge(store)
        self.assertIsNotNone(nudge, "Wrong answer in coaching report must immediately trigger a live popup!")
        self.assertEqual(nudge["tier"], "T3")
        self.assertIn("19", nudge["toast_text"])

if __name__ == "__main__":
    unittest.main()
