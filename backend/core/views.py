from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from .models import MeetingRoom

class CreateRoomView(APIView):
    def post(self, request):
        title = request.data.get('title', 'Tutoring Session').strip()
        passcode = request.data.get('passcode', '').strip()

        if not passcode:
            return Response({'error': 'Passcode is required to protect the room.'}, status=status.HTTP_400_BAD_REQUEST)

        # Generate unique room code
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
