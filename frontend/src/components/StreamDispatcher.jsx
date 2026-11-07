import React, { useEffect, useRef } from 'react';
import { STREAM_CONFIG } from '../config/streamConfig';

/**
 * StreamDispatcher handles timestamped streams at configurable sample rates:
 * - Video snapshots: every 0.5s (STREAM_CONFIG.VIDEO_SNAPSHOT_INTERVAL_MS)
 * - Whiteboard snapshots: every X sec (STREAM_CONFIG.WHITEBOARD_SNAPSHOT_INTERVAL_MS)
 * - Audio chunks: every 3s (STREAM_CONFIG.AUDIO_CHUNK_INTERVAL_MS)
 * 
 * All items are labelled by role and timestamped.
 */
const StreamDispatcher = ({ 
  socket, 
  role, 
  clientId, 
  whiteboardRef, 
  localStream,
  config = STREAM_CONFIG
}) => {
  const audioRecorderRef = useRef(null);
  const hiddenCanvasRef = useRef(null);
  const hiddenVideoRef = useRef(null);

  // 1. Audio MediaRecorder: Slices audio into timestamped chunks for live transcription
  useEffect(() => {
    if (!localStream || !socket) return;

    try {
      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length === 0) return;

      const audioOnlyStream = new MediaStream(audioTracks);
      // MediaRecorder options with fallbacks
      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
        mimeType = 'audio/ogg;codecs=opus';
      }

      let audioChunks = [];
      const audioRecorder = new MediaRecorder(audioOnlyStream, { mimeType });
      audioRecorderRef.current = audioRecorder;

      audioRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      // Interval to cycle recorder so full headers are produced for each chunk
      const sliceInterval = setInterval(() => {
        if (audioRecorder.state === 'recording') {
          audioRecorder.stop();
        }
      }, config.AUDIO_CHUNK_INTERVAL_MS);

      audioRecorder.onstop = () => {
        // Only send if someone was speaking or audio has sufficient volume
        if (audioChunks.length > 0 && socket.readyState === WebSocket.OPEN) {
          const blob = new Blob(audioChunks, { type: mimeType });
          audioChunks = [];

          // Don't waste CPU or trigger Whisper hallucinations on tiny empty buffers
          if (blob.size > 2000) {
            const chunkTimestamp = Date.now();
            const reader = new FileReader();
            reader.onloadend = () => {
              socket.send(JSON.stringify({
                type: 'audio_chunk',
                role,
                clientId,
                timestamp: chunkTimestamp,
                format: mimeType,
                data: reader.result
              }));
            };
            reader.readAsDataURL(blob);
          }
        }

        // Restart recording next slice if stream is still active
        if (localStream.active && audioRecorder.state === 'inactive') {
          try {
            audioRecorder.start();
          } catch (e) {}
        }
      };

      audioRecorder.start();

      return () => {
        clearInterval(sliceInterval);
        if (audioRecorder.state !== 'inactive') {
          try { audioRecorder.stop(); } catch (e) {}
        }
      };
    } catch (err) {
      console.warn('Audio chunk recording failed:', err);
    }
  }, [localStream, socket, role, clientId, config.AUDIO_CHUNK_INTERVAL_MS]);

  // 2. High-frequency Video Snapshots: Captured every 0.5s (500ms)
  useEffect(() => {
    if (!socket || !localStream) return;

    const hiddenVideo = document.createElement('video');
    hiddenVideo.muted = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.autoplay = true;
    hiddenVideoRef.current = hiddenVideo;
    hiddenVideo.srcObject = localStream;
    hiddenVideo.play().catch(() => {});

    const hiddenCanvas = document.createElement('canvas');
    hiddenCanvas.width = config.VIDEO_WIDTH;
    hiddenCanvas.height = config.VIDEO_HEIGHT;
    hiddenCanvasRef.current = hiddenCanvas;

    const videoInterval = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (hiddenVideo && hiddenVideo.readyState >= 2) {
        const ctx = hiddenCanvas.getContext('2d');
        ctx.drawImage(hiddenVideo, 0, 0, hiddenCanvas.width, hiddenCanvas.height);
        const videoDataUrl = hiddenCanvas.toDataURL('image/jpeg', config.VIDEO_QUALITY);

        socket.send(JSON.stringify({
          type: 'video_frame',
          role,
          clientId,
          timestamp: Date.now(),
          dataUrl: videoDataUrl
        }));
      }
    }, config.VIDEO_SNAPSHOT_INTERVAL_MS);

    return () => {
      clearInterval(videoInterval);
      if (hiddenVideo) hiddenVideo.srcObject = null;
    };
  }, [socket, localStream, role, clientId, config.VIDEO_SNAPSHOT_INTERVAL_MS, config.VIDEO_WIDTH, config.VIDEO_HEIGHT, config.VIDEO_QUALITY]);

  // 3. Whiteboard Snapshots: Captured every X seconds
  useEffect(() => {
    if (!socket) return;

    const wbInterval = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (whiteboardRef?.current?.getSnapshot) {
        const wbDataUrl = whiteboardRef.current.getSnapshot();
        if (wbDataUrl) {
          socket.send(JSON.stringify({
            type: 'whiteboard_snapshot',
            role,
            clientId,
            timestamp: Date.now(),
            dataUrl: wbDataUrl
          }));
        }
      }
    }, config.WHITEBOARD_SNAPSHOT_INTERVAL_MS);

    return () => {
      clearInterval(wbInterval);
    };
  }, [socket, whiteboardRef, role, clientId, config.WHITEBOARD_SNAPSHOT_INTERVAL_MS]);

  return null;
};

export default StreamDispatcher;
