import json
from django.test import TestCase, Client
from django.urls import reverse
from core.models import MeetingRoom
from core.session_store import RoomSessionStore, SessionManager, TranscriptEntry, VideoFrameEntry

class MeetingRoomModelTest(TestCase):
    def test_room_creation(self):
        code = MeetingRoom.generate_code()
        room = MeetingRoom.objects.create(
            room_code=code,
            title="Linear Algebra Tutoring",
            passcode="secret123"
        )
        self.assertEqual(room.room_code, code)
        self.assertEqual(room.title, "Linear Algebra Tutoring")
        self.assertEqual(room.passcode, "secret123")
        self.assertTrue(room.is_active)
        self.assertIn(code, str(room))

    def test_generate_unique_code(self):
        code1 = MeetingRoom.generate_code()
        code2 = MeetingRoom.generate_code()
        self.assertNotEqual(code1, code2)
        self.assertEqual(len(code1), 8)


class RoomAPITests(TestCase):
    def setUp(self):
        self.client = Client()

    def test_create_room_success(self):
        response = self.client.post(
            reverse('room-create'),
            data=json.dumps({"title": "Physics 101", "passcode": "pass123"}),
            content_type="application/json"
        )
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertIn("room_code", data)
        self.assertEqual(data["title"], "Physics 101")
        self.assertEqual(data["role"], "tutor")

        # Verify DB entry
        room = MeetingRoom.objects.get(room_code=data["room_code"])
        self.assertEqual(room.passcode, "pass123")

    def test_create_room_missing_passcode(self):
        response = self.client.post(
            reverse('room-create'),
            data=json.dumps({"title": "Physics 101"}),
            content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())

    def test_join_room_success(self):
        room = MeetingRoom.objects.create(
            room_code="TEST1234",
            title="Bio Session",
            passcode="bioPass"
        )
        response = self.client.post(
            reverse('room-join'),
            data=json.dumps({"room_code": "TEST1234", "passcode": "bioPass"}),
            content_type="application/json"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["role"], "student")
        self.assertEqual(data["room_code"], "TEST1234")

    def test_join_room_wrong_passcode(self):
        MeetingRoom.objects.create(
            room_code="ROOMABC",
            title="History",
            passcode="correctPass"
        )
        response = self.client.post(
            reverse('room-join'),
            data=json.dumps({"room_code": "ROOMABC", "passcode": "wrongPass"}),
            content_type="application/json"
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn("Incorrect passcode", response.json()["error"])

    def test_join_nonexistent_room(self):
        response = self.client.post(
            reverse('room-join'),
            data=json.dumps({"room_code": "NONEXISTENT", "passcode": "123"}),
            content_type="application/json"
        )
        self.assertEqual(response.status_code, 404)


class SessionStoreUnitTest(TestCase):
    def setUp(self):
        self.manager = SessionManager.get_instance()

    def test_whiteboard_dual_storage_transition(self):
        store = RoomSessionStore(room_code="WB_TEST")
        
        # Initially empty
        self.assertIsNone(store.most_recent_whiteboard)
        self.assertEqual(len(store.all_whiteboards_history), 0)

        # 1st snapshot
        store.update_whiteboard("data:image/jpeg;base64,frame1", timestamp=1000, role="tutor")
        self.assertIsNotNone(store.most_recent_whiteboard)
        self.assertEqual(store.most_recent_whiteboard["timestamp"], 1000)
        self.assertEqual(len(store.all_whiteboards_history), 0)

        # 2nd snapshot -> previous moves to history, new becomes most_recent
        store.update_whiteboard("data:image/jpeg;base64,frame2", timestamp=2000, role="student")
        self.assertEqual(store.most_recent_whiteboard["timestamp"], 2000)
        self.assertEqual(len(store.all_whiteboards_history), 1)
        self.assertEqual(store.all_whiteboards_history[0]["timestamp"], 1000)

        # 3rd snapshot -> history now has 2 items
        store.update_whiteboard("data:image/jpeg;base64,frame3", timestamp=3000, role="tutor")
        self.assertEqual(store.most_recent_whiteboard["timestamp"], 3000)
        self.assertEqual(len(store.all_whiteboards_history), 2)
        self.assertEqual(store.all_whiteboards_history[1]["timestamp"], 2000)

    def test_video_frames_storage_and_partitioning(self):
        store = RoomSessionStore(room_code="VID_TEST")
        store.add_video_frame("tutor", "tutor_1", 100, "data:image/jpeg;base64,t1")
        store.add_video_frame("tutor", "tutor_1", 200, "data:image/jpeg;base64,t2")
        store.add_video_frame("student", "student_1", 150, "data:image/jpeg;base64,s1")

        self.assertEqual(len(store.video_frames["tutor"]), 2)
        self.assertEqual(len(store.video_frames["student"]), 1)
        self.assertEqual(store.video_frames["tutor"][0].timestamp, 100)
        self.assertEqual(store.video_frames["student"][0].timestamp, 150)

    def test_session_wipe_when_all_peers_leave(self):
        store = self.manager.get_or_create("WIPE_ROOM")
        store.active_peers.add("client_A")
        store.active_peers.add("client_B")

        store.update_whiteboard("data:wb", 1, "tutor")
        store.add_video_frame("tutor", "client_A", 1, "data:vf")

        # Client A leaves -> room should still exist because client B is inside
        self.manager.remove_peer_and_cleanup("WIPE_ROOM", "client_A")
        self.assertIn("WIPE_ROOM", self.manager.rooms)

        # Client B leaves -> room should be wiped completely
        self.manager.remove_peer_and_cleanup("WIPE_ROOM", "client_B")
        self.assertNotIn("WIPE_ROOM", self.manager.rooms)
        self.assertIsNone(store.most_recent_whiteboard)
        self.assertEqual(len(store.all_whiteboards_history), 0)
        self.assertEqual(len(store.video_frames), 0)


class TelemetryAndExtractorsTest(TestCase):
    def setUp(self):
        self.client = Client()
        self.manager = SessionManager.get_instance()

    def test_telemetry_endpoint_404_when_no_session(self):
        response = self.client.get(reverse('session-telemetry', kwargs={'room_code': 'NONEXISTENT'}))
        self.assertEqual(response.status_code, 404)

    def test_telemetry_payload_generation(self):
        from core.telemetry import build_telemetry_payload
        store = self.manager.get_or_create("TELEM_TEST")
        store.transcripts.append(TranscriptEntry(
            role="tutor",
            client_id="t1",
            timestamp=1000,
            text="Hello welcome to the lesson"
        ))
        store.transcripts.append(TranscriptEntry(
            role="student",
            client_id="s1",
            timestamp=3000,
            text="Thanks I need help with calculus"
        ))

        payload = build_telemetry_payload(store)
        self.assertEqual(payload["room_code"], "TELEM_TEST")
        self.assertEqual(len(payload["dialogue_timeline"]), 2)
        self.assertIn("llm_prompt_context", payload)
        self.assertIn("video_telemetry", payload)
        self.assertIn("whiteboard_telemetry", payload)

        # Query via HTTP endpoint
        response = self.client.get(reverse('session-telemetry', kwargs={'room_code': 'TELEM_TEST'}))
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data["dialogue_timeline"]), 2)
        self.assertEqual(data["dialogue_timeline"][0]["speech"], "Hello welcome to the lesson")

        # Clean up
        store.wipe_session()
        del self.manager.rooms["TELEM_TEST"]


