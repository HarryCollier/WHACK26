import json
import logging
from channels.generic.websocket import AsyncJsonWebsocketConsumer

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
            # Notify peer of disconnection
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

    async def receive_json(self, content):
        """
        Receives messages from client.
        Supported types:
        - join: { type: 'join', role: 'tutor'|'student', clientId: '...' }
        - webrtc_signal: { type: 'webrtc_signal', signal: ... }
        - whiteboard_stroke: { type: 'whiteboard_stroke', stroke: ... }
        - whiteboard_clear: { type: 'whiteboard_clear' }
        - whiteboard_snapshot: { type: 'whiteboard_snapshot', timestamp, dataUrl } (Ingestion stream)
        - audio_chunk: { type: 'audio_chunk', role, timestamp, format, data } (Ingestion stream)
        - video_frame: { type: 'video_frame', role, timestamp, dataUrl } (Ingestion stream)
        - ping: { type: 'ping' }
        """
        msg_type = content.get("type")

        if msg_type == "ping":
            await self.send_json({"type": "pong"})
            return

        if msg_type == "join":
            self.role = content.get("role", "guest")
            self.client_id = content.get("clientId")
            logger.info(f"User joined room {self.room_code} as {self.role} (ID: {self.client_id})")
            
            # Announce user joined to everyone in the room
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

        # Handle ingestion data: Keep stream tagged for backend processing
        if msg_type in ["audio_chunk", "video_frame", "whiteboard_snapshot"]:
            # Here we preserve the feed cleanly tagged with role ('tutor'/'student'), timestamp, and stream type
            # You can pipe this directly to disk, Redis queue, or an AI worker when ready.
            # (No expensive processing is done right now as per user instruction)
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
        # Do not echo back to sender
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
