from django.contrib import admin
from django.urls import path
from core.views import (
    CreateRoomView, 
    JoinRoomView, 
    SessionStatsView, 
    TelemetryView, 
    EngagementPulseView, 
    AICoachView,
    AICoachAskView,
    WhiteboardGenerateView
)

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/rooms/create/', CreateRoomView.as_view(), name='room-create'),
    path('api/rooms/join/', JoinRoomView.as_view(), name='room-join'),
    path('api/rooms/<str:room_code>/stats/', SessionStatsView.as_view(), name='session-stats'),
    path('api/rooms/<str:room_code>/telemetry/', TelemetryView.as_view(), name='session-telemetry'),
    path('api/rooms/<str:room_code>/engagement/', EngagementPulseView.as_view(), name='session-engagement'),
    path('api/rooms/<str:room_code>/coach/', AICoachView.as_view(), name='session-coach'),
    path('api/rooms/<str:room_code>/coach/ask/', AICoachAskView.as_view(), name='session-coach-ask'),
    path('api/rooms/<str:room_code>/whiteboard/generate/', WhiteboardGenerateView.as_view(), name='whiteboard-generate'),
]
