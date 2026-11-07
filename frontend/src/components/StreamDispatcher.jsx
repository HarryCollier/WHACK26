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
  const videoElemRef = useRef(null);
  const imageCaptureRef = useRef(null);

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

      const sliceInterval = setInterval(() => {
        if (audioRecorder.state === 'recording') {
          audioRecorder.stop();
        }
      }, config.AUDIO_CHUNK_INTERVAL_MS);

      audioRecorder.onstop = () => {
        if (audioChunks.length > 0 && socket.readyState === WebSocket.OPEN) {
          const blob = new Blob(audioChunks, { type: mimeType });
          audioChunks = [];

          if (blob.size > 400) {
            const chunkTimestamp = Date.now();
            const reader = new FileReader();
            reader.onloadend = () => {
              try {
                socket.send(JSON.stringify({
                  type: 'audio_chunk',
                  role,
                  clientId,
                  timestamp: chunkTimestamp,
                  format: mimeType,
                  data: reader.result
                }));
                console.log(`[StreamDispatcher] Sent audio chunk (${blob.size} bytes) for ${role}`);
              } catch (err) {
                console.warn('[StreamDispatcher] Failed to send audio chunk', err);
              }
            };
            reader.readAsDataURL(blob);
          }
        } else {
          audioChunks = [];
        }

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
  // Uses direct video element rendering with fallback to document video elements and ImageCapture
  useEffect(() => {
    if (!socket || !localStream) return;

    // Attach stream to the mounted DOM video element
    const video = videoElemRef.current;
    if (video) {
      video.srcObject = localStream;
      video.onloadedmetadata = () => {
        video.play().catch(() => {});
      };
      video.play().catch(() => {});
    }

    // Try initializing hardware ImageCapture if supported by browser
    try {
      const videoTracks = localStream.getVideoTracks();
      if (videoTracks.length > 0 && window.ImageCapture) {
        imageCaptureRef.current = new window.ImageCapture(videoTracks[0]);
      } else {
        imageCaptureRef.current = null;
      }
    } catch (e) {
      imageCaptureRef.current = null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = config.VIDEO_WIDTH;
    canvas.height = config.VIDEO_HEIGHT;
    hiddenCanvasRef.current = canvas;

    let isCapturing = false;
    let frameCount = 0;

    const captureAndSendFrame = async () => {
      if (isCapturing || socket.readyState !== WebSocket.OPEN) return;
      isCapturing = true;

      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        let drawn = false;

        // Strategy A: Directly draw from local video element (fast, hardware accelerated)
        if (video && (video.readyState >= 2 || video.currentTime > 0) && video.videoWidth > 0) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          drawn = true;
        }

        // Strategy B: Fallback to any active playing video in DOM (e.g. VideoCall preview)
        if (!drawn) {
          const domVideos = document.querySelectorAll('video');
          for (const v of domVideos) {
            if (v.readyState >= 2 && v.videoWidth > 0 && !v.paused) {
              ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
              drawn = true;
              break;
            }
          }
        }

        // Strategy C: Hardware ImageCapture API if available
        if (!drawn && imageCaptureRef.current) {
          try {
            const bitmap = await imageCaptureRef.current.grabFrame();
            if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
              ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
              drawn = true;
              if (bitmap.close) bitmap.close();
            }
          } catch (icErr) {}
        }

        if (!drawn) {
          isCapturing = false;
          return;
        }

        const videoDataUrl = canvas.toDataURL('image/jpeg', config.VIDEO_QUALITY);
        frameCount += 1;

        socket.send(JSON.stringify({
          type: 'video_frame',
          role,
          clientId,
          timestamp: Date.now(),
          dataUrl: videoDataUrl
        }));

        if (frameCount % 10 === 1) {
          console.log(`[StreamDispatcher] Sent video frame #${frameCount} for ${role}`);
        }
      } catch (frameErr) {
        console.warn('Frame capture error:', frameErr);
      } finally {
        isCapturing = false;
      }
    };

    const videoInterval = setInterval(captureAndSendFrame, config.VIDEO_SNAPSHOT_INTERVAL_MS);

    return () => {
      clearInterval(videoInterval);
      if (video) video.srcObject = null;
      imageCaptureRef.current = null;
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

  // Hidden video element mounted directly into the real DOM tree
  return (
    <video
      ref={videoElemRef}
      autoPlay
      playsInline
      muted
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: `${config.VIDEO_WIDTH}px`,
        height: `${config.VIDEO_HEIGHT}px`,
        opacity: 0.001,
        pointerEvents: 'none',
        zIndex: -9999
      }}
    />
  );
};

export default StreamDispatcher;
