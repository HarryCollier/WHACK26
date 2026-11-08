import React, { useRef, useEffect, useState } from 'react';
import { Mic, MicOff, Video, VideoOff, WifiOff, RefreshCw, Settings, Users, ChevronDown } from 'lucide-react';

const VideoCall = ({ 
  socket, 
  roomCode, 
  role, 
  clientId, 
  onLocalMediaReady, 
  onAudioLevel,
  pipMode = true
}) => {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnection = useRef(null);
  const localStream = useRef(null);
  const audioContext = useRef(null);
  const analyser = useRef(null);
  const audioSourceNode = useRef(null);
  const animationFrameId = useRef(null);
  const iceCandidateQueue = useRef([]);

  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [peerConnected, setPeerConnected] = useState(false);
  const [audioMeter, setAudioMeter] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [peerSpeaking, setPeerSpeaking] = useState(false);
  const [micDeviceName, setMicDeviceName] = useState('Default Microphone');
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState('');
  const [showDeviceSelector, setShowDeviceSelector] = useState(false);
  const [isReconnectingVideo, setIsReconnectingVideo] = useState(false);

  // Watchdog references for frozen video detection
  const lastRemoteTimeRef = useRef(0);
  const stalledCounterRef = useRef(0);
  const lastRecoveryTimeRef = useRef(0);

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ]
  };

  useEffect(() => {
    let isMounted = true;

    const refreshDevices = async () => {
      if (navigator.mediaDevices?.enumerateDevices) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioInputs = devices.filter(d => d.kind === 'audioinput');
          if (isMounted) setAudioDevices(audioInputs);
        } catch (e) {}
      }
    };

    async function initMedia() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { max: 24 } },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            channelCount: 1
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

        // Detect and display active microphone hardware/device label
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          const track = audioTracks[0];
          if (track.label) setMicDeviceName(track.label);
          const settings = track.getSettings ? track.getSettings() : {};
          if (settings.deviceId) setSelectedAudioDeviceId(settings.deviceId);
        }

        await refreshDevices();
        navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);

        // Web Audio API speech activity analysis
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) {
            audioContext.current = new AudioCtx();
            const source = audioContext.current.createMediaStreamSource(stream);
            audioSourceNode.current = source;
            analyser.current = audioContext.current.createAnalyser();
            analyser.current.fftSize = 256;
            analyser.current.smoothingTimeConstant = 0.4;
            source.connect(analyser.current);

            const dataArray = new Uint8Array(analyser.current.frequencyBinCount);
            let lastSpeechBroadcast = 0;

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
                
                const speakingNow = normalized > 12;
                setIsSpeaking(speakingNow);

                // Broadcast speaking activity state to peer
                const now = Date.now();
                if (socket && socket.readyState === WebSocket.OPEN && now - lastSpeechBroadcast > 300) {
                  socket.send(JSON.stringify({
                    type: 'speech_activity',
                    isSpeaking: speakingNow,
                    role,
                    clientId
                  }));
                  lastSpeechBroadcast = now;
                }

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

        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'webrtc_peer_ready',
            senderRole: role,
            clientId: clientId
          }));
        }
        if (role === 'tutor') {
          setTimeout(() => initiateOffer(), 600);
        }
      } catch (err) {
        console.error('Camera/Mic permission denied or unavailable:', err);
      }
    }

    initMedia();

    return () => {
      isMounted = false;
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      if (audioSourceNode.current) {
        try { audioSourceNode.current.disconnect(); } catch (e) {}
      }
      if (audioContext.current) audioContext.current.close().catch(() => {});
      if (localStream.current) {
        localStream.current.getTracks().forEach(t => t.stop());
      }
      if (peerConnection.current) {
        peerConnection.current.close();
      }
    };
  }, [socket]);

  const handleAutoRecoverVideo = (isManual = false) => {
    const now = Date.now();
    // Debounce recoveries by at least 3.5 seconds unless user manually triggered it
    if (!isManual && now - lastRecoveryTimeRef.current < 3500) {
      return;
    }
    lastRecoveryTimeRef.current = now;
    setIsReconnectingVideo(true);
    console.log('[VideoCall] Failsafe video recovery triggered (manual:', isManual, ')');

    // 1. Re-kick remote video element playback
    if (remoteVideoRef.current) {
      try {
        const stream = remoteVideoRef.current.srcObject;
        if (stream) {
          remoteVideoRef.current.play().catch(() => {});
        }
      } catch (e) {}
    }

    // 2. Perform WebRTC renegotiation with ICE restart
    if (role === 'tutor') {
      initiateOffer({ iceRestart: true });
    } else if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'webrtc_request_offer',
        iceRestart: true,
        clientId: clientId
      }));
    }

    // Auto-dismiss banner after 4.5s
    setTimeout(() => {
      setIsReconnectingVideo(false);
    }, 4500);
  };

  const setupPeerConnection = () => {
    if (peerConnection.current && peerConnection.current.signalingState !== 'closed') {
      try { peerConnection.current.close(); } catch {}
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnection.current = pc;
    iceCandidateQueue.current = [];

    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        try { pc.addTrack(track, localStream.current); } catch {}
      });
    }

    pc.ontrack = (event) => {
      console.log('[VideoCall] Remote track received:', event.track.kind);
      if (remoteVideoRef.current) {
        if (event.streams && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
        } else {
          let stream = remoteVideoRef.current.srcObject;
          if (!stream || !(stream instanceof MediaStream)) {
            stream = new MediaStream();
            remoteVideoRef.current.srcObject = stream;
          }
          stream.addTrack(event.track);
        }
        setPeerConnected(true);
        setIsReconnectingVideo(false);
        remoteVideoRef.current.play().catch(() => {});
      }

      event.track.onmute = () => {
        console.log('[VideoCall] Remote track muted:', event.track.kind);
      };
      event.track.onunmute = () => {
        console.log('[VideoCall] Remote track unmuted, resuming playback');
        remoteVideoRef.current?.play().catch(() => {});
      };
    };

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

    pc.oniceconnectionstatechange = () => {
      console.log('[VideoCall] ICE connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        setPeerConnected(true);
        setIsReconnectingVideo(false);
      } else if (pc.iceConnectionState === 'disconnected') {
        setTimeout(() => {
          if (peerConnection.current?.iceConnectionState === 'disconnected') {
            handleAutoRecoverVideo();
          }
        }, 2500);
      } else if (pc.iceConnectionState === 'failed') {
        handleAutoRecoverVideo();
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[VideoCall] Connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        setPeerConnected(true);
        setIsReconnectingVideo(false);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setPeerConnected(false);
        handleAutoRecoverVideo();
      }
    };

    return pc;
  };

  useEffect(() => {
    if (!socket) return;

    const handleSignal = async (event) => {
      try {
        const data = JSON.parse(event.data);

        // Receive remote peer's speaking state
        if (data.type === 'speech_activity' && data.clientId !== clientId) {
          setPeerSpeaking(!!data.isSpeaking);
        }

        // Peer readiness announcement
        if (data.type === 'webrtc_peer_ready' && data.clientId !== clientId) {
          console.log('[VideoCall] Remote peer ready:', data.senderRole);
          if (role === 'tutor') {
            initiateOffer();
          } else if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'webrtc_request_offer',
              clientId: clientId
            }));
          }
        }

        // Student requests offer from tutor
        if (data.type === 'webrtc_request_offer' && role === 'tutor' && data.clientId !== clientId) {
          console.log('[VideoCall] Request offer received, sending offer (iceRestart:', !!data.iceRestart, ')...');
          initiateOffer({ iceRestart: !!data.iceRestart });
        }

        // Presence change
        if (data.type === 'presence' && data.event === 'user_joined') {
          if (role === 'tutor') {
            setTimeout(() => initiateOffer(), 500);
          } else if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'webrtc_peer_ready',
              senderRole: role,
              clientId: clientId
            }));
          }
        }

        // WebRTC Signaling messages
        if (data.type === 'webrtc_signal' && data.clientId !== clientId) {
          let pc = peerConnection.current;
          if (!pc || pc.signalingState === 'closed') {
            pc = setupPeerConnection();
          }

          if (data.offer) {
            console.log('[VideoCall] Received offer, creating answer...');
            // Ensure local tracks are attached before answering
            if (localStream.current && pc.getSenders().length === 0) {
              localStream.current.getTracks().forEach(track => {
                try { pc.addTrack(track, localStream.current); } catch {}
              });
            }

            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

            // Drain queued candidates received before remoteDescription
            while (iceCandidateQueue.current.length > 0) {
              const cand = iceCandidateQueue.current.shift();
              try {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
              } catch (e) {
                console.warn('Error adding queued ICE candidate', e);
              }
            }

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
            console.log('[VideoCall] Received answer, setting remote description...');
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));

            // Drain queued candidates
            while (iceCandidateQueue.current.length > 0) {
              const cand = iceCandidateQueue.current.shift();
              try {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
              } catch (e) {
                console.warn('Error adding queued ICE candidate', e);
              }
            }
          } else if (data.candidate) {
            if (pc.remoteDescription && pc.remoteDescription.type) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
              } catch (e) {
                console.warn('Error adding ICE candidate', e);
              }
            } else {
              iceCandidateQueue.current.push(data.candidate);
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

  const initiateOffer = async (options = {}) => {
    let pc = peerConnection.current;
    if (!pc || pc.signalingState === 'closed') {
      pc = setupPeerConnection();
    }
    if (!pc) return;

    try {
      if (localStream.current && pc.getSenders().length === 0) {
        localStream.current.getTracks().forEach(track => {
          try { pc.addTrack(track, localStream.current); } catch {}
        });
      }

      console.log('[VideoCall] Initiating WebRTC offer (iceRestart:', !!options.iceRestart, ')...');
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        iceRestart: !!options.iceRestart
      });
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

  // Video Health Watchdog: Periodically monitors remote video currentTime for freezes
  useEffect(() => {
    const watchdogInterval = setInterval(() => {
      const video = remoteVideoRef.current;
      if (!video) return;

      const hasVideoTrack = video.srcObject && video.srcObject.getVideoTracks && video.srcObject.getVideoTracks().length > 0;
      if (!hasVideoTrack && !peerConnected) return;

      // Ensure playback is active if element was unexpectedly paused
      if (video.paused && video.readyState >= 2) {
        video.play().catch(() => {});
      }

      const currentSec = video.currentTime;
      // If time has stalled for > 4-5s while connected, trigger failsafe recovery
      if (currentSec > 0 && Math.abs(currentSec - lastRemoteTimeRef.current) < 0.05) {
        stalledCounterRef.current += 1;
        if (stalledCounterRef.current >= 2) {
          console.warn('[VideoCall] Watchdog detected frozen remote video playback. Triggering auto-recovery...');
          handleAutoRecoverVideo();
        }
      } else {
        lastRemoteTimeRef.current = currentSec;
        stalledCounterRef.current = 0;
        if (isReconnectingVideo) {
          setIsReconnectingVideo(false);
        }
      }
    }, 2500);

    return () => clearInterval(watchdogInterval);
  }, [peerConnected, role, socket, clientId, isReconnectingVideo]);

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

  const handleDeviceChange = async (newDeviceId) => {
    if (!newDeviceId) return;
    setSelectedAudioDeviceId(newDeviceId);

    try {
      const newAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: newDeviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1
        }
      });
      const newAudioTrack = newAudioStream.getAudioTracks()[0];
      if (!newAudioTrack) return;

      newAudioTrack.enabled = isMicOn;
      setMicDeviceName(newAudioTrack.label || 'Selected Microphone');

      // 1. Replace track in WebRTC peer connection so other peer receives AirPods audio
      if (peerConnection.current) {
        const senders = peerConnection.current.getSenders();
        const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
        if (audioSender) {
          await audioSender.replaceTrack(newAudioTrack);
        }
      }

      // 2. Stop old audio tracks in local stream and add the new one
      if (localStream.current) {
        const oldAudioTracks = localStream.current.getAudioTracks();
        oldAudioTracks.forEach(t => {
          localStream.current.removeTrack(t);
          t.stop();
        });
        localStream.current.addTrack(newAudioTrack);
      }

      // 3. Reconnect Web Audio API analyser to the new microphone
      if (audioContext.current && analyser.current) {
        try {
          if (audioSourceNode.current) {
            audioSourceNode.current.disconnect();
          }
          const singleTrackStream = new MediaStream([newAudioTrack]);
          const newSource = audioContext.current.createMediaStreamSource(singleTrackStream);
          newSource.connect(analyser.current);
          audioSourceNode.current = newSource;
        } catch (audioErr) {
          console.warn('Could not re-route AudioContext to new mic', audioErr);
        }
      }

      // 4. Notify MeetingRoom & StreamDispatcher with the updated MediaStream reference
      if (onLocalMediaReady && localStream.current) {
        const updatedStream = new MediaStream(localStream.current.getTracks());
        onLocalMediaReady(updatedStream);
      }
    } catch (err) {
      console.error('Failed to switch microphone device:', err);
    }
  };

  if (pipMode) {
    return (
      <div style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        backgroundColor: '#0f172a',
        overflow: 'hidden',
        border: peerSpeaking ? '2.5px solid #22c55e' : '1px solid rgba(51, 65, 85, 0.85)',
        boxShadow: peerSpeaking ? '0 0 18px rgba(34, 197, 94, 0.5)' : 'none',
        borderRadius: '12px',
        transition: 'all 0.15s ease-out'
      }}>
        {/* Remote Video (Fills the entire background) */}
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover'
          }}
        />

        {/* Offline / Waiting Overlay when peer is not yet connected */}
        {!peerConnected && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            backgroundColor: 'rgba(15, 23, 42, 0.88)',
            backdropFilter: 'blur(6px)',
            color: '#94a3b8',
            fontSize: '12px',
            zIndex: 5
          }}>
            <Users size={26} color="#64748b" />
            <span style={{ fontWeight: 500 }}>
              Waiting for {role === 'tutor' ? 'student' : 'tutor'}...
            </span>
            <button
              onClick={() => handleAutoRecoverVideo(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '4px 10px',
                borderRadius: '6px',
                backgroundColor: 'rgba(30, 41, 59, 0.9)',
                border: '1px solid #334155',
                color: '#cbd5e1',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                marginTop: '2px'
              }}
            >
              <RefreshCw size={11} />
              <span>Sync Video</span>
            </button>
          </div>
        )}

        {/* Reconnecting Failsafe Pill */}
        {isReconnectingVideo && (
          <div style={{
            position: 'absolute',
            bottom: '74px',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            borderRadius: '6px',
            backgroundColor: 'rgba(234, 88, 12, 0.95)',
            color: '#ffffff',
            fontSize: '11px',
            fontWeight: 600,
            zIndex: 25,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            backdropFilter: 'blur(4px)',
            pointerEvents: 'none'
          }}>
            <RefreshCw size={11} />
            <span>Unfreezing video feed...</span>
          </div>
        )}

        {/* Top Overlay Header Bar */}
        <div style={{
          position: 'absolute',
          top: '8px',
          left: '8px',
          right: '8px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          zIndex: 20,
          pointerEvents: 'none'
        }}>
          {/* Peer Tag / Voice Activity Indicator */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 9px',
            borderRadius: '12px',
            backgroundColor: peerSpeaking ? 'rgba(5, 46, 22, 0.90)' : 'rgba(15, 23, 42, 0.80)',
            border: peerSpeaking ? '1px solid #22c55e' : '1px solid rgba(255, 255, 255, 0.15)',
            color: peerSpeaking ? '#4ade80' : '#f8fafc',
            fontSize: '11px',
            fontWeight: 600,
            pointerEvents: 'auto',
            backdropFilter: 'blur(6px)',
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)'
          }}>
            <span style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              backgroundColor: peerConnected ? '#22c55e' : '#64748b',
              boxShadow: peerConnected ? '0 0 6px #22c55e' : 'none'
            }} />
            <span>{role === 'tutor' ? 'Student' : 'Tutor'}</span>
            {peerSpeaking && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px', height: '10px' }}>
                <span style={{ width: '2.5px', height: '8px', borderRadius: '1px', backgroundColor: '#22c55e' }} />
                <span style={{ width: '2.5px', height: '12px', borderRadius: '1px', backgroundColor: '#22c55e' }} />
                <span style={{ width: '2.5px', height: '6px', borderRadius: '1px', backgroundColor: '#22c55e' }} />
              </div>
            )}
          </div>

          {/* Quick Header Buttons (Sync & Settings) */}
          <div style={{ display: 'flex', gap: '5px', pointerEvents: 'auto' }}>
            <button
              onClick={() => handleAutoRecoverVideo(true)}
              title="Sync / unfreeze camera feed"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '26px',
                height: '26px',
                borderRadius: '6px',
                backgroundColor: isReconnectingVideo ? '#ea580c' : 'rgba(15, 23, 42, 0.80)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: '#cbd5e1',
                cursor: 'pointer',
                backdropFilter: 'blur(6px)'
              }}
            >
              <RefreshCw size={12} />
            </button>

            <button
              onClick={() => setShowDeviceSelector(prev => !prev)}
              title="Microphone settings"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '26px',
                height: '26px',
                borderRadius: '6px',
                backgroundColor: showDeviceSelector ? '#2563eb' : 'rgba(15, 23, 42, 0.80)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: showDeviceSelector ? '#ffffff' : '#cbd5e1',
                cursor: 'pointer',
                backdropFilter: 'blur(6px)'
              }}
            >
              <Settings size={12} />
            </button>
          </div>
        </div>

        {/* Local Video Thumbnail (Inset Bottom-Right) */}
        <div style={{
          position: 'absolute',
          bottom: '8px',
          right: '8px',
          width: '88px',
          height: '60px',
          borderRadius: '8px',
          overflow: 'hidden',
          backgroundColor: '#0f172a',
          border: isSpeaking ? '2px solid #22c55e' : '1px solid rgba(255, 255, 255, 0.25)',
          boxShadow: isSpeaking ? '0 0 12px rgba(34, 197, 94, 0.5)' : '0 4px 12px rgba(0,0,0,0.5)',
          zIndex: 15,
          transition: 'all 0.15s ease-out'
        }}>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: 'scaleX(-1)'
            }}
          />
          {/* Badge: You */}
          <div style={{
            position: 'absolute',
            bottom: '3px',
            left: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
            backgroundColor: 'rgba(0,0,0,0.7)',
            padding: '1px 5px',
            borderRadius: '4px',
            fontSize: '9px',
            fontWeight: 600,
            color: '#ffffff'
          }}>
            <span>You</span>
            {!isMicOn && <MicOff size={9} color="#f87171" />}
            {isMicOn && isSpeaking && (
              <span style={{ width: '4px', height: '4px', borderRadius: '50%', backgroundColor: '#22c55e' }} />
            )}
          </div>
        </div>

        {/* Bottom-Left Mini Audio/Video Controls Bar */}
        <div style={{
          position: 'absolute',
          bottom: '8px',
          left: '8px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          zIndex: 15
        }}>
          <button
            onClick={toggleMic}
            title={isMicOn ? 'Mute Microphone' : 'Unmute Microphone'}
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              backgroundColor: isMicOn ? 'rgba(30, 41, 59, 0.85)' : '#ef4444',
              color: '#ffffff',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              backdropFilter: 'blur(6px)',
              boxShadow: '0 2px 6px rgba(0,0,0,0.3)'
            }}
          >
            {isMicOn ? <Mic size={14} /> : <MicOff size={14} />}
          </button>

          <button
            onClick={toggleVideo}
            title={isVideoOn ? 'Turn Camera Off' : 'Turn Camera On'}
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              backgroundColor: isVideoOn ? 'rgba(30, 41, 59, 0.85)' : '#ef4444',
              color: '#ffffff',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              backdropFilter: 'blur(6px)',
              boxShadow: '0 2px 6px rgba(0,0,0,0.3)'
            }}
          >
            {isVideoOn ? <Video size={14} /> : <VideoOff size={14} />}
          </button>
        </div>

        {/* Microphone Device Popover (when toggled) */}
        {showDeviceSelector && (
          <div style={{
            position: 'absolute',
            bottom: '42px',
            left: '8px',
            right: '8px',
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            backdropFilter: 'blur(10px)',
            borderRadius: '8px',
            padding: '8px',
            border: '1px solid #334155',
            zIndex: 25,
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)'
          }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>
              Microphone Device:
            </div>
            <select
              value={selectedAudioDeviceId}
              onChange={(e) => {
                handleDeviceChange(e.target.value);
                setShowDeviceSelector(false);
              }}
              style={{
                width: '100%',
                backgroundColor: '#1e293b',
                color: '#f8fafc',
                fontSize: '11px',
                border: '1px solid #475569',
                borderRadius: '4px',
                padding: '4px',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              {audioDevices.length > 0 ? (
                audioDevices.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))
              ) : (
                <option value="">{micDeviceName || 'Default Microphone'}</option>
              )}
            </select>
          </div>
        )}
      </div>
    );
  }

  // Fallback layout (when pipMode is explicitly false)
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
        border: peerSpeaking ? '2px solid #22c55e' : '1px solid #334155',
        boxShadow: peerSpeaking ? '0 0 16px rgba(34, 197, 94, 0.45)' : 'none',
        transition: 'all 0.15s ease-out'
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

        {/* Sync / Reconnect Video Trigger */}
        <button
          onClick={() => {
            if (role === 'tutor') {
              initiateOffer();
            } else if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                type: 'webrtc_request_offer',
                clientId: clientId
              }));
            }
          }}
          title="Reconnect or sync video feed"
          style={{
            position: 'absolute',
            top: '8px',
            right: '8px',
            background: 'rgba(15, 23, 42, 0.85)',
            border: '1px solid #334155',
            color: '#94a3b8',
            borderRadius: '6px',
            padding: '4px 8px',
            fontSize: '11px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            zIndex: 10
          }}>
          <RefreshCw size={11} />
          <span>Sync Video</span>
        </button>

        <div style={{
          position: 'absolute',
          bottom: '8px',
          left: '8px',
          background: peerSpeaking ? 'rgba(5, 46, 22, 0.85)' : 'rgba(15, 23, 42, 0.75)',
          border: peerSpeaking ? '1px solid #22c55e' : '1px solid transparent',
          padding: '4px 10px',
          borderRadius: '20px',
          fontSize: '11px',
          fontWeight: 600,
          color: peerSpeaking ? '#4ade80' : '#f8fafc',
          textTransform: 'capitalize',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          transition: 'all 0.2s ease-in-out'
        }}>
          <span>{role === 'tutor' ? 'Student' : 'Tutor'} {peerConnected ? '' : '(Offline)'}</span>
          {peerSpeaking && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', height: '12px' }}>
              <span style={{ width: '3px', height: '10px', borderRadius: '2px', backgroundColor: '#22c55e' }} />
              <span style={{ width: '3px', height: '14px', borderRadius: '2px', backgroundColor: '#22c55e' }} />
              <span style={{ width: '3px', height: '8px', borderRadius: '2px', backgroundColor: '#22c55e' }} />
            </div>
          )}
        </div>
      </div>

      {/* Local Video Container */}
      <div style={{
        position: 'relative',
        height: '160px',
        borderRadius: '8px',
        overflow: 'hidden',
        backgroundColor: '#0f172a',
        border: isSpeaking ? '2px solid #22c55e' : '1px solid #334155',
        boxShadow: isSpeaking ? '0 0 16px rgba(34, 197, 94, 0.45)' : 'none',
        transition: 'all 0.15s ease-out'
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
          gap: '8px',
          background: isSpeaking ? 'rgba(5, 46, 22, 0.85)' : 'rgba(15, 23, 42, 0.8)',
          border: isSpeaking ? '1px solid #22c55e' : '1px solid #334155',
          padding: '4px 10px',
          borderRadius: '20px',
          fontSize: '11px',
          fontWeight: 600,
          color: isSpeaking ? '#4ade80' : '#cbd5e1',
          transition: 'all 0.2s ease-in-out'
        }}>
          <span>You ({role})</span>

          {isMicOn && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', height: '14px' }}>
              <span style={{
                width: '3px',
                height: isSpeaking ? `${Math.max(6, Math.min(14, audioMeter * 0.25))}px` : '4px',
                borderRadius: '2px',
                backgroundColor: isSpeaking ? '#22c55e' : '#64748b',
                transition: 'height 0.08s ease-out'
              }} />
              <span style={{
                width: '3px',
                height: isSpeaking ? `${Math.max(8, Math.min(16, audioMeter * 0.35))}px` : '4px',
                borderRadius: '2px',
                backgroundColor: isSpeaking ? '#22c55e' : '#64748b',
                transition: 'height 0.08s ease-out'
              }} />
              <span style={{
                width: '3px',
                height: isSpeaking ? `${Math.max(5, Math.min(12, audioMeter * 0.2))}px` : '4px',
                borderRadius: '2px',
                backgroundColor: isSpeaking ? '#22c55e' : '#64748b',
                transition: 'height 0.08s ease-out'
              }} />
            </div>
          )}

          {!isMicOn && (
            <MicOff size={12} color="#f87171" />
          )}
        </div>
      </div>

      {/* Control Buttons & Device Indicator */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 0'
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          gap: '12px'
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

        {/* Microphone Device Dropdown Selector */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          width: '100%',
          maxWidth: '280px',
          backgroundColor: '#0f172a',
          padding: '4px 8px',
          borderRadius: '6px',
          border: '1px solid #334155',
          marginTop: '4px'
        }}>
          <Mic size={13} color="#38bdf8" style={{ flexShrink: 0 }} />
          <select
            value={selectedAudioDeviceId}
            onChange={(e) => handleDeviceChange(e.target.value)}
            style={{
              background: 'transparent',
              color: '#cbd5e1',
              fontSize: '11px',
              border: 'none',
              outline: 'none',
              width: '100%',
              cursor: 'pointer',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              whiteSpace: 'nowrap'
            }}
            title="Switch microphone input"
          >
            {audioDevices.length > 0 ? (
              audioDevices.map((device, index) => (
                <option 
                  key={device.deviceId || index} 
                  value={device.deviceId}
                  style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}
                >
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))
            ) : (
              <option value="" style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}>
                {micDeviceName || 'Default Microphone'}
              </option>
            )}
          </select>
        </div>
      </div>
    </div>
  );
};

export default VideoCall;
