import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, ChevronRight, GripVertical } from 'lucide-react';
import { getApiBase } from '../config/apiConfig';

/**
 * Expressive SVG Face showing student's real-time emotional and attention state.
 * Dynamic facial features:
 * - Green (attentive/engaged): warm smile, open happy eyes, emerald glow.
 * - Red (confused/brow furrow): furrowed angled eyebrows, wavy puzzled mouth, coral glow.
 * - Yellow (distracted/looking away): pupils glancing sideways, flat line mouth, amber glow.
 * - Blue (listening/neutral): calm focused eyes, gentle resting mouth.
 * - Gray (no face/idle): sleeping dash eyes, dashed mouth.
 */
function StateFace({ statusColor, attentionState, isFaceDetected }) {
  // Determine color scheme
  const theme = {
    green: { stroke: '#10b981', fill: 'rgba(16, 185, 129, 0.18)', glow: 'rgba(16, 185, 129, 0.5)' },
    red: { stroke: '#ef4444', fill: 'rgba(239, 68, 68, 0.18)', glow: 'rgba(239, 68, 68, 0.5)' },
    yellow: { stroke: '#f59e0b', fill: 'rgba(245, 158, 11, 0.18)', glow: 'rgba(245, 158, 11, 0.5)' },
    blue: { stroke: '#0ea5e9', fill: 'rgba(14, 165, 233, 0.18)', glow: 'rgba(14, 165, 233, 0.5)' },
    gray: { stroke: '#64748b', fill: 'rgba(100, 116, 139, 0.18)', glow: 'rgba(100, 116, 139, 0.3)' }
  }[statusColor] || { stroke: '#64748b', fill: 'rgba(100, 116, 139, 0.18)', glow: 'rgba(100, 116, 139, 0.3)' };

  // Face size 38x38
  return (
    <svg 
      width="38" 
      height="38" 
      viewBox="0 0 38 38" 
      style={{ 
        flexShrink: 0,
        filter: `drop-shadow(0 0 8px ${theme.glow})`,
        transition: 'all 0.3s ease'
      }}
    >
      {/* Outer Head Circle */}
      <circle
        cx="19"
        cy="19"
        r="17"
        fill={theme.fill}
        stroke={theme.stroke}
        strokeWidth="2"
      />

      {/* Facial Features according to state */}
      {!isFaceDetected || statusColor === 'gray' ? (
        // No Face / Sleeping State
        <g stroke={theme.stroke} strokeWidth="2" strokeLinecap="round">
          {/* Closed / dash eyes */}
          <line x1="10" y1="16" x2="15" y2="16" />
          <line x1="23" y1="16" x2="28" y2="16" />
          {/* Neutral mouth */}
          <line x1="14" y1="26" x2="24" y2="26" strokeDasharray="2,2" />
        </g>
      ) : statusColor === 'red' || attentionState === 'confused' ? (
        // Confused / Brow Furrow State
        <g stroke={theme.stroke} strokeWidth="1.8" strokeLinecap="round">
          {/* Furrowed Brow lines (slanted inward \ /) */}
          <line x1="10" y1="12" x2="16" y2="15" strokeWidth="2" />
          <line x1="22" y1="15" x2="28" y2="12" strokeWidth="2" />
          {/* Puzzled Eyes (slightly squinted or asymmetrical) */}
          <circle cx="13" cy="18" r="2.2" fill={theme.stroke} stroke="none" />
          <circle cx="25" cy="18" r="2.2" fill={theme.stroke} stroke="none" />
          {/* Puzzled / Wavy Mouth */}
          <path
            d="M 12 27 Q 15 24 19 26 Q 23 28 26 25"
            fill="none"
            strokeWidth="2"
          />
        </g>
      ) : statusColor === 'yellow' || attentionState === 'distracted' ? (
        // Looking Away / Distracted State
        <g stroke={theme.stroke} strokeWidth="1.8" strokeLinecap="round">
          {/* Slightly raised arched brows */}
          <path d="M 10 13 Q 14 11 17 13" fill="none" />
          <path d="M 21 13 Q 24 11 28 13" fill="none" />
          {/* Eye whites */}
          <circle cx="13" cy="18" r="3" fill="rgba(255,255,255,0.4)" stroke={theme.stroke} strokeWidth="1" />
          <circle cx="25" cy="18" r="3" fill="rgba(255,255,255,0.4)" stroke={theme.stroke} strokeWidth="1" />
          {/* Pupils shifted to the right edge (looking away) */}
          <circle cx="15" cy="18" r="1.6" fill={theme.stroke} stroke="none" />
          <circle cx="27" cy="18" r="1.6" fill={theme.stroke} stroke="none" />
          {/* Straight line neutral mouth */}
          <line x1="14" y1="26" x2="24" y2="26" strokeWidth="2" />
        </g>
      ) : statusColor === 'green' || attentionState === 'attentive' ? (
        // Engaged & Smiling State
        <g stroke={theme.stroke} strokeWidth="1.8" strokeLinecap="round">
          {/* Relaxed cheerful arched brows */}
          <path d="M 10 13 Q 14 10 17 13" fill="none" />
          <path d="M 21 13 Q 24 10 28 13" fill="none" />
          {/* Happy bright eyes */}
          <circle cx="13" cy="17" r="2.4" fill={theme.stroke} stroke="none" />
          <circle cx="25" cy="17" r="2.4" fill={theme.stroke} stroke="none" />
          {/* Warm upward smile */}
          <path
            d="M 12 23 Q 19 31 26 23"
            fill="none"
            strokeWidth="2.2"
          />
        </g>
      ) : (
        // Neutral / Listening State (Blue/Default)
        <g stroke={theme.stroke} strokeWidth="1.8" strokeLinecap="round">
          <line x1="11" y1="13" x2="16" y2="13" />
          <line x1="22" y1="13" x2="27" y2="13" />
          <circle cx="13" cy="17" r="2.2" fill={theme.stroke} stroke="none" />
          <circle cx="25" cy="17" r="2.2" fill={theme.stroke} stroke="none" />
          <line x1="14" y1="26" x2="24" y2="26" strokeWidth="2" />
        </g>
      )}
    </svg>
  );
}