class MultimodalExtractorsUnitTest(TestCase):
    """
    Comprehensive tests using synthetic audio waves, whiteboard strokes,
    and video frames to verify end-to-end extraction and telemetry pipeline.
    """
    def test_whiteboard_delta_extraction(self):
        import cv2, numpy as np, base64
        from core.extractors.whiteboard_features import extract_whiteboard_delta

        # Create 1st snapshot (blank canvas)
        canvas1 = np.full((240, 320, 3), 255, dtype=np.uint8)
        _, buf1 = cv2.imencode('.png', canvas1)
        b64_1 = 'data:image/png;base64,' + base64.b64encode(buf1).decode('utf-8')

        # Create 2nd snapshot with some tutor math writing
        canvas2 = canvas1.copy()
        cv2.line(canvas2, (40, 60), (280, 60), (0, 0, 0), 4)
        cv2.putText(canvas2, 'E = mc^2', (50, 140), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
        _, buf2 = cv2.imencode('.png', canvas2)
        b64_2 = 'data:image/png;base64,' + base64.b64encode(buf2).decode('utf-8')

        delta = extract_whiteboard_delta(b64_1, b64_2)
        self.assertGreater(delta['change_percent'], 0.1)
        self.assertIn(delta['change_level'], ['minor', 'moderate', 'major'])
        self.assertGreater(delta['pixel_diff_count'], 0)
        self.assertIsNone(delta['error'])

    def test_audio_feature_extraction(self):
        import numpy as np, io, base64, soundfile as sf
        from core.extractors.audio_features import extract_audio_features

        # Generate 1.0 second of 220Hz synthetic tone (typical human voice fundamental)
        sr = 16000
        duration = 1.0
        t = np.linspace(0, duration, int(sr * duration), endpoint=False)
        audio = 0.5 * np.sin(2 * np.pi * 220 * t)

        buf = io.BytesIO()
        sf.write(buf, audio, sr, format='WAV')
        b64_audio = base64.b64encode(buf.getvalue()).decode('utf-8')

        features = extract_audio_features(b64_audio)
        self.assertNotIn('error', features)
        self.assertGreater(features['rms_mean'], 0.0)
        self.assertAlmostEqual(features['pitch_mean_hz'], 220.0, delta=15.0)
        self.assertIn(features['confidence_signal'], ['low', 'medium', 'high'])

    def test_video_feature_extraction_on_frame(self):
        import cv2, numpy as np, base64
        from core.extractors.video_features import extract_video_features

        # 1. Blank frame test (no face detected)
        frame_blank = np.zeros((240, 320, 3), dtype=np.uint8)
        _, buf_b = cv2.imencode('.jpg', frame_blank)
        data_url_b = 'data:image/jpeg;base64,' + base64.b64encode(buf_b).decode('utf-8')

        res_b = extract_video_features(data_url_b)
        self.assertFalse(res_b['face_detected'])
        self.assertEqual(res_b['attention_state'], 'no_face')

        # 2. Real frontal face test (detects eyes, nose, gaze, engagement)
        w, h = 480, 480
        frame_face = np.full((h, w, 3), 200, dtype=np.uint8)
        cv2.ellipse(frame_face, (240, 240), (120, 160), 0, 0, 360, (180, 190, 220), -1)
        cv2.circle(frame_face, (190, 200), 20, (255, 255, 255), -1)
        cv2.circle(frame_face, (190, 200), 8, (50, 50, 50), -1)
        cv2.circle(frame_face, (290, 200), 20, (255, 255, 255), -1)
        cv2.circle(frame_face, (290, 200), 8, (50, 50, 50), -1)
        cv2.line(frame_face, (240, 220), (240, 260), (100, 100, 100), 3)
        cv2.line(frame_face, (210, 300), (270, 300), (80, 80, 150), 4)

        _, buf_f = cv2.imencode('.jpg', frame_face)
        data_url_f = 'data:image/jpeg;base64,' + base64.b64encode(buf_f).decode('utf-8')

        res_f = extract_video_features(data_url_f)
        self.assertTrue(res_f['face_detected'])
        self.assertEqual(res_f['gaze_direction'], 'forward')
        self.assertTrue(res_f['eye_contact'])
        self.assertEqual(res_f['attention_state'], 'focused')
        self.assertGreaterEqual(res_f['engagement_score'], 0.70)
        self.assertEqual(res_f['engagement_label'], 'engaged')

    def test_full_session_multimodal_ingest_and_telemetry(self):
        from core.session_store import SessionManager
        from core.telemetry import build_telemetry_payload
        import cv2, numpy as np, base64

        manager = SessionManager.get_instance()
        store = manager.get_or_create("FULL_TEST")

        # 1. Simulate whiteboard drawings
        canvas1 = np.full((240, 320, 3), 255, dtype=np.uint8)
        _, buf1 = cv2.imencode('.png', canvas1)
        store.update_whiteboard('data:image/png;base64,' + base64.b64encode(buf1).decode('utf-8'), 1000, 'tutor')

        canvas2 = canvas1.copy()
        cv2.circle(canvas2, (120, 120), 40, (0, 0, 0), -1)
        _, buf2 = cv2.imencode('.png', canvas2)
        store.update_whiteboard('data:image/png;base64,' + base64.b64encode(buf2).decode('utf-8'), 4000, 'tutor')

        # 2. Simulate video frames
        vf = np.zeros((120, 160, 3), dtype=np.uint8)
        _, vbuf = cv2.imencode('.jpg', vf)
        vdata = 'data:image/jpeg;base64,' + base64.b64encode(vbuf).decode('utf-8')
        for i in range(6):
            store.add_video_frame('tutor', 'client_1', 1000 + i * 500, vdata)

        # 3. Verify telemetry payload contains everything
        payload = build_telemetry_payload(store)
        self.assertEqual(payload['room_code'], 'FULL_TEST')
        self.assertGreaterEqual(payload['whiteboard_telemetry']['total_snapshots'], 2)
        self.assertGreater(len(payload['whiteboard_telemetry']['delta_history']), 0)
        self.assertEqual(payload['video_telemetry']['tutor']['frames_captured'], 6)
        self.assertIn('llm_prompt_context', payload)

        store.wipe_session()
        del manager.rooms['FULL_TEST']

    def test_real_video_feed_face_and_engagement_sequence(self):
        """
        Tests processing an actual continuous video stream of a human face
        (sample_face_feed.mp4) through SessionStore and TelemetryAggregator.
        Verifies that engagement is detected, gaze is forward, and metrics are computed.
        """
        import cv2, os, base64
        from core.session_store import SessionManager
        from core.telemetry import build_telemetry_payload

        video_path = os.path.join(os.path.dirname(__file__), 'extractors', 'sample_face_feed.mp4')
        if not os.path.exists(video_path):
            self.skipTest("sample_face_feed.mp4 not present for real video feed test")

        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 24.0

        manager = SessionManager.get_instance()
        store = manager.get_or_create("REAL_FEED_TEST")

        # Simulate 12 client video frames (approx 4 seconds of webcam stream)
        for i in range(12):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(i * fps * 0.35))
            ret, frame = cap.read()
            if not ret:
                break
            _, buf = cv2.imencode('.jpg', frame)
            data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf).decode('utf-8')
            store.add_video_frame('tutor', 'client_tutor', 1000 + i * 350, data_url)

        cap.release()

        # Build LLM telemetry payload
        payload = build_telemetry_payload(store)
        vt = payload['video_telemetry']['tutor']

        # Assertions on real video feed telemetry
        self.assertEqual(vt['frames_captured'], 12)
        self.assertGreaterEqual(vt['frames_analysed'], 4)
        self.assertIsNotNone(vt['engagement_avg'])
        self.assertGreaterEqual(vt['engagement_avg'], 0.70, f"Expected >70% engagement on frontal face video feed, got {vt['engagement_avg']}")
        self.assertEqual(vt['current_attention'], 'focused')
        self.assertIn('forward', vt['gaze_summary'])
        self.assertGreater(len(vt['engagement_trend']), 0)

        # Check each trend sample has non-zero engagement
        for pt in vt['engagement_trend']:
            self.assertGreater(pt['engagement_score'], 0.60)
            self.assertEqual(pt['engagement_label'], 'engaged')

        # Clean up
        store.wipe_session()
        del manager.rooms["REAL_FEED_TEST"]

    def test_real_photo_face_detection_and_blendshapes(self):
        """
        Tests extract_video_features on a real human portrait (test_face.jpg).
        Verifies that landmarks, gaze, head pose, and blendshape scores are properly extracted.
        """
        import cv2, os, base64
        from core.extractors.video_features import extract_video_features

        img_path = os.path.join(os.path.dirname(__file__), 'extractors', 'test_face.jpg')
        if not os.path.exists(img_path):
            self.skipTest("test_face.jpg not present")

        img = cv2.imread(img_path)
        _, buf = cv2.imencode('.jpg', img)
        data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf).decode('utf-8')

        res = extract_video_features(data_url)
        self.assertTrue(res['face_detected'])
        self.assertGreater(res['engagement_score'], 0.0)
        self.assertIsNotNone(res['head_yaw_deg'])
        self.assertIsNotNone(res['head_pitch_deg'])
        self.assertGreaterEqual(res['eye_openness'], 0.5)
        self.assertIn(res['attention_state'], ['focused', 'distracted', 'confused', 'reading_board', 'speaking', 'engaged_happy'])

    def test_dual_independent_video_feeds_tutor_and_student(self):
        """
        Verifies that tutor and student have completely separated video streams:
        - Tutor feed from their camera (client_id="tutor_device")
        - Student feed from their camera (client_id="student_device")
        - Analyzed independently by MediaPipe with num_faces=1 per stream
        - Telemetry reports separate engagement, gaze, and attention metrics for each person.
        """
        import cv2, os, base64, numpy as np
        from core.session_store import SessionManager
        from core.telemetry import build_telemetry_payload

        manager = SessionManager.get_instance()
        store = manager.get_or_create("DUAL_FEED_TEST")

        # 1. Tutor frame: Frontal face looking directly at camera
        tutor_img = np.full((360, 480, 3), 200, dtype=np.uint8)
        cv2.ellipse(tutor_img, (240, 180), (100, 140), 0, 0, 360, (180, 190, 220), -1)
        cv2.circle(tutor_img, (200, 150), 16, (255, 255, 255), -1)
        cv2.circle(tutor_img, (200, 150), 6, (50, 50, 50), -1)
        cv2.circle(tutor_img, (280, 150), 16, (255, 255, 255), -1)
        cv2.circle(tutor_img, (280, 150), 6, (50, 50, 50), -1)
        cv2.line(tutor_img, (240, 170), (240, 210), (100, 100, 100), 3)
        cv2.line(tutor_img, (210, 240), (270, 240), (80, 80, 150), 4)

        _, buf_t = cv2.imencode('.jpg', tutor_img)
        tutor_data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf_t).decode('utf-8')

        # 2. Student frame: Face looking down at notebook/whiteboard
        student_img = np.full((360, 480, 3), 200, dtype=np.uint8)
        cv2.ellipse(student_img, (240, 210), (100, 140), 0, 0, 360, (180, 190, 220), -1)
        # Eyes positioned lower
        cv2.circle(student_img, (200, 200), 16, (255, 255, 255), -1)
        cv2.circle(student_img, (200, 208), 6, (50, 50, 50), -1)
        cv2.circle(student_img, (280, 200), 16, (255, 255, 255), -1)
        cv2.circle(student_img, (280, 208), 6, (50, 50, 50), -1)
        cv2.line(student_img, (240, 220), (240, 250), (100, 100, 100), 3)
        cv2.line(student_img, (220, 280), (260, 280), (80, 80, 150), 4)

        _, buf_s = cv2.imencode('.jpg', student_img)
        student_data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf_s).decode('utf-8')

        # Interleave incoming packets from tutor and student
        for i in range(6):
            ts = 1000 + i * 500
            store.add_video_frame('tutor', 'tutor_laptop', ts, tutor_data_url)
            store.add_video_frame('student', 'student_tablet', ts, student_data_url)

        # Build combined session telemetry
        payload = build_telemetry_payload(store)

        # Verify tutor telemetry partition
        vt_tutor = payload['video_telemetry']['tutor']
        self.assertEqual(vt_tutor['frames_captured'], 6)
        self.assertGreaterEqual(vt_tutor['frames_analysed'], 2)
        self.assertIsNotNone(vt_tutor['engagement_avg'])
        self.assertGreater(vt_tutor['engagement_avg'], 0.65)

        # Verify student telemetry partition
        vt_student = payload['video_telemetry']['student']
        self.assertEqual(vt_student['frames_captured'], 6)
        self.assertGreaterEqual(vt_student['frames_analysed'], 2)
        self.assertIsNotNone(vt_student['engagement_avg'])

        # Verify they are partitioned and do not overwrite each other
        self.assertEqual(len(store.video_frames['tutor']), 6)
        self.assertEqual(len(store.video_frames['student']), 6)
        self.assertEqual(store.video_frames['tutor'][0].client_id, 'tutor_laptop')
        self.assertEqual(store.video_frames['student'][0].client_id, 'student_tablet')

        # Verify prompt block contains separate sections for both
        prompt = payload['llm_prompt_context']
        self.assertIn("TUTOR:", prompt)
        self.assertIn("STUDENT:", prompt)

        # Cleanup
        store.wipe_session()
        del manager.rooms["DUAL_FEED_TEST"]


