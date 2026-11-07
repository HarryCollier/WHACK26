import React, { useRef, useEffect, useState } from 'react';
import { Mic, MicOff, Video, VideoOff, Wifi, WifiOff } from 'lucide-react';

const VideoCall = ({ 
  socket, 
  roomCode, 
  role, 
  clientId, 
  onLocalMediaReady, 
  onAudioLevel 
}) => {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnection = useRef(null);
  const localStream = useRef(null);
  const audioContext = useRef(null);
  const analyser = useRef(null);
  const animationFrameId = useRef(null);

  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [peerConnected, setPeerConnected] = useState(false);
  const [audioMeter, setAudioMeter] = useState(0);

  // STUN servers configuration for resilient NAT traversal
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]
  };

  useEffect(() => {
    let isMounted = true;

    async function initMedia() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { max: 24 } },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        });

        if (!isMounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        localStream.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Setup Lightweight browser Web Audio Analyser for tone/volume meter & speech activity
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) {
            audioContext.current = new AudioCtx();
            const source = audioContext.current.createMediaStreamSource(stream);
            analyser.current = audioContext.current.createAnalyser();
            analyser.current.fftSize = 256;
            source.connect(analyser.current);

            const dataArray = new Uint8Array(analyser.current.frequencyBinCount);
            const checkVolume = () => {
              if (analyser.current) {
                analyser.current.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                  sum += dataArray[i];
                }
                const avg = sum / dataArray.length;
                const normalized = Math.min(100, Math.round((avg / 128) * 100));
                setAudioMeter(normalized);
                if (onAudioLevel) onAudioLevel(normalized);
              }
              animationFrameId.current = requestAnimationFrame(checkVolume);
            };
            checkVolume();
          }
        } catch (audioErr) {
          console.warn('AudioContext analysis not permitted or failed', audioErr);
        }

        if (onLocalMediaReady) {
          onLocalMediaReady(stream);
        }

        setupPeerConnection();
      } catch (err) {
        console.error('Camera/Mic permission denied or unavailable:', err);
      }
    }

    initMedia();

    return () => {
      isMounted = false;
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      if (audioContext.current) audioContext.current.close().catch(() => {});
      if (localStream.current) {
        localStream.current.getTracks().forEach(t => t.stop());
      }
      if (peerConnection.current) {
        peerConnection.current.close();
      }
    };
  }, []);

  const setupPeerConnection = () => {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnection.current = pc;

    // Attach local stream tracks
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        pc.addTrack(track, localStream.current);
      });
    }

    // Handle remote tracks
    pc.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
        setPeerConnected(true);
      }
    };

    // Resilient ICE Candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'webrtc_signal',
          candidate: event.candidate,
          senderRole: role,
          clientId: clientId
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setPeerConnected(true);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setPeerConnected(false);
      }
    };
  };

  // Listen for WebRTC signaling from the other peer
  useEffect(() => {
    if (!socket) return;

    const handleSignal = async (event) => {
      try {
        const data = JSON.parse(event.data);

        // When a remote peer joins, Tutor initiates offer
        if (data.type === 'presence' && data.event === 'user_joined' && role === 'tutor') {
          initiateOffer();
        }

        if (data.type === 'webrtc_signal') {
          const pc = peerConnection.current;
          if (!pc) return;

          if (data.offer) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                type: 'webrtc_signal',
                answer: answer,
                senderRole: role,
                clientId: clientId
              }));
            }
          } else if (data.answer) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          } else if (data.candidate) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (e) {
              console.warn('Error adding ICE candidate', e);
            }
          }
        }
      } catch (err) {
        console.error('Signal handling failed:', err);
      }
    };

    socket.addEventListener('message', handleSignal);
    return () => socket.removeEventListener('message', handleSignal);
  }, [socket, role, clientId]);

  const initiateOffer = async () => {
    const pc = peerConnection.current;
    if (!pc) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'webrtc_signal',
          offer: offer,
          senderRole: role,
          clientId: clientId
        }));
      }
    } catch (err) {
      console.error('Failed to create offer:', err);
    }
  };

  const toggleMic = () => {
    if (!localStream.current) return;
    const audioTrack = localStream.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setIsMicOn(audioTrack.enabled);
    }
  };

  const toggleVideo = () => {
    if (!localStream.current) return;
    const videoTrack = localStream.current.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setIsVideoOn(videoTrack.enabled);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      height: '100%',
      padding: '12px',
      backgroundColor: '#1e293b',
      borderLeft: '1px solid #334155'
    }}>
      {/* Remote Video Container */}
      <div style={{
        position: 'relative',
        flex: 1,
        borderRadius: '8px',
        overflow: 'hidden',
        backgroundColor: '#0f172a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid #334155'
      }}>
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />

        {!peerConnected && (
          <div style={{
            position: 'absolute',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '8px',
            color: '#94a3b8',
            fontSize: '13px'
          }}>
            <WifiOff size={28} />
            <span>Waiting for peer to connect...</span>
          </div>
        )}

        <div style={{
          position: 'absolute',
          bottom: '8px',
          left: '8px',
          background: 'rgba(15, 23, 42, 0.75)',
          padding: '4px 8px',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: 600,
          color: '#f8fafc',
          textTransform: 'capitalize'
        }}>
          {role === 'tutor' ? 'Student' : 'Tutor'} {peerConnected ? '(Connected)' : ''}
        </div>
      </div>

      {/* Local Video Container */}
      <div style={{
        position: 'relative',
        height: '160px',
        borderRadius: '8px',
        overflow: 'hidden',
        backgroundColor: '#0f172a',
        border: '1px solid #334155'
      }}>
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
        />

        <div style={{
          position: 'absolute',
          bottom: '8px',
          left: '8px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: 'rgba(15, 23, 42, 0.75)',
          padding: '4px 8px',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: 600,
          color: '#38bdf8'
        }}>
          <span>You ({role})</span>
          {/* Audio volume visualizer */}
          <div style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: audioMeter > 10 ? '#22c55e' : '#64748b',
            boxShadow: audioMeter > 10 ? '0 0 8px #22c55e' : 'none'
          }} />
        </div>
      </div>

      {/* Control Buttons */}
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        gap: '12px',
        padding: '8px 0'
      }}>
        <button
          onClick={toggleMic}
          style={{
            padding: '10px',
            borderRadius: '50%',
            backgroundColor: isMicOn ? '#334155' : '#ef4444',
            color: '#f8fafc',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
          {isMicOn ? <Mic size={20} /> : <MicOff size={20} />}
        </button>

        <button
          onClick={toggleVideo}
          style={{
            padding: '10px',
            borderRadius: '50%',
            backgroundColor: isVideoOn ? '#334155' : '#ef4444',
            color: '#f8fafc',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
          {isVideoOn ? <Video size={20} /> : <VideoOff size={20} />}
        </button>
      </div>
    </div>
  );
};

export default VideoCall;
