import React, { useState, useEffect, useRef } from 'react';
import { LogOut, Copy, Check, Users, Radio, MessageSquare, Activity, Sparkles, X, GripHorizontal, Minimize2, Maximize2 } from 'lucide-react';
import Whiteboard from './Whiteboard';
import VideoCall from './VideoCall';
import StreamDispatcher from './StreamDispatcher';
import DiagnosticsModal from './DiagnosticsModal';
import AICoachPanel from './AICoachPanel';
import EndSessionReportModal from './EndSessionReportModal';
import CoachToast from './CoachToast';
import CoachNotebook from './CoachNotebook';
import { MovableStudentFaceWidget } from './StudentStateWidget';
import { getWebSocketUrl } from '../config/apiConfig';

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
  const [showDialogue, setShowDialogue] = useState(false);
  const [showEndReport, setShowEndReport] = useState(false);

  // Live Coach Alert Toasts & Notebook
  const [activeToast, setActiveToast] = useState(null);
  const [notebookEntries, setNotebookEntries] = useState([
    { id: '1', tier: 'T1', category: 'Pacing', text: 'Session active. Audio transcription and visual canvas ready.', timestamp: Date.now(), read: true }
  ]);
  const [isNotebookOpen, setIsNotebookOpen] = useState(false);

  // Picture-in-Picture window position & collapse state
  // Starts in top-left (16, 56) while MovableStudentFaceWidget starts in top-right
  const [pipPos, setPipPos] = useState({ x: 16, y: 56 });
  const [pipCollapsed, setPipCollapsed] = useState(false);
  const isDraggingPip = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  const whiteboardRef = useRef(null);
  const clientId = useRef(`${role}_${Math.random().toString(36).substring(2, 9)}`).current;
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const transcriptEndRef = useRef(null);

  useEffect(() => {
    let isMounted = true;

    function connectWs() {
      const wsUrl = getWebSocketUrl(roomCode);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) return;
        setConnectionStatus('connected');
        const storedKey = localStorage.getItem('whack_llm_key') || undefined;
        const storedProvider = localStorage.getItem('whack_llm_provider') || undefined;
        ws.send(JSON.stringify({
          type: 'join',
          role,
          clientId,
          apiKey: storedKey,
          provider: storedProvider !== 'auto' ? storedProvider : undefined
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
          } else if (data.type === 'live_coach_toast' && data.data) {
            if (role === 'tutor') {
              setActiveToast(data.data);
              setNotebookEntries(prev => [
                ...prev,
                {
                  id: `entry_${Date.now()}`,
                  tier: data.data.tier,
                  category: data.data.category || 'Confusion',
                  text: data.data.notebook_entry || data.data.toast_text,
                  suggestion: data.data.action_label,
                  timestamp: Date.now(),
                  read: false
                }
              ]);
            }
          } else if (data.type === 'coaching_report_updated' && data.data) {
            const rep = data.data;
            if (role === 'tutor' && rep.whiteboard_relevance) {
              const rel = rep.whiteboard_relevance;
              const insightText = rel.acknowledgment || rel.pedagogical_insight;
              if (insightText) {
                setNotebookEntries(prev => {
                  const entryMsg = `📋 ${insightText}`;
                  if (prev.length > 0 && prev[prev.length - 1].text === entryMsg) {
                    return prev;
                  }
                  return [
                    ...prev,
                    {
                      id: `rep_${Date.now()}`,
                      tier: rel.problem_status === 'Answered with misconception' ? 'T3' : 'T1',
                      category: rel.problem_status || 'Board Analysis',
                      text: entryMsg,
                      suggestion: rel.pupil_latest_work ? `Pupil work: ${rel.pupil_latest_work}` : undefined,
                      timestamp: Date.now(),
                      read: false
                    }
                  ];
                });
              }
            }
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

  // Adaptive Background Coaching Evaluation for Tutor
  // Runs every 90 seconds, and immediately triggers 1.8s after writing/drawing pause
  const studentEditsSinceLastEval = useRef(0);
  const lastAdaptiveEvalTime = useRef(Date.now());
  const studentWriteDebounce = useRef(null);

  const maybeEvaluate = async (reason = 'timer') => {
    if (role !== 'tutor') return;
    try {
      const storedKey = localStorage.getItem('whack_llm_key') || undefined;
      const storedProvider = localStorage.getItem('whack_llm_provider') || undefined;
      const apiBase = getApiBase();

      // Pass latest auto-framed whiteboard snapshot directly
      let wbSnapshot = undefined;
      if (whiteboardRef?.current?.getSnapshot) {
        wbSnapshot = whiteboardRef.current.getSnapshot();
      }

      await fetch(`${apiBase}/api/rooms/${roomCode}/coach/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: storedKey,
          provider: storedProvider !== 'auto' ? storedProvider : undefined,
          whiteboardSnapshot: wbSnapshot
        })
      });
      studentEditsSinceLastEval.current = 0;
      lastAdaptiveEvalTime.current = Date.now();
    } catch (err) {
      console.debug('Adaptive coach eval notice:', err);
    }
  };

  const handleWhiteboardChange = () => {
    if (role !== 'tutor') return;
    // Debounce 1.8s after drawing pause before running automated evaluation
    if (studentWriteDebounce.current) clearTimeout(studentWriteDebounce.current);
    studentWriteDebounce.current = setTimeout(() => {
      maybeEvaluate('local_whiteboard_edit');
    }, 1800);
  };

  useEffect(() => {
    if (role !== 'tutor' || !socket) return;

    const handleMessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (
          data.type === 'whiteboard_element' ||
          data.type === 'whiteboard_stroke' ||
          data.type === 'whiteboard_delete_element' ||
          data.type === 'whiteboard_clear'
        ) {
          studentEditsSinceLastEval.current += 1;
          
          // Debounce 1.8s after student finishes writing/drawing their answer attempt
          if (studentWriteDebounce.current) clearTimeout(studentWriteDebounce.current);
          studentWriteDebounce.current = setTimeout(() => {
            maybeEvaluate('remote_whiteboard_edit');
          }, 1800);
        }
      } catch {}
    };

    socket.addEventListener('message', handleMessage);

    // Regular 90-second cadence
    const interval = setInterval(() => {
      maybeEvaluate('cadence_interval');
    }, 90000);

    return () => {
      socket.removeEventListener('message', handleMessage);
      if (studentWriteDebounce.current) clearTimeout(studentWriteDebounce.current);
      clearInterval(interval);
    };
  }, [role, socket, roomCode]);

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

  // Demo Nudge Trigger (hotkey: Ctrl+Shift+D or Alt+D) - cycles through T3 & T2 alerts
  const demoCycleRef = useRef(0);
  const triggerDemoNudge = () => {
    const triggers = ['demo_face_confusion', 'demo_subtraction', 'demo_geometry', 'demo_pacing', 'demo_fractions'];
    const currentTrigger = triggers[demoCycleRef.current % triggers.length];
    demoCycleRef.current += 1;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'trigger_demo_nudge',
        triggerType: currentTrigger
      }));
    } else {
      let demoToast;
      if (currentTrigger === 'demo_face_confusion') {
        demoToast = {
          tier: 'T3',
          category: 'visual_confusion',
          context_badge: '😟 Confusion (6s)',
          toast_text: "Student looks consistently puzzled/confused while you're explaining '21 - 1' — pause to check understanding?",
          action_label: '📐 Draw 21 - 1 Hop Line',
          example_type: 'place_value',
          stepping_stone: 'Try simpler anchor: 20 - 1 = ?',
          counter_example: "Ask: 'If 21 - 1 was 16, what would 16 + 1 be?'",
          custom_diagram: {
            type: 'custom_diagram',
            kind: 'number_line_hop',
            title: 'Directed Hop Model: 21 - 1 = 20',
            params: { equation: '21 - 1 = 20', start: 21, step: -1, result: 20, tens: 2, ones: 1 }
          },
          notebook_entry: "🔴 Video Detection: Student showing rolling brow furrow/confusion while tutor wrote '21 - 1'.",
          timestamp: Date.now()
        };
      } else if (currentTrigger === 'demo_geometry') {
        demoToast = {
          tier: 'T2',
          category: 'whiteboard_geometry',
          context_badge: '🎯 Board Detection',
          toast_text: 'Student drew circle on board — drop radius & diameter guide?',
          action_label: '⭕ Drop on Board',
          example_type: 'circle_guide',
          stepping_stone: 'Formulas: Radius r = d / 2, Area = πr², Circumference = 2πr',
          counter_example: 'Check: Is the line spanning the whole center (diameter) or from center to edge (radius)?',
          custom_diagram: {
            type: 'custom_diagram',
            kind: 'circle_properties',
            title: 'Circle Geometry: Radius & Diameter',
            params: { radius: 5, diameter: 10, unit: 'cm' }
          },
          notebook_entry: '🟡 Board Detection: Geometric circle identified; anchor with labeled radius/diameter formulas.',
          timestamp: Date.now()
        };
      } else if (currentTrigger === 'demo_pacing') {
        demoToast = {
          tier: 'T2',
          category: 'pacing',
          context_badge: '⏳ Quiet Spell',
          toast_text: 'Student has been quiet for >15s on recent step — offer an open-ended hint?',
          action_label: '💡 Offer Hint',
          example_type: 'number_line',
          stepping_stone: "Try asking: 'What is the first step you want to try?'",
          counter_example: 'Avoid giving the whole answer immediately; prompt student for their current thought.',
          custom_diagram: {
            type: 'custom_diagram',
            kind: 'number_line_hop',
            title: 'Number Line Step Hint',
            params: { equation: 'Next step', start: 0, step: 1, result: 1 }
          },
          notebook_entry: '🟡 Pacing Notice: Extended pause detected; suggested prompt check-in.',
          timestamp: Date.now()
        };
      } else if (currentTrigger === 'demo_subtraction') {
        demoToast = {
          tier: 'T3',
          category: 'whiteboard_misconception',
          context_badge: '⚠️ 2nd Wrong Attempt',
          toast_text: "Student answered '16' to '21 - 1' — try a stepping-stone anchor?",
          action_label: '📐 Draw 21 - 1 Hop Line',
          example_type: 'place_value',
          stepping_stone: 'Try simpler anchor: 20 - 1 = ?',
          counter_example: "Ask: 'If 21 - 1 was 16, what would 16 + 1 be?'",
          custom_diagram: {
            type: 'custom_diagram',
            kind: 'number_line_hop',
            title: 'Directed Hop Model: 21 - 1 = 20',
            params: { equation: '21 - 1 = 20', start: 21, step: -1, result: 20, tens: 2, ones: 1 }
          },
          notebook_entry: "🔴 Repeated Misconception: Student answered '16' to '21 - 1' twice (place-value error).",
          timestamp: Date.now()
        };
      } else {
        demoToast = {
          tier: 'T3',
          category: 'confusion',
          context_badge: 'Spoken Confusion',
          toast_text: 'Student stuck on dividing fractions — try a pizza-slice example?',
          action_label: '🍕 Draw Fraction Model',
          example_type: 'fraction_pizza',
          stepping_stone: "Try anchor: '1 ÷ 1/2 = ?' (how many halves in 1 whole?)",
          counter_example: "Ask: 'If we multiply our answer by the divisor, do we get back the original?'",
          custom_diagram: {
            type: 'custom_diagram',
            kind: 'fraction_strip',
            title: 'Fraction Bar Model: 3/4 ÷ 1/2',
            params: { equation: '3/4 ÷ 1/2', top_num: 3, top_den: 4, bottom_num: 1, bottom_den: 2 }
          },
          notebook_entry: "🔴 Spoken Confusion: 'wait, how do we divide fractions?'",
          timestamp: Date.now()
        };
      }

      setActiveToast(demoToast);
      setNotebookEntries(prev => [...prev, {
        id: `entry_${Date.now()}`,
        tier: demoToast.tier,
        category: demoToast.context_badge || 'Live Coach Alert',
        text: demoToast.notebook_entry,
        suggestion: demoToast.action_label,
        timestamp: Date.now(),
        read: false
      }]);
    }
  };

  const handleApplyExample = (examplePayload) => {
    if (whiteboardRef.current?.insertVisualExample) {
      whiteboardRef.current.insertVisualExample(examplePayload || 'number_line_hop');
    }
    setActiveToast(null);
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') || (e.altKey && e.key.toLowerCase() === 'd')) {
        e.preventDefault();
        triggerDemoNudge();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handlePipPointerDown = (e) => {
    isDraggingPip.current = true;
    dragOffsetRef.current = {
      x: e.clientX - pipPos.x,
      y: e.clientY - pipPos.y
    };
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  };

  const handlePipPointerMove = (e) => {
    if (!isDraggingPip.current) return;
    const maxX = Math.max(10, window.innerWidth - (pipCollapsed ? 180 : 360));
    const maxY = Math.max(50, window.innerHeight - (pipCollapsed ? 60 : 240));
    const nextX = Math.max(8, Math.min(maxX, e.clientX - dragOffsetRef.current.x));
    const nextY = Math.max(52, Math.min(maxY, e.clientY - dragOffsetRef.current.y));
    setPipPos({ x: nextX, y: nextY });
  };

  const handlePipPointerUp = (e) => {
    isDraggingPip.current = false;
    try { e.target.releasePointerCapture(e.pointerId); } catch {}
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
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Quick Demo Trigger for 3-minute pitch */}
          {role === 'tutor' && (
            <button
              onClick={triggerDemoNudge}
              title="Ctrl+Shift+D: Cycle T3 & T2 Alerts (Rolling confusion while explaining, repeated errors, geometry guides, pacing silence)"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '6px 12px',
                borderRadius: '6px',
                backgroundColor: '#7c2d12',
                color: '#fed7aa',
                fontSize: '12px',
                fontWeight: 600,
                border: '1px solid #ea580c',
                cursor: 'pointer'
              }}>
              <span>⚡ Demo Nudge</span>
            </button>
          )}

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

          {/* Live Dialogue Drawer Toggle */}
          <button
            onClick={() => setShowDialogue(prev => !prev)}
            title="Toggle Live Dialogue & Transcripts"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '6px',
              backgroundColor: showDialogue ? '#064e3b' : '#1e293b',
              color: showDialogue ? '#6ee7b7' : '#94a3b8',
              fontSize: '12px',
              fontWeight: 600,
              border: `1px solid ${showDialogue ? '#059669' : '#334155'}`,
              cursor: 'pointer'
            }}>
            <MessageSquare size={14} />
            <span>Dialogue {transcripts.length > 0 ? `(${transcripts.length})` : ''}</span>
          </button>

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
            onClick={() => {
              if (role === 'tutor') {
                setShowEndReport(true);
              } else {
                onLeave();
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 14px',
              borderRadius: '6px',
              backgroundColor: '#334155',
              color: '#f8fafc',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer'
            }}>
            <LogOut size={16} />
            Exit Session
          </button>
        </div>
      </header>

      {/* Main Full-Width Whiteboard Canvas with PiP & Tutor State Overlays */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', width: '100%', height: '100%' }}>
        {/* Full-width Whiteboard Workspace */}
        <Whiteboard
          ref={whiteboardRef}
          onStroke={handleStroke}
          socket={socket}
          role={role}
          clientId={clientId}
          onWhiteboardChange={handleWhiteboardChange}
        />

        {/* Movable Tutor Student Face Mode Widget (starts top-right, draggable anywhere) */}
        {role === 'tutor' && (
          <MovableStudentFaceWidget
            roomCode={roomCode}
            socket={socket}
            onOpenReport={() => setShowAICoach(true)}
          />
        )}

        {/* Top-Left: Picture-in-Picture Video Call (approx 1/9th total area) */}
        <div
          style={{
            position: 'absolute',
            left: `${pipPos.x}px`,
            top: `${pipPos.y}px`,
            width: pipCollapsed ? 'auto' : 'clamp(290px, 25vw, 360px)',
            height: pipCollapsed ? '40px' : 'clamp(185px, 22vh, 235px)',
            zIndex: 35,
            boxShadow: '0 12px 36px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.1)',
            borderRadius: '14px',
            overflow: 'hidden',
            backgroundColor: '#0f172a',
            display: 'flex',
            flexDirection: 'column',
            transition: isDraggingPip.current ? 'none' : 'width 0.2s ease, height 0.2s ease'
          }}
        >
          {/* PiP Header & Drag Handle */}
          <div
            onPointerDown={handlePipPointerDown}
            onPointerMove={handlePipPointerMove}
            onPointerUp={handlePipPointerUp}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '5px 10px',
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              borderBottom: pipCollapsed ? 'none' : '1px solid rgba(51, 65, 85, 0.7)',
              cursor: 'grab',
              userSelect: 'none',
              zIndex: 25
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#94a3b8', fontSize: '11px', fontWeight: 600 }}>
              <GripHorizontal size={14} color="#64748b" />
              <span>Live Video {pipCollapsed ? `(${role === 'tutor' ? 'Student' : 'Tutor'})` : ''}</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPipCollapsed(c => !c);
              }}
              title={pipCollapsed ? "Expand Video" : "Collapse Video"}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                padding: '2px'
              }}
            >
              {pipCollapsed ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
            </button>
          </div>

          {/* Video Container (keeps video call mounted even when collapsed) */}
          <div style={{ flex: 1, position: 'relative', display: pipCollapsed ? 'none' : 'block' }}>
            <VideoCall
              socket={socket}
              roomCode={roomCode}
              role={role}
              clientId={clientId}
              onLocalMediaReady={(stream) => setLocalStream(stream)}
              pipMode={true}
            />
          </div>
        </div>

        {/* Tiered Live Alert Toast (~1/8th of canvas height, tutor only) */}
        {role === 'tutor' && activeToast && (
          <CoachToast
            toast={activeToast}
            onApplyExample={handleApplyExample}
            onDismiss={() => setActiveToast(null)}
            onSnooze={() => setActiveToast(null)}
          />
        )}

        {/* Coach Notebook: Collapsible tab & drawer on the right edge */}
        {role === 'tutor' && (
          <CoachNotebook
            isOpen={isNotebookOpen}
            onToggle={() => setIsNotebookOpen(prev => !prev)}
            entries={notebookEntries}
            topTakeaways={[
              'Fractions division: Favor visual representations (pizza, number line).',
              'Student recovers quickly when given a concrete example first.'
            ]}
            onOpenFullReport={() => {
              setIsNotebookOpen(false);
              setShowAICoach(true);
            }}
          />
        )}

        {/* Real-time Floating Subtitles Overlay */}
        {transcripts.length > 0 && (
          <div style={{
            position: 'absolute',
            bottom: activeToast ? '106px' : '24px',
            left: '50%',
            transform: 'translateX(-50%)',
            maxWidth: '80%',
            zIndex: 30,
            pointerEvents: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            alignItems: 'center',
            transition: 'bottom 0.2s ease'
          }}>
            {transcripts.slice(-2).map((t, idx) => {
              const isTutor = t.role === 'tutor';
              return (
                <div
                  key={idx}
                  style={{
                    backgroundColor: 'rgba(15, 23, 42, 0.90)',
                    backdropFilter: 'blur(8px)',
                    border: `1px solid ${isTutor ? 'rgba(56, 189, 248, 0.5)' : 'rgba(74, 222, 128, 0.5)'}`,
                    borderRadius: '8px',
                    padding: '8px 16px',
                    color: '#f8fafc',
                    fontSize: '14px',
                    lineHeight: '1.4',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                    textAlign: 'center',
                    pointerEvents: 'auto',
                    maxWidth: '100%'
                  }}
                >
                  <span style={{
                    color: isTutor ? '#38bdf8' : '#4ade80',
                    fontWeight: 700,
                    marginRight: '8px',
                    textTransform: 'uppercase',
                    fontSize: '11px',
                    letterSpacing: '0.05em'
                  }}>
                    {isTutor ? 'Tutor' : 'Student'}:
                  </span>
                  <span>{t.text}</span>
                </div>
              );
            })}
          </div>
        )}
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
        whiteboardRef={whiteboardRef}
        isOpen={showAICoach}
        onClose={() => setShowAICoach(false)}
      />

      {/* Comprehensive End-of-Session Report Modal for Tutor */}
      {role === 'tutor' && (
        <EndSessionReportModal
          isOpen={showEndReport}
          onClose={() => setShowEndReport(false)}
          onConfirmExit={onLeave}
          roomCode={roomCode}
          title={title}
          transcripts={transcripts}
        />
      )}

      {/* Live Dialogue & Full Transcript Drawer */}
      {showDialogue && (
        <div style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: '380px',
          backgroundColor: '#0f172a',
          borderLeft: '1px solid #334155',
          boxShadow: '-6px 0 24px rgba(0,0,0,0.6)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column'
        }}>
          {/* Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #334155',
            backgroundColor: '#1e293b'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <MessageSquare size={18} color="#38bdf8" />
              <div>
                <h3 style={{ fontSize: '15px', fontWeight: 600, margin: 0 }}>Live Dialogue Log</h3>
                <p style={{ fontSize: '11px', color: '#94a3b8', margin: '2px 0 0 0' }}>
                  Real-time Whisper speech transcription
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowDialogue(false)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '6px',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center'
              }}>
              <X size={18} />
            </button>
          </div>

          {/* Transcript List */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {transcripts.length === 0 ? (
              <div style={{
                textAlign: 'center',
                color: '#64748b',
                marginTop: '60px',
                padding: '20px',
                border: '1px dashed #334155',
                borderRadius: '8px'
              }}>
                <MessageSquare size={28} color="#475569" style={{ margin: '0 auto 8px' }} />
                <p style={{ fontSize: '13px', fontWeight: 500, color: '#94a3b8', margin: '0 0 6px 0' }}>
                  No speech captured yet
                </p>
                <p style={{ fontSize: '11px', color: '#64748b', margin: 0, lineHeight: 1.5 }}>
                  Speak clearly into your microphone. Once speech is detected, live transcripts will appear here and on the whiteboard subtitles.
                </p>
              </div>
            ) : (
              transcripts.map((t, idx) => {
                const isTutor = t.role === 'tutor';
                return (
                  <div key={idx} style={{
                    backgroundColor: '#1e293b',
                    border: `1px solid ${isTutor ? '#0284c740' : '#16a34a40'}`,
                    borderRadius: '8px',
                    padding: '10px 12px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: isTutor ? '#38bdf8' : '#4ade80'
                      }}>
                        {isTutor ? 'Tutor' : 'Student'}
                      </span>
                      <span style={{ fontSize: '10px', color: '#64748b' }}>
                        {t.timestamp ? new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
                      </span>
                    </div>
                    <div style={{ fontSize: '13px', color: '#e2e8f0', lineHeight: 1.4 }}>
                      {t.text}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      )}
    </div>
  );
};

export default MeetingRoom;
