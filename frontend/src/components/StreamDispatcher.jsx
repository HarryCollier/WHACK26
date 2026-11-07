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

      // Web Audio API VAD (Voice Activity Detection)
      let audioCtx = null;
      let analyser = null;
      let vadDataArray = null;
      let speechActiveInWindow = false;
      let vadAnimId = null;

      try {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        if (AudioCtxClass) {
          audioCtx = new AudioCtxClass();
          const source = audioCtx.createMediaStreamSource(localStream);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.2;
          source.connect(analyser);
          vadDataArray = new Uint8Array(analyser.frequencyBinCount);

          const monitorAudioEnergy = () => {
            if (analyser && vadDataArray) {
              analyser.getByteFrequencyData(vadDataArray);
              let sum = 0;
              for (let i = 0; i < vadDataArray.length; i++) {
                sum += vadDataArray[i];
              }
              const avg = sum / vadDataArray.length;
              // If volume passes threshold (~10%), mark that speech occurred in this interval
              if (avg > 12) {
                speechActiveInWindow = true;
              }
            }
            vadAnimId = requestAnimationFrame(monitorAudioEnergy);
          };
          monitorAudioEnergy();
        }
      } catch (vadErr) {
        console.warn('VAD AudioContext initialization skipped', vadErr);
      }

      const audioOnlyStream = new MediaStream(audioTracks);
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        if (MediaRecorder.isTypeSupported('audio/webm')) {
          mimeType = 'audio/webm';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
          mimeType = 'audio/ogg;codecs=opus';
        }
      }

      let audioChunks = [];
      const audioRecorder = new MediaRecorder(audioOnlyStream, { 
        mimeType: mimeType || undefined,
        audioBitsPerSecond: 128000
      });
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
        const hadSpeech = speechActiveInWindow;
        speechActiveInWindow = false; // Reset for next window

        // ONLY send if voice energy was actually detected during this window!
        // This stops sending silence/room hum to Whisper which triggers repetition hallucinations
        if (hadSpeech && audioChunks.length > 0 && socket.readyState === WebSocket.OPEN) {
          const blob = new Blob(audioChunks, { type: mimeType });
          audioChunks = [];

          if (blob.size > 3000) {
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
        } else {
          // Discard empty/silent chunks
          audioChunks = [];
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
        if (vadAnimId) cancelAnimationFrame(vadAnimId);
        if (audioCtx) audioCtx.close().catch(() => {});
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
