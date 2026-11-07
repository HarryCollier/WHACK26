import React, { useState, useEffect, useRef } from 'react';
import { LogOut, Copy, Check, Users, Radio } from 'lucide-react';
import Whiteboard from './Whiteboard';
import VideoCall from './VideoCall';
import StreamDispatcher from './StreamDispatcher';

const MeetingRoom = ({ session, onLeave }) => {
  const { roomCode, title, role } = session;
  const [socket, setSocket] = useState(null);
  const [copied, setCopied] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // 'connecting' | 'connected' | 'disconnected'
  const [peerPresence, setPeerPresence] = useState('Waiting for student/tutor...');

  const whiteboardRef = useRef(null);
  const clientId = useRef(`${role}_${Math.random().toString(36).substring(2, 9)}`).current;
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  // WebSocket connection with automatic reconnect resilience
  useEffect(() => {
    let isMounted = true;

    function connectWs() {
      const wsUrl = `ws://localhost:8000/ws/meeting/${roomCode}/`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) return;
        setConnectionStatus('connected');
        // Register role and client identity
        ws.send(JSON.stringify({
          type: 'join',
          role,
          clientId
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'presence') {
            if (data.event === 'user_joined') {
              setPeerPresence(`${data.role === 'tutor' ? 'Tutor' : 'Student'} joined`);
            } else if (data.event === 'user_left') {
              setPeerPresence(`${data.role === 'tutor' ? 'Tutor' : 'Student'} left`);
            }
          }
        } catch (e) {}
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setConnectionStatus('disconnected');
        // Resilient auto-reconnect attempt after 2 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isMounted) connectWs();
        }, 2000);
      };

      ws.onerror = (err) => {
        console.warn('Meeting WebSocket encountered error', err);
      };

      setSocket(ws);
    }

    connectWs();

    // Heartbeat ping to keep connection healthy
    const pingInterval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);

    return () => {
      isMounted = false;
      clearInterval(pingInterval);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [roomCode, role, clientId]);

  const handleStroke = (stroke) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'whiteboard_stroke',
        stroke
      }));
    }
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      backgroundColor: '#0f172a',
      color: '#f8fafc',
      overflow: 'hidden'
    }}>
      {/* Top Navbar */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 20px',
        backgroundColor: '#1e293b',
        borderBottom: '1px solid #334155'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div>
            <h2 style={{ fontSize: '16px', fontWeight: 600 }}>{title}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
              <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                Room Code: <strong style={{ color: '#38bdf8' }}>{roomCode}</strong>
              </span>
              <button
                onClick={copyRoomCode}
                title="Copy Room Code"
                style={{
                  background: 'transparent',
                  color: '#94a3b8',
                  padding: '2px 4px',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center'
                }}>
                {copied ? <Check size={14} color="#22c55e" /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          {/* Connection status tag */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: connectionStatus === 'connected' ? '#064e3b' : '#7f1d1d',
            padding: '4px 10px',
            borderRadius: '12px',
            fontSize: '12px',
            fontWeight: 500,
            color: connectionStatus === 'connected' ? '#6ee7b7' : '#fca5a5'
          }}>
            <Radio size={12} />
            <span>{connectionStatus === 'connected' ? 'Live' : 'Reconnecting...'}</span>
          </div>

          <div style={{ fontSize: '12px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Users size={14} />
            <span>{peerPresence}</span>
          </div>
        </div>

        {/* User Info & Leave Room */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{
            backgroundColor: role === 'tutor' ? '#1e3a8a' : '#14532d',
            color: role === 'tutor' ? '#93c5fd' : '#86efac',
            padding: '4px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 600,
            textTransform: 'uppercase'
          }}>
            {role}
          </span>

          <button
            onClick={onLeave}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 14px',
              borderRadius: '6px',
              backgroundColor: '#334155',
              color: '#f8fafc',
              fontSize: '13px',
              fontWeight: 500
            }}>
            <LogOut size={16} />
            Exit Session
          </button>
        </div>
      </header>

      {/* Main Split Body: Whiteboard Workspace + Video Feed Column */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Whiteboard Workspace (Center stage) */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <Whiteboard
            ref={whiteboardRef}
            onStroke={handleStroke}
            socket={socket}
          />
        </div>

        {/* Video Call Sidebar */}
        <div style={{ width: '320px', height: '100%' }}>
          <VideoCall
            socket={socket}
            roomCode={roomCode}
            role={role}
            clientId={clientId}
            onLocalMediaReady={(stream) => setLocalStream(stream)}
          />
        </div>
      </div>

      {/* Background Stream Ingestion Dispatcher */}
      {/* Periodically streams cleanly-tagged snapshots & audio chunks to Django */}
      <StreamDispatcher
        socket={socket}
        role={role}
        clientId={clientId}
        whiteboardRef={whiteboardRef}
        localStream={localStream}
      />
    </div>
  );
};

export default MeetingRoom;
