import os
import json
import base64
import logging
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from asgiref.sync import async_to_sync
from .session_store import SessionManager

logger = logging.getLogger(__name__)

class MeetingRoomConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.room_code = self.scope["url_route"]["kwargs"]["room_code"]
        self.room_group_name = f"meeting_{self.room_code}"
        self.role = None
        self.client_id = None

        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.accept()

    async def disconnect(self, close_code):
        if hasattr(self, 'room_group_name'):
            await self.channel_layer.group_discard(
                self.room_group_name,
                self.channel_name
            )

            # Inform peers of departure
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "room_event",
                    "event": "user_left",
                    "sender_channel": self.channel_name,
                    "sender_role": self.role,
                    "client_id": self.client_id
                }
            )

            # If this peer was registered, check if everyone has left to wipe the session
            if self.client_id:
                manager = SessionManager.get_instance()
                manager.remove_peer_and_cleanup(self.room_code, self.client_id)

    def on_live_transcript(self, transcript_entry):
        """Callback from Whisper background worker to broadcast transcript in real time"""
        channel_layer = self.channel_layer
        async_to_sync(channel_layer.group_send)(
            self.room_group_name,
            {
                "type": "room_broadcast",
                "sender_channel": "",
                "payload": {
                    "type": "live_transcript",
                    "role": transcript_entry.role,
                    "clientId": transcript_entry.client_id,
                    "timestamp": transcript_entry.timestamp,
                    "text": transcript_entry.text
                }
            }
        )

    async def receive_json(self, content):
        """
        Receives messages from client.
        Supported types:
        - join: { type: 'join', role: 'tutor'|'student', clientId: '...' }
        - webrtc_signal: { type: 'webrtc_signal', ... }
        - whiteboard_stroke: { type: 'whiteboard_stroke', stroke: ... }
        - whiteboard_clear: { type: 'whiteboard_clear' }
        - whiteboard_snapshot: { type: 'whiteboard_snapshot', timestamp, dataUrl }
        - audio_chunk: { type: 'audio_chunk', role, timestamp, format, data }
        - video_frame: { type: 'video_frame', role, timestamp, dataUrl }
        - ping: { type: 'ping' }
        """
        msg_type = content.get("type")

        if msg_type == "ping":
            await self.send_json({"type": "pong"})
            return

        if msg_type == "request_engagement_pulse":
            manager = SessionManager.get_instance()
            store = manager.get_or_create(self.room_code, on_transcript=self.on_live_transcript)
            from .telemetry import get_rolling_engagement
            pulse = get_rolling_engagement(store)
            await self.send_json({
                "type": "engagement_pulse",
                "data": pulse
            })
            return

        if msg_type == "request_coaching_report":
            manager = SessionManager.get_instance()
            store = manager.get_or_create(self.room_code, on_transcript=self.on_live_transcript)
            from .telemetry import build_telemetry_payload
            from .llm_coach import generate_coaching_report
            api_key = content.get("apiKey")
            provider = content.get("provider")
            payload = build_telemetry_payload(store)
            report = generate_coaching_report(payload, api_key=api_key, provider_override=provider)
            store.add_coaching_report(report)
            await self.send_json({
                "type": "coaching_report",
                "data": report
            })
            return

        if msg_type == "join":
            self.role = content.get("role", "guest")
            self.client_id = content.get("clientId")
            
            # Register in SessionManager
            manager = SessionManager.get_instance()
            store = manager.get_or_create(self.room_code, on_transcript=self.on_live_transcript)
            store.active_peers.add(self.client_id)

            logger.info(f"User joined room {self.room_code} as {self.role} (ID: {self.client_id})")
            
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "room_event",
                    "event": "user_joined",
                    "sender_channel": self.channel_name,
                    "sender_role": self.role,
                    "client_id": self.client_id
                }
            )
            return

        manager = SessionManager.get_instance()
        store = manager.get_or_create(self.room_code, on_transcript=self.on_live_transcript)

        # 1. Whiteboard Snapshot Processing:
        # "store the most recent whiteboard data and all previous whiteboard data as two separate stores.
        # Once new whiteboard data is transferred add the old most recent whiteboard data to all whiteboard data store."
        if msg_type == "whiteboard_snapshot":
            data_url = content.get("dataUrl", "")
            timestamp = content.get("timestamp", 0)
            role = content.get("role", self.role or "unknown")
            store.update_whiteboard(data_url, timestamp, role)
            return

        # 2. Frequent timestamped Video snapshots (every 0.5s)
        # Labelled separately by role (tutor/student)
        if msg_type == "video_frame":
            data_url = content.get("dataUrl", "")
            timestamp = content.get("timestamp", 0)
            role = content.get("role", self.role or "unknown")
            client_id = content.get("clientId", self.client_id or "unknown")
            store.add_video_frame(role, client_id, timestamp, data_url)
            return

        # 3. Audio chunk processing: Live transcription queued for Whisper
        if msg_type == "audio_chunk":
            data_str = content.get("data", "")
            timestamp = content.get("timestamp", 0)
            role = content.get("role", self.role or "unknown")
            client_id = content.get("clientId", self.client_id or "unknown")

            if "," in data_str:
                _, b64data = data_str.split(",", 1)
            else:
                b64data = data_str
            if b64data:
                store.add_audio_chunk(role, client_id, timestamp, b64data)
            return

        # Broadcast signaling and whiteboard strokes to other peers in room
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "room_broadcast",
                "sender_channel": self.channel_name,
                "payload": content
            }
        )

    async def room_broadcast(self, event):
        if event["sender_channel"] != self.channel_name:
            await self.send_json(event["payload"])

    async def room_event(self, event):
        if event["sender_channel"] != self.channel_name:
            await self.send_json({
                "type": "presence",
                "event": event["event"],
                "role": event["sender_role"],
                "clientId": event["client_id"]
            })
