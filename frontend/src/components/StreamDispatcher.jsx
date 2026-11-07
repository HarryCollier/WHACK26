import React, { useEffect, useRef } from 'react';

/**
 * StreamDispatcher runs seamlessly in the background.
 * It periodically captures:
 * 1. Whiteboard canvas snapshots (base64 image)
 * 2. Video camera frames (base64 image)
 * 3. Audio slices (MediaRecorder webm/ogg audio chunks)
 * 
 * Every payload is cleanly tagged with { role, clientId, timestamp, type }
 * so your backend knows exactly who spoke or drew what, without complex diarization.
 */
const StreamDispatcher = ({ 
  socket, 
  role, 
  clientId, 
  whiteboardRef, 
  localStream,
  snapshotIntervalMs = 5000, // 5s snapshot interval to avoid overwhelming connection
  audioChunkIntervalMs = 4000 // 4s audio slice interval
}) => {
  const mediaRecorderRef = useRef(null);
  const hiddenCanvasRef = useRef(null);
  const hiddenVideoRef = useRef(null);

  // Initialize Audio Slicing via MediaRecorder
  useEffect(() => {
    if (!localStream || !socket) return;

    try {
      // Create an audio-only stream from the user's mic
      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length === 0) return;

      const audioOnlyStream = new MediaStream(audioTracks);
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') 
        ? 'audio/webm' 
        : 'audio/ogg';

      const recorder = new MediaRecorder(audioOnlyStream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0 && socket.readyState === WebSocket.OPEN) {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64Audio = reader.result;
            socket.send(JSON.stringify({
              type: 'audio_chunk',
              role,
              clientId,
              timestamp: Date.now(),
              format: mimeType,
              data: base64Audio
            }));
          };
          reader.readAsDataURL(e.data);
        }
      };

      recorder.start(audioChunkIntervalMs);
    } catch (err) {
      console.warn('Audio chunk recording failed:', err);
    }

    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch (e) {}
      }
    };
  }, [localStream, socket, role, clientId, audioChunkIntervalMs]);

  // Periodic Snapshot Dispatches (Whiteboard & Video Frame)
  useEffect(() => {
    if (!socket) return;

    // Create offscreen video element to sample local camera frames
    const hiddenVideo = document.createElement('video');
    hiddenVideo.muted = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.autoplay = true;
    hiddenVideoRef.current = hiddenVideo;

    if (localStream) {
      hiddenVideo.srcObject = localStream;
      hiddenVideo.play().catch(() => {});
    }

    const hiddenCanvas = document.createElement('canvas');
    hiddenCanvas.width = 320;
    hiddenCanvas.height = 240;
    hiddenCanvasRef.current = hiddenCanvas;

    const intervalId = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();

      // 1. Whiteboard snapshot
      if (whiteboardRef?.current?.getSnapshot) {
        const wbDataUrl = whiteboardRef.current.getSnapshot();
        if (wbDataUrl) {
          socket.send(JSON.stringify({
            type: 'whiteboard_snapshot',
            role,
            clientId,
            timestamp: now,
            dataUrl: wbDataUrl
          }));
        }
      }

      // 2. Video frame snapshot
      if (hiddenVideo && hiddenVideo.readyState >= 2) {
        const ctx = hiddenCanvas.getContext('2d');
        ctx.drawImage(hiddenVideo, 0, 0, hiddenCanvas.width, hiddenCanvas.height);
        const videoDataUrl = hiddenCanvas.toDataURL('image/jpeg', 0.6);
        socket.send(JSON.stringify({
          type: 'video_frame',
          role,
          clientId,
          timestamp: now,
          dataUrl: videoDataUrl
        }));
      }
    }, snapshotIntervalMs);

    return () => {
      clearInterval(intervalId);
      if (hiddenVideo) {
        hiddenVideo.srcObject = null;
      }
    };
  }, [socket, whiteboardRef, localStream, role, clientId, snapshotIntervalMs]);

  return null;
};

export default StreamDispatcher;
