import os
import json
import base64
import logging
import asyncio
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from asgiref.sync import async_to_sync
from .session_store import SessionManager

logger = logging.getLogger(__name__)

class MeetingRoomConsumer(AsyncJsonWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._eval_task = None

    def schedule_student_evaluation(self, store):
        """Debounces 2.0s after student finishes writing/drawing, then automatically runs multimodal AI analysis in background"""
        if self._eval_task and not self._eval_task.done():
            self._eval_task.cancel()
        self._eval_task = asyncio.create_task(self._debounce_and_evaluate(store))

    async def _debounce_and_evaluate(self, store):
        try:
            # Wait 1.8s of inactivity after whiteboard contribution
            await asyncio.sleep(1.8)

            if getattr(store, "_eval_in_progress", False):
                return
            store._eval_in_progress = True

            from .telemetry import build_telemetry_payload
            from .llm_coach import generate_coaching_report, generate_live_nudge

            payload = await asyncio.to_thread(build_telemetry_payload, store)
            wb_telem = payload.get("whiteboard_telemetry", {})
            # Analyze if we have a visual snapshot or whiteboard elements log
            if wb_telem.get("has_current") or len(getattr(store, "whiteboard_elements_log", [])) > 0:
                api_key = getattr(store, "llm_api_key", None)
                provider = getattr(store, "llm_provider", None)
                report = await asyncio.to_thread(generate_coaching_report, payload, api_key=api_key, provider_override=provider)
                store.add_coaching_report(report)

                # Broadcast fresh coaching report to all peers (so AI Coach panel updates automatically!)
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        "type": "room_broadcast",
                        "sender_channel": "",
                        "payload": {
                            "type": "coaching_report_updated",
                            "data": report
                        }
                    }
                )

                # Immediately evaluate whether fresh report findings warrant a live coach toast
                nudge = generate_live_nudge(store)
                if nudge:
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            "type": "room_broadcast",
                            "sender_channel": "",
                            "payload": {
                                "type": "live_coach_toast",
                                "data": nudge
                            }
                        }
                    )
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug(f"Background whiteboard evaluation error: {e}")
        finally:
            store._eval_in_progress = False
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
            # If the tutor left, broadcast session_ended to all peers in the room
            if self.role == "tutor":
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        "type": "room_broadcast",
                        "sender_channel": self.channel_name,
                        "payload": {
                            "type": "session_ended",
                            "reason": "tutor_left"
                        }
                    }
                )

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

        # Check for live pedagogical nudge
        try:
            manager = SessionManager.get_instance()
            store = manager.get_or_create(self.room_code)
            from .llm_coach import generate_live_nudge
            nudge = generate_live_nudge(store)
            if nudge:
                async_to_sync(channel_layer.group_send)(
                    self.room_group_name,
                    {
                        "type": "room_broadcast",
                        "sender_channel": "",
                        "payload": {
                            "type": "live_coach_toast",
                            "data": nudge
                        }
                    }
                )
        except Exception as e:
            logger.warning(f"Error evaluating live nudge on transcript: {e}")

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

        if msg_type == "end_session":
            # Broadcast session_ended immediately to all peers in the room
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "room_broadcast",
                    "sender_channel": self.channel_name,
                    "payload": {
                        "type": "session_ended",
                        "reason": "tutor_ended_session"
                    }
                }
            )
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

        if msg_type == "trigger_demo_nudge":
            manager = SessionManager.get_instance()
            store = manager.get_or_create(self.room_code, on_transcript=self.on_live_transcript)
            from .llm_coach import generate_live_nudge
            trigger_type = content.get("triggerType", "demo_fractions")
            nudge = generate_live_nudge(store, force_trigger=trigger_type)
            if nudge:
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        "type": "room_broadcast",
                        "sender_channel": "",
                        "payload": {
                            "type": "live_coach_toast",
                            "data": nudge
                        }
                    }
                )
            return

        if msg_type == "join":
            self.role = content.get("role", "guest")
            self.client_id = content.get("clientId")
            
            # Register in SessionManager
            manager = SessionManager.get_instance()
            store = manager.get_or_create(self.room_code, on_transcript=self.on_live_transcript)
            store.active_peers.add(self.client_id)

            api_key = content.get("apiKey")
            provider = content.get("provider")
            if api_key:
                store.llm_api_key = api_key
            if provider and provider != "auto":
                store.llm_provider = provider

            logger.info(f"User joined room {self.room_code} as {self.role} (ID: {self.client_id})")

            # Instantly synchronize any existing whiteboard drawings/elements made before this user joined!
            active_elements = list(store.active_whiteboard_elements.values())
            if active_elements:
                await self.send_json({
                    "type": "whiteboard_sync_full",
                    "elements": active_elements
                })
            
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

            # Send current whiteboard state to joining client immediately
            if store.whiteboard_elements:
                await self.send_json({
                    "type": "whiteboard_init",
                    "elements": list(store.whiteboard_elements.values())
                })
            return

        if msg_type == "request_whiteboard_sync":
            manager = SessionManager.get_instance()
            store = manager.get_or_create(self.room_code, on_transcript=self.on_live_transcript)
            await self.send_json({
                "type": "whiteboard_init",
                "elements": list(store.whiteboard_elements.values())
            })
            return

        if msg_type == "set_llm_config":
            manager = SessionManager.get_instance()
            store = manager.get_or_create(self.room_code, on_transcript=self.on_live_transcript)
            api_key = content.get("apiKey")
            provider = content.get("provider")
            if api_key:
                store.llm_api_key = api_key
            if provider and provider != "auto":
                store.llm_provider = provider
            logger.info(f"Updated LLM credentials for room {self.room_code}: provider={store.llm_provider}")
            return

        if msg_type == "request_whiteboard_sync":
            manager = SessionManager.get_instance()
            store = manager.get_or_create(self.room_code, on_transcript=self.on_live_transcript)
            active_elements = list(store.active_whiteboard_elements.values())
            await self.send_json({
                "type": "whiteboard_sync_full",
                "elements": active_elements
            })
            return

        manager = SessionManager.get_instance()
        store = manager.get_or_create(self.room_code, on_transcript=self.on_live_transcript)

        # 1. Whiteboard Snapshot Processing:
        # "store the most recent whiteboard data and all previous whiteboard data as two separate stores.
        # Once new whiteboard data is transferred add the old most recent whiteboard data to all whiteboard data store."
        if msg_type == "whiteboard_snapshot":
            data_url = content.get("dataUrl", "")
            timestamp = content.get("timestamp", 0)
            role = content.get("role") or self.role or "unknown"
            has_changed = store.update_whiteboard(data_url, timestamp, role)
            if has_changed:
                self.schedule_student_evaluation(store)
            return

        if msg_type == "whiteboard_sync":
            elements = content.get("elements", [])
            for el in elements:
                store.add_whiteboard_element(el)
            # Fall-through to broadcast to other peers in room

        if msg_type == "whiteboard_element":
            element = content.get("element", {})
            role = content.get("role") or element.get("role") or self.role or "unknown"
            client_id = content.get("clientId") or element.get("clientId") or self.client_id or "unknown"
            store.record_whiteboard_element(element, role, client_id, action="create")
            store.add_whiteboard_element(element)
            try:
                from .llm_coach import generate_live_nudge
                wb_nudge = generate_live_nudge(store)
                if wb_nudge:
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            "type": "room_broadcast",
                            "sender_channel": "",
                            "payload": {
                                "type": "live_coach_toast",
                                "data": wb_nudge
                            }
                        }
                    )
            except Exception as wb_err:
                logger.debug(f"Whiteboard nudge check error: {wb_err}")

            # Automatically trigger background multimodal AI analysis after drawing pause
            self.schedule_student_evaluation(store)
            # Fall-through to broadcast element to other peers in room

        if msg_type == "whiteboard_stroke":
            stroke = content.get("stroke", {})
            role = content.get("role") or stroke.get("role") or self.role or "unknown"
            client_id = content.get("clientId") or stroke.get("clientId") or self.client_id or "unknown"
            store.record_whiteboard_element(stroke, role, client_id, action="create")
            try:
                from .llm_coach import generate_live_nudge
                wb_nudge = generate_live_nudge(store)
                if wb_nudge:
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            "type": "room_broadcast",
                            "sender_channel": "",
                            "payload": {
                                "type": "live_coach_toast",
                                "data": wb_nudge
                            }
                        }
                    )
            except Exception as wb_err:
                logger.debug(f"Whiteboard stroke nudge check error: {wb_err}")

            self.schedule_student_evaluation(store)
            # Fall-through to broadcast stroke to other peers in room

        if msg_type == "whiteboard_delete_element":
            element_id = content.get("elementId")
            role = content.get("role") or self.role or "unknown"
            client_id = content.get("clientId") or self.client_id or "unknown"
            store.record_whiteboard_element(content, role, client_id, action="delete")
            if element_id:
                store.remove_whiteboard_element(element_id)
            self.schedule_student_evaluation(store)
            # Fall-through to broadcast to other peers in room

        if msg_type == "whiteboard_delete_elements":
            element_ids = content.get("elementIds", [])
            role = content.get("role") or self.role or "unknown"
            client_id = content.get("clientId") or self.client_id or "unknown"
            store.record_whiteboard_element(content, role, client_id, action="delete")
            store.remove_whiteboard_elements(element_ids)
            self.schedule_student_evaluation(store)
            # Fall-through to broadcast to other peers in room

        if msg_type == "whiteboard_clear":
            role = content.get("role") or self.role or "unknown"
            client_id = content.get("clientId") or self.client_id or "unknown"
            store.record_whiteboard_element({}, role, client_id, action="clear")
            store.clear_whiteboard_elements()
            self.schedule_student_evaluation(store)
            # Fall-through to broadcast to other peers in room

        # 2. Frequent timestamped Video snapshots (every 0.5s)
        # Labelled separately by role (tutor/student)
        if msg_type == "video_frame":
            data_url = content.get("dataUrl", "")
            timestamp = content.get("timestamp", 0)
            role = content.get("role", self.role or "unknown")
            client_id = content.get("clientId", self.client_id or "unknown")
            store.add_video_frame(role, client_id, timestamp, data_url)

            # Whenever video is processed, push real-time engagement pulse to room
            if role in ("student", "tutor"):
                from .telemetry import get_rolling_engagement
                pulse = get_rolling_engagement(store)
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        "type": "room_broadcast",
                        "sender_channel": "",
                        "payload": {
                            "type": "engagement_pulse",
                            "data": pulse
                        }
                    }
                )

                # Check for live coach alerts triggered by video (rolling confusion while tutor is writing/explaining, looking away)
                try:
                    from .llm_coach import generate_live_nudge
                    video_nudge = generate_live_nudge(store)
                    if video_nudge:
                        await self.channel_layer.group_send(
                            self.room_group_name,
                            {
                                "type": "room_broadcast",
                                "sender_channel": "",
                                "payload": {
                                    "type": "live_coach_toast",
                                    "data": video_nudge
                                }
                            }
                        )
                except Exception as vn_err:
                    logger.debug(f"Video live nudge check error: {vn_err}")
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