class AICoachAndEngagementTests(TestCase):
    def setUp(self):
        self.manager = SessionManager.get_instance()
        self.client = Client()

    def test_rolling_engagement_and_coach_endpoints(self):
        room_code = "COACH_TEST"
        store = self.manager.get_or_create(room_code)
        store.active_peers.add("tutor_1")
        store.active_peers.add("student_1")

        # Add dialogue
        store.transcripts.append(TranscriptEntry(
            role="tutor",
            client_id="tutor_1",
            timestamp=1000,
            text="Today we are solving linear equations using substitution method."
        ))
        store.transcripts.append(TranscriptEntry(
            role="student",
            client_id="student_1",
            timestamp=2000,
            text="Okay, I understand the first part."
        ))

        # Add simulated student video frame features
        store.video_frame_features["student"].append({
            "timestamp_ms": 1500,
            "face_detected": True,
            "engagement_score": 0.82,
            "engagement_label": "high",
            "attention_state": "attentive_screen",
            "brow_furrow_score": 0.1,
            "smile_score": 0.2,
            "head_yaw_deg": 1.2,
            "head_pitch_deg": -2.0,
            "gaze_direction": "screen"
        })

        # 1. Test rolling engagement helper
        from core.telemetry import get_rolling_engagement
        pulse = get_rolling_engagement(store, window_seconds=15)
        self.assertEqual(pulse["engagement_score"], 82)
        self.assertEqual(pulse["status_color"], "green")
        self.assertEqual(pulse["attention_state"], "attentive")
        self.assertTrue(pulse["student_face_detected"])
        self.assertIn("pacing", pulse)

        # 2. Test GET /api/rooms/<room_code>/engagement/
        res_eng = self.client.get(reverse('session-engagement', kwargs={'room_code': room_code}))
        self.assertEqual(res_eng.status_code, 200)
        self.assertEqual(res_eng.json()["engagement_score"], 82)

        # 3. Test generate_coaching_report
        from core.telemetry import build_telemetry_payload
        from core.llm_coach import generate_coaching_report
        payload = build_telemetry_payload(store)
        report = generate_coaching_report(payload)

        self.assertIn("summary", report)
        self.assertIn("comprehension_rating", report)
        self.assertIn("pacing", report)
        self.assertIn("actionable_tips", report)

        # 4. Test GET & POST /api/rooms/<room_code>/coach/
        res_coach = self.client.post(
            reverse('session-coach', kwargs={'room_code': room_code}),
            data=json.dumps({}),
            content_type="application/json"
        )
        self.assertEqual(res_coach.status_code, 200)
        report_data = res_coach.json()
        self.assertIn("comprehension_rating", report_data)
        self.assertIn("pacing", report_data)

        # GET should retrieve cached report
        res_cached = self.client.get(reverse('session-coach', kwargs={'room_code': room_code}))
        self.assertEqual(res_cached.status_code, 200)
        self.assertEqual(res_cached.json()["summary"], report_data["summary"])

        # Cleanup
        store.wipe_session()
        del self.manager.rooms[room_code]


