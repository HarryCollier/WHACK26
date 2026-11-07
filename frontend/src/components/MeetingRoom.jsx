import React, { useState, useEffect, useRef } from 'react';
import { LogOut, Copy, Check, Users, Radio, MessageSquare, Activity, Sparkles } from 'lucide-react';
import Whiteboard from './Whiteboard';
import VideoCall from './VideoCall';
import StreamDispatcher from './StreamDispatcher';
import DiagnosticsModal from './DiagnosticsModal';
import AICoachPanel, { LiveEngagementBadge } from './AICoachPanel';

const MeetingRoom = ({ session, onLeave }) => {
  const { roomCode, title, role } = session;
  const [socket, setSocket] = useState(null);
  const [copied, setCopied] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [peerPresence, setPeerPresence] = useState('Waiting for student/tutor...');
  const [transcripts, setTranscripts] = useState([]);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showAICoach, setShowAICoach] = useState(false);

  const whiteboardRef = useRef(null);
  const clientId = useRef(`${role}_${Math.random().toString(36).substring(2, 9)}`).current;
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const transcriptEndRef = useRef(null);

  useEffect(() => {
    let isMounted = true;

    function connectWs() {
      const wsUrl = `ws://localhost:8000/ws/meeting/${roomCode}/`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) return;
        setConnectionStatus('connected');
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
          } else if (data.type === 'live_transcript') {
            setTranscripts(prev => [...prev.slice(-30), {
              role: data.role,
              text: data.text,
              timestamp: data.timestamp
            }]);
          }
        } catch (e) {}
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setConnectionStatus('disconnected');
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

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts]);

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

          {/* Tutor Live Engagement Indicator */}
          {role === 'tutor' && (
            <LiveEngagementBadge
              roomCode={roomCode}
              socket={socket}
              role={role}
              onClick={() => setShowAICoach(true)}
            />
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* AI Coach Button for Tutor */}
          {role === 'tutor' && (
            <button
              onClick={() => setShowAICoach(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                borderRadius: '6px',
                backgroundColor: '#312e81',
                color: '#c7d2fe',
                fontSize: '12px',
                fontWeight: 600,
                border: '1px solid #4338ca',
                cursor: 'pointer'
              }}>
              <Sparkles size={14} color="#a855f7" />
              AI Coach
            </button>
          )}

          <button
            onClick={() => setShowDiagnostics(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '6px',
              backgroundColor: '#1e3a8a',
              color: '#93c5fd',
              fontSize: '12px',
              fontWeight: 600,
              border: '1px solid #2563eb'
            }}>
            <Activity size={14} />
            Inspect Server Data
          </button>

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

      {/* Main Split Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Whiteboard Workspace */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <Whiteboard
            ref={whiteboardRef}
            onStroke={handleStroke}
            socket={socket}
          />
        </div>

        {/* Right Sidebar: Video Call */}
        <div style={{ width: '320px', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <VideoCall
            socket={socket}
            roomCode={roomCode}
            role={role}
            clientId={clientId}
            onLocalMediaReady={(stream) => setLocalStream(stream)}
          />
        </div>
      </div>

      {/* Stream Dispatcher with configurable sample rates */}
      <StreamDispatcher
        socket={socket}
        role={role}
        clientId={clientId}
        whiteboardRef={whiteboardRef}
        localStream={localStream}
      />

      {/* Live Server In-Memory Diagnostics Modal */}
      <DiagnosticsModal
        roomCode={roomCode}
        isOpen={showDiagnostics}
        onClose={() => setShowDiagnostics(false)}
      />

      {/* AI Pedagogical Coach Drawer / Panel */}
      <AICoachPanel
        roomCode={roomCode}
        socket={socket}
        role={role}
        isOpen={showAICoach}
        onClose={() => setShowAICoach(false)}
      />
    </div>
  );
};

export default MeetingRoom;
