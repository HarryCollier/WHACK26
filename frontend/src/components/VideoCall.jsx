import React, { useRef, useEffect, useState } from 'react';
import { Mic, MicOff, Video, VideoOff, WifiOff } from 'lucide-react';

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
  const audioSourceNode = useRef(null);
  const animationFrameId = useRef(null);

  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [peerConnected, setPeerConnected] = useState(false);
  const [audioMeter, setAudioMeter] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [peerSpeaking, setPeerSpeaking] = useState(false);
  const [micDeviceName, setMicDeviceName] = useState('Default Microphone');
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState('');

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
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
  }, []);

  const setupPeerConnection = () => {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnection.current = pc;

    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        pc.addTrack(track, localStream.current);
      });
    }

    pc.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
        setPeerConnected(true);
      }
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

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setPeerConnected(true);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setPeerConnected(false);
      }
    };
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