class AICoachAskTest(TestCase):
    def setUp(self):
        self.client = Client()
        self.manager = SessionManager.get_instance()

    def test_ai_coach_ask_inquiry(self):
        room_code = "ASKT1234"
        MeetingRoom.objects.create(room_code=room_code, title="Math Tutoring", passcode="123")
        store = self.manager.get_or_create(room_code)

        store.transcripts.append(TranscriptEntry(
            role="tutor",
            client_id="tutor_1",
            timestamp=1000,
            text="Let's solve 21 - 1 on the whiteboard."
        ))
        store.transcripts.append(TranscriptEntry(
            role="student",
            client_id="student_1",
            timestamp=2000,
            text="I wrote 16."
        ))
        store.student_whiteboard_edit_count = 2

        # POST /api/rooms/<room_code>/coach/ask/
        res = self.client.post(
            reverse('session-coach-ask', kwargs={'room_code': room_code}),
            data=json.dumps({
                "prompt": "How can I help the student with this subtraction misconception?",
                "provider": "heuristic"
            }),
            content_type="application/json"
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("response", data)
        self.assertIn("provider_used", data)
        self.assertIn("place value", data["response"].lower())

        # Cleanup
        store.wipe_session()
        if room_code in self.manager.rooms:
            del self.manager.rooms[room_code]


class WhiteboardGenerateTest(TestCase):
    def setUp(self):
        self.client = Client()
        self.manager = SessionManager.get_instance()

    def test_whiteboard_generate_endpoint(self):
        room_code = "GENW1234"
        MeetingRoom.objects.create(room_code=room_code, title="Math Tutoring", passcode="123")
        store = self.manager.get_or_create(room_code)

        # Simulate existing tutor work and active elements on whiteboard
        store.transcripts.append(TranscriptEntry(
            role="tutor",
            client_id="tutor_1",
            timestamp=1000,
            text="Let's practice subtraction equations."
        ))
        store.add_whiteboard_element({
            "id": "eq_1",
            "type": "text",
            "text": "21 - 1 = 16"
        })

        # POST /api/rooms/<room_code>/whiteboard/generate/
        res = self.client.post(
            reverse('whiteboard-generate', kwargs={'room_code': room_code}),
            data=json.dumps({
                "prompt": "Create 2 subtraction follow-up problems matching our work",
                "provider": "heuristic"
            }),
            content_type="application/json"
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("result", data)
        self.assertIn("elements", data["result"])
        elements = data["result"]["elements"]
        self.assertGreater(len(elements), 0)

        # Verify elements contain shapes and text without LaTeX $$ notation
        has_shape = any(el.get("type") == "shape" for el in elements)
        has_text = any(el.get("type") == "text" for el in elements)
        self.assertTrue(has_shape)
        self.assertTrue(has_text)
        for el in elements:
            if el.get("type") == "text":
                self.assertNotIn("$$", el.get("text", ""))

        # Cleanup
        store.wipe_session()
        if room_code in self.manager.rooms:
            del self.manager.rooms[room_code]

    def test_whiteboard_generate_calculus_graph(self):
        room_code = "CALC1234"
        MeetingRoom.objects.create(room_code=room_code, title="Calculus Tutoring", passcode="123")
        store = self.manager.get_or_create(room_code)

        # Prompt for 1/x graph
        res = self.client.post(
            reverse('whiteboard-generate', kwargs={'room_code': room_code}),
            data=json.dumps({
                "prompt": "We are talking about integrating 1/x. Can you plot a useful graph for this.",
                "provider": "heuristic"
            }),
            content_type="application/json"
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("result", data)
        result = data["result"]
        self.assertIn("1/x", result["title"])
        self.assertIn("elements", result)
        elements = result["elements"]
        self.assertGreater(len(elements), 10)

        # Check for axes, curve line segments, and formula text
        text_contents = " ".join(el.get("text", "") for el in elements if el.get("type") == "text")
        self.assertIn("1/x", text_contents)
        self.assertIn("Integral", text_contents)
        self.assertNotIn("$$", text_contents)

        # Cleanup
        store.wipe_session()
        if room_code in self.manager.rooms:
            del self.manager.rooms[room_code]




