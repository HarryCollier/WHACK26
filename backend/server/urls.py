from django.contrib import admin
from django.urls import path
from core.views import CreateRoomView, JoinRoomView

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/rooms/create/', CreateRoomView.as_view(), name='room-create'),
    path('api/rooms/join/', JoinRoomView.as_view(), name='room-join'),
]
