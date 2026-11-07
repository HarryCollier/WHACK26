from django.db import models
from django.utils import timezone
import secrets

class MeetingRoom(models.Model):
    room_code = models.CharField(max_length=32, unique=True, db_index=True)
    title = models.CharField(max_length=120, default="Tutoring Session")
    passcode = models.CharField(max_length=64)
    created_at = models.DateTimeField(default=timezone.now)
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return f"Room {self.room_code} - {self.title}"

    @classmethod
    def generate_code(cls):
        return secrets.token_hex(4).upper()