/**
 * TutorStudentStateWidget
 * Sits on the top-right of the whiteboard exclusively for the tutor.
 * Renders:
 * 1. Expressive colored face representing student's cognitive state (green=engaged, red=confused, yellow=distracted, gray=waiting).
 * 2. Written emotion / status label + engagement score.
 * 3. Pop-out button to trigger the full AI Pedagogical Coach report drawer.
 */
export default function TutorStudentStateWidget({ roomCode, socket, onOpenReport }) {
  const [pulse, setPulse] = useState({
    engagement_score: 0,
    status_label: 'Waiting for Student Video',
    status_color: 'gray',
    attention_state: 'no_face',
    student_face_detected: false,
    brow_furrow_level: 0.0,
    gaze_direction: 'unknown',
    actionable_hint: 'Waiting for student camera feed.'
  });

  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    let isMounted = true;

    // 1. Listen for real-time WebSocket engagement pulses
    const handleMessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'engagement_pulse' && data.data) {
          if (isMounted) setPulse(data.data);
        }
      } catch {}
    };

    if (socket) {
      socket.addEventListener('message', handleMessage);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'request_engagement_pulse' }));
      }
    }

    // 2. Rolling fallback poll (every 2.5s for snappy real-time feedback)
    const fetchPulse = async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/rooms/${roomCode}/engagement/`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted) setPulse(data);
        }
      } catch {}
    };

    fetchPulse();
    const interval = setInterval(fetchPulse, 2500);

    return () => {
      isMounted = false;
      clearInterval(interval);
      if (socket) {
        socket.removeEventListener('message', handleMessage);
      }
    };
  }, [roomCode, socket]);

  // Map state to readable written emotion text
  const getWrittenEmotion = () => {
    if (!pulse.student_face_detected || pulse.status_color === 'gray') {
      if (pulse.has_raw_frames || pulse.status_label === 'No Student Face Detected') {
        return {
          title: 'No Face in View',
          detail: 'Camera active • Looking away'
        };
      }
      return {
        title: 'Connecting Video...',
        detail: 'Waiting for student feed'
      };
    }
    if (pulse.student_wb_active || pulse.status_label === 'Student Writing on Whiteboard') {
      return {
        title: 'Writing on Board',
        detail: 'Active problem solving'
      };
    }
    if (pulse.status_color === 'red' || pulse.attention_state === 'confused') {
      return {
        title: 'Confused / Brow Furrow',
        detail: 'May need clarification'
      };
    }
    if (pulse.status_color === 'yellow' || pulse.attention_state === 'distracted') {
      return {
        title: 'Looking Away',
        detail: 'Attention off-screen'
      };
    }
    if (pulse.status_color === 'green' || pulse.attention_state === 'attentive') {
      return {
        title: 'Engaged & Attentive',
        detail: `${Math.round(pulse.engagement_score || 80)}% comprehension`
      };
    }
    return {
      title: 'Listening / Neutral',
      detail: 'Passive comprehension'
    };
  };

  const emotion = getWrittenEmotion();

  // Accent colors for borders and text
  const colorStyles = {
    green: { border: 'rgba(16, 185, 129, 0.5)', text: '#34d399', bg: 'rgba(6, 78, 59, 0.4)' },
    red: { border: 'rgba(239, 68, 68, 0.6)', text: '#f87171', bg: 'rgba(69, 10, 10, 0.45)' },
    yellow: { border: 'rgba(245, 158, 11, 0.5)', text: '#fbbf24', bg: 'rgba(69, 26, 3, 0.4)' },
    blue: { border: 'rgba(14, 165, 233, 0.5)', text: '#38bdf8', bg: 'rgba(12, 74, 110, 0.4)' },
    gray: { border: 'rgba(100, 116, 139, 0.4)', text: '#94a3b8', bg: 'rgba(30, 41, 59, 0.4)' }
  }[pulse.status_color] || { border: 'rgba(100, 116, 139, 0.4)', text: '#94a3b8', bg: 'rgba(30, 41, 59, 0.4)' };

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        position: 'absolute',
        top: '56px',
        right: '16px',
        zIndex: 35,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '8px 14px',
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        backdropFilter: 'blur(12px)',
        borderRadius: '14px',
        border: `1.5px solid ${colorStyles.border}`,
        boxShadow: isHovered 
          ? `0 10px 28px rgba(0,0,0,0.5), 0 0 16px ${colorStyles.border}`
          : '0 6px 20px rgba(0,0,0,0.35)',
        transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        userSelect: 'none'
      }}
    >
      {/* 1. Coloured Face Avatar */}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <StateFace
          statusColor={pulse.status_color}
          attentionState={pulse.attention_state}
          isFaceDetected={pulse.student_face_detected}
        />
      </div>

      {/* 2. Written Emotion & State Description */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: '130px' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}>
          <span style={{
            fontSize: '13px',
            fontWeight: 700,
            color: colorStyles.text,
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap'
          }}>
            {emotion.title}
          </span>
        </div>
        <span style={{
          fontSize: '11px',
          color: '#94a3b8',
          whiteSpace: 'nowrap',
          marginTop: '1px'
        }}>
          {emotion.detail}
        </span>
      </div>

      <div style={{ width: '1px', height: '28px', backgroundColor: 'rgba(51, 65, 85, 0.8)', margin: '0 2px' }} />

      {/* 3. Pop-out AI Pedagogical Coach Report Button */}
      <button
        onClick={onOpenReport}
        title="Open AI Pedagogical Coach Report & Analytics"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '7px 12px',
          borderRadius: '9px',
          backgroundColor: '#312e81',
          color: '#e0e7ff',
          fontSize: '12px',
          fontWeight: 600,
          border: '1px solid #4338ca',
          cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(79, 70, 229, 0.25)',
          transition: 'all 0.15s ease',
          whiteSpace: 'nowrap'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = '#3730a3';
          e.currentTarget.style.transform = 'translateY(-1px)';
          e.currentTarget.style.boxShadow = '0 4px 12px rgba(79, 70, 229, 0.4)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#312e81';
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = '0 2px 8px rgba(79, 70, 229, 0.25)';
        }}
      >
        <Sparkles size={14} color="#c084fc" />
        <span>AI Report</span>
        <ChevronRight size={13} color="#a5b4fc" />
      </button>
    </div>
  );
}

/**
 * MovableStudentFaceWidget (defaults to top-right corner of whiteboard)
 * Draggable anywhere on the canvas so tutor can position it freely.
 * Displays:
 * 1. Expressive StateFace SVG showing the rolling statistical mode over the last 15s.
 * 2. Mode affective state label with confidence / consistency percentage.
 * 3. Real-time instant expression indicator on hover.
 */
export function MovableStudentFaceWidget({ roomCode, socket, onOpenReport, initialX, initialY, role = 'tutor' }) {
  const [pulse, setPulse] = useState({
    engagement_score: 0,
    status_label: 'Waiting for Video',
    status_color: 'gray',
    attention_state: 'no_face',
    mode_expression: 'no_face',
    mode_color: 'gray',
    mode_label: 'Waiting for Video',
    mode_frequency_pct: 0,
    instant_expression: 'no_face',
    instant_color: 'gray',
    instant_label: 'No Face',
    student_face_detected: false,
    brow_furrow_level: 0.0,
    gaze_direction: 'unknown'
  });

  const [isHovered, setIsHovered] = useState(false);

  // Position & Draggable state (starts in top-right by default)
  const [pos, setPos] = useState(() => ({
    x: initialX !== undefined ? initialX : (typeof window !== 'undefined' ? Math.max(16, window.innerWidth - 240) : 900),
    y: initialY !== undefined ? initialY : 56
  }));
  const isDragging = useRef(false);
  const hasDraggedRef = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // Keep top-right alignment on window resize if user has not manually moved it
  useEffect(() => {
    const handleResize = () => {
      if (!hasDraggedRef.current) {
        setPos(p => ({ ...p, x: Math.max(16, window.innerWidth - 240) }));
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handlePointerDown = (e) => {
    if (e.target.closest('button')) return;
    isDragging.current = true;
    hasDraggedRef.current = true;
    setDragging(true);
    dragOffset.current = {
      x: e.clientX - pos.x,
      y: e.clientY - pos.y
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };

  const handlePointerMove = (e) => {
    if (!isDragging.current) return;
    const maxX = Math.max(10, window.innerWidth - (isHovered ? 290 : 230));
    const maxY = Math.max(50, window.innerHeight - 90);
    const nextX = Math.max(8, Math.min(maxX, e.clientX - dragOffset.current.x));
    const nextY = Math.max(52, Math.min(maxY, e.clientY - dragOffset.current.y));
    setPos({ x: nextX, y: nextY });
  };

  const handlePointerUp = (e) => {
    isDragging.current = false;
    setDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  };

  useEffect(() => {
    let isMounted = true;

    const handleMessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'engagement_pulse' && data.data) {
          if (isMounted) setPulse(data.data);
        }
      } catch {}
    };

    if (socket) {
      socket.addEventListener('message', handleMessage);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'request_engagement_pulse' }));
      }
    }

    const fetchPulse = async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/rooms/${roomCode}/engagement/`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted) setPulse(data);
        }
      } catch {}
    };

    fetchPulse();
    const interval = setInterval(fetchPulse, 2000);

    return () => {
      isMounted = false;
      clearInterval(interval);
      if (socket) socket.removeEventListener('message', handleMessage);
    };
  }, [roomCode, socket]);

  // Mode display parameters
  const modeColor = pulse.mode_color || pulse.status_color || 'gray';
  const modeState = pulse.mode_expression || pulse.attention_state || 'no_face';
  const modeLabel = pulse.mode_label || (modeState === 'confused' ? 'Confused' : modeState === 'engaged' ? 'Engaged & Attentive' : modeState === 'distracted' ? 'Looking Away' : 'Listening');

  const themeStyles = {
    green: { border: 'rgba(16, 185, 129, 0.55)', text: '#34d399', bg: 'rgba(6, 78, 59, 0.45)', glow: 'rgba(16, 185, 129, 0.35)' },
    red: { border: 'rgba(239, 68, 68, 0.65)', text: '#f87171', bg: 'rgba(69, 10, 10, 0.5)', glow: 'rgba(239, 68, 68, 0.45)' },
    yellow: { border: 'rgba(245, 158, 11, 0.55)', text: '#fbbf24', bg: 'rgba(69, 26, 3, 0.45)', glow: 'rgba(245, 158, 11, 0.35)' },
    blue: { border: 'rgba(14, 165, 233, 0.55)', text: '#38bdf8', bg: 'rgba(12, 74, 110, 0.45)', glow: 'rgba(14, 165, 233, 0.35)' },
    gray: { border: 'rgba(100, 116, 139, 0.4)', text: '#94a3b8', bg: 'rgba(30, 41, 59, 0.45)', glow: 'rgba(100, 116, 139, 0.2)' }
  }[modeColor] || { border: 'rgba(100, 116, 139, 0.4)', text: '#94a3b8', bg: 'rgba(30, 41, 59, 0.45)', glow: 'rgba(100, 116, 139, 0.2)' };

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      title="Drag to reposition student mood widget • Hover for instant metrics"
      style={{
        position: 'absolute',
        top: `${pos.y}px`,
        left: `${pos.x}px`,
        zIndex: 36,
        display: 'flex',
        flexDirection: isHovered ? 'column' : 'row',
        alignItems: isHovered ? 'flex-start' : 'center',
        gap: '8px',
        padding: '7px 12px',
        backgroundColor: 'rgba(15, 23, 42, 0.94)',
        backdropFilter: 'blur(14px)',
        borderRadius: '13px',
        border: `1.5px solid ${themeStyles.border}`,
        boxShadow: dragging
          ? `0 14px 32px rgba(0, 0, 0, 0.7), 0 0 20px ${themeStyles.glow}`
          : `0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px ${themeStyles.glow}`,
        cursor: dragging ? 'grabbing' : 'grab',
        transition: dragging ? 'none' : 'box-shadow 0.2s ease, border-color 0.2s ease',
        userSelect: 'none',
        maxWidth: isHovered ? '280px' : '230px',
        touchAction: 'none'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
        {/* Drag handle grip */}
        <div style={{ display: 'flex', alignItems: 'center', color: '#64748b' }}>
          <GripVertical size={13} />
        </div>

        {/* SVG Mode Face */}
        <StateFace
          statusColor={modeColor}
          attentionState={modeState}
          isFaceDetected={pulse.student_face_detected}
        />

        {/* Mode Label & Frequency */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px' }}>
            <span style={{ fontSize: '9px', fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {role === 'student' ? 'Your Emotion' : 'Student Emotion'}
            </span>
            {pulse.student_face_detected && pulse.mode_frequency_pct > 0 && (
              <span style={{ fontSize: '9px', fontWeight: 700, color: themeStyles.text }}>
                {pulse.mode_frequency_pct}%
              </span>
            )}
          </div>
          <span style={{
            fontSize: '12px',
            fontWeight: 700,
            color: themeStyles.text,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}>
            {pulse.student_face_detected ? modeLabel : 'Waiting for Video'}
          </span>
        </div>
      </div>

      {/* Expanded Hover Detail */}
      {isHovered && pulse.student_face_detected && (
        <div style={{
          width: '100%',
          marginTop: '4px',
          paddingTop: '6px',
          borderTop: '1px solid rgba(51, 65, 85, 0.7)',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          fontSize: '11px',
          color: '#cbd5e1'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Instant State:</span>
            <span style={{ fontWeight: 600, color: pulse.instant_color === 'red' ? '#f87171' : pulse.instant_color === 'green' ? '#34d399' : '#38bdf8' }}>
              {pulse.instant_label || 'Neutral'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Brow Furrow:</span>
            <span style={{ fontWeight: 600 }}>{Math.round((pulse.brow_furrow_level || 0) * 100)}%</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Gaze:</span>
            <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{pulse.gaze_direction || 'Forward'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8' }}>Comprehension:</span>
            <span style={{ fontWeight: 600, color: '#38bdf8' }}>{pulse.engagement_score || 80}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Preserve alias for backward compatibility
export const TopLeftRollingFaceWidget = MovableStudentFaceWidget;
