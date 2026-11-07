from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
import logging
from .models import MeetingRoom
from .session_store import SessionManager
from .telemetry import build_telemetry_payload, get_rolling_engagement

logger = logging.getLogger(__name__)

class CreateRoomView(APIView):
    def post(self, request):
        title = request.data.get('title', 'Tutoring Session').strip()
        passcode = request.data.get('passcode', '').strip()

        if not passcode:
            return Response({'error': 'Passcode is required to protect the room.'}, status=status.HTTP_400_BAD_REQUEST)

        room_code = MeetingRoom.generate_code()
        while MeetingRoom.objects.filter(room_code=room_code).exists():
            room_code = MeetingRoom.generate_code()

        room = MeetingRoom.objects.create(
            room_code=room_code,
            title=title or 'Tutoring Session',
            passcode=passcode
        )

        return Response({
            'room_code': room.room_code,
            'title': room.title,
            'role': 'tutor',
            'created_at': room.created_at.isoformat()
        }, status=status.HTTP_201_CREATED)

class JoinRoomView(APIView):
    def post(self, request):
        room_code = request.data.get('room_code', '').strip().upper()
        passcode = request.data.get('passcode', '').strip()

        if not room_code or not passcode:
            return Response({'error': 'Room code and passcode are required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            room = MeetingRoom.objects.get(room_code=room_code, is_active=True)
        except MeetingRoom.DoesNotExist:
            return Response({'error': 'Meeting room not found or inactive.'}, status=status.HTTP_404_NOT_FOUND)

        if room.passcode != passcode:
            return Response({'error': 'Incorrect passcode for this room.'}, status=status.HTTP_403_FORBIDDEN)

        return Response({
            'room_code': room.room_code,
            'title': room.title,
            'role': 'student',
            'created_at': room.created_at.isoformat()
        }, status=status.HTTP_200_OK)

class SessionStatsView(APIView):
    """
    Diagnostic endpoint to inspect live in-memory session data for a room.
    URL: /api/rooms/<room_code>/stats/
    """
    def get(self, request, room_code):
        room_code = room_code.upper()
        manager = SessionManager.get_instance()
        if room_code not in manager.rooms:
            return Response({
                'active': False,
                'room_code': room_code,
                'message': 'No active in-memory session for this room code.'
            }, status=status.HTTP_404_NOT_FOUND)

        store = manager.rooms[room_code]
        
        # Calculate summary counts without dumping huge base64 strings
        tutor_frames_count = len(store.video_frames.get('tutor', []))
        student_frames_count = len(store.video_frames.get('student', []))
        
        last_tutor_frame = store.video_frames.get('tutor', [])[-1].timestamp if tutor_frames_count > 0 else None
        last_student_frame = store.video_frames.get('student', [])[-1].timestamp if student_frames_count > 0 else None

        return Response({
            'active': True,
            'room_code': room_code,
            'active_peers': list(store.active_peers),
            'whiteboard': {
                'has_most_recent': store.most_recent_whiteboard is not None,
                'most_recent_timestamp': store.most_recent_whiteboard.get('timestamp') if store.most_recent_whiteboard else None,
                'history_count': len(store.all_whiteboards_history)
            },
            'video_frames': {
                'tutor_count': tutor_frames_count,
                'student_count': student_frames_count,
                'last_tutor_timestamp': last_tutor_frame,
                'last_student_timestamp': last_student_frame
            },
            'transcripts': [
                {
                    'role': t.role,
                    'timestamp': t.timestamp,
                    'text': t.text
                }
                for t in store.transcripts
            ]
        }, status=status.HTTP_200_OK)


class TelemetryView(APIView):
    """
    Returns the full LLM-ready telemetry payload for a live session.
    Includes: dialogue timeline, acoustic features, video engagement, whiteboard deltas.

    URL: /api/rooms/<room_code>/telemetry/
    """
    def get(self, request, room_code):
        room_code = room_code.upper()
        manager = SessionManager.get_instance()
        if room_code not in manager.rooms:
            return Response({
                'active': False,
                'room_code': room_code,
                'message': 'No active in-memory session for this room code.'
            }, status=status.HTTP_404_NOT_FOUND)

        store = manager.rooms[room_code]
        try:
            payload = build_telemetry_payload(store)
            return Response(payload, status=status.HTTP_200_OK)
        except Exception as e:
            return Response({
                'error': str(e),
                'room_code': room_code
            }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class EngagementPulseView(APIView):
    """
    Returns the real-time (15-second rolling) engagement indicator for a live session.
    URL: /api/rooms/<room_code>/engagement/
    """
    def get(self, request, room_code):
        room_code = room_code.upper()
        manager = SessionManager.get_instance()
        if room_code not in manager.rooms:
            return Response({
                'active': False,
                'room_code': room_code,
                'message': 'No active in-memory session for this room code.'
            }, status=status.HTTP_404_NOT_FOUND)

        store = manager.rooms[room_code]
        try:
            pulse = get_rolling_engagement(store, window_seconds=15)
            return Response(pulse, status=status.HTTP_200_OK)
        except Exception as e:
            return Response({'error': str(e), 'room_code': room_code}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class AICoachView(APIView):
    """
    Returns or triggers a deep pedagogical coaching report from the LLM.
    URL: /api/rooms/<room_code>/coach/
    GET: returns latest cached coaching report (or generates one if none exists)
    POST: triggers immediate on-demand LLM coaching analysis
    """
    def get(self, request, room_code):
        room_code = room_code.upper()
        manager = SessionManager.get_instance()
        if room_code not in manager.rooms:
            return Response({
                'active': False,
                'room_code': room_code,
                'message': 'No active in-memory session for this room code.'
            }, status=status.HTTP_404_NOT_FOUND)

        store = manager.rooms[room_code]
        if store.last_coaching_report:
            return Response(store.last_coaching_report, status=status.HTTP_200_OK)

        # Generate fresh report if none cached
        return self._generate(request, store)

    def post(self, request, room_code):
        room_code = room_code.upper()
        manager = SessionManager.get_instance()
        if room_code not in manager.rooms:
            return Response({
                'active': False,
                'room_code': room_code,
                'message': 'No active in-memory session for this room code.'
            }, status=status.HTTP_404_NOT_FOUND)

        store = manager.rooms[room_code]
        return self._generate(request, store)

    def _generate(self, request, store):
        from .llm_coach import generate_coaching_report
        api_key = None
        provider = None
        if hasattr(request, 'data') and request.method == 'POST':
            api_key = request.data.get('apiKey')
            provider = request.data.get('provider')
        elif hasattr(request, 'query_params'):
            api_key = request.query_params.get('apiKey')
            provider = request.query_params.get('provider')
        elif hasattr(request, 'GET'):
            api_key = request.GET.get('apiKey')
            provider = request.GET.get('provider')

        try:
            payload = build_telemetry_payload(store)
            report = generate_coaching_report(payload, api_key=api_key, provider_override=provider)
            store.add_coaching_report(report)
            return Response(report, status=status.HTTP_200_OK)
        except Exception as e:
            logger.error(f"Error in AICoachView: {e}")
            return Response({'error': str(e), 'room_code': store.room_code}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

