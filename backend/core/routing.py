from django.urls import re_path
from . import consumers

websocket_urlpatterns = [
    re_path(r"ws/meeting/(?P<room_code>[A-Za-z0-9_-]+)/$", consumers.MeetingRoomConsumer.as_asgi()),
]
