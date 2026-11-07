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
