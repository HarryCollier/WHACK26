import React, { useState, useEffect } from 'react';
import { BookOpen, X, Sparkles, ChevronRight, CheckCircle2, AlertCircle, Clock, CheckCircle, AlertTriangle } from 'lucide-react';

/**
 * CoachNotebook
 * Right-edge collapsible tab and drawer for the tutor.
 * - Tab: Sits quietly on the right border.
 * - Drawer: Opens on tap without obstructing the lesson.
 * - Live Coach Notes: Displays 2 Positives & 2 Negatives updated in real-time every 2 minutes.
 */
export default function CoachNotebook({
  isOpen,
  onToggle,
  coachNotes = null,
  onOpenFullReport,
  onApplyExample
}) {
  const [timeTick, setTimeTick] = useState(Date.now());

  // Periodically re-render relative time label
  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => setTimeTick(Date.now()), 10000);
    return () => clearInterval(interval);
  }, [isOpen]);

  const getTimeAgo = (ts) => {
    if (!ts) return 'Awaiting first 2m sync';
    const diffSec = Math.floor((Date.now() - ts) / 1000);
    if (diffSec < 15) return 'Just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const mins = Math.floor(diffSec / 60);
    return `${mins}m ago`;
  };

  const positives = coachNotes?.positives?.length > 0
    ? coachNotes.positives.slice(0, 2)
    : [
        'Balanced conversational tone with responsive pupil participation.',
        'Whiteboard workspace actively initialized for shared learning.'
      ];

  const negatives = coachNotes?.negatives?.length > 0
    ? coachNotes.negatives.slice(0, 2)
    : [
        'Ensure wait time of 3–5 seconds after asking questions to prevent rushing.',
        'Encourage the student to write their own intermediate steps on the canvas.'
      ];

  return (
    <>
      {/* 1. Right-edge Collapsed Tab Pill */}
      {!isOpen && (
        <button
          onClick={onToggle}
          title="Open Coach Notebook"
          style={{
            position: 'absolute',
            top: '50%',
            right: 0,
            transform: 'translateY(-50%)',
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRight: 'none',
            borderRadius: '10px 0 0 10px',
            padding: '10px 8px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '6px',
            cursor: 'pointer',
            zIndex: 40,
            boxShadow: '-4px 4px 16px rgba(0,0,0,0.4)',
            transition: 'all 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#334155';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#1e293b';
          }}
        >
          <span style={{ fontSize: '16px' }}>📓</span>
          <span style={{
            writingMode: 'vertical-rl',
            textOrientation: 'mixed',
            fontSize: '11px',
            fontWeight: 700,
            color: '#cbd5e1',
            letterSpacing: '0.05em'
          }}>
            NOTEBOOK
          </span>
        </button>
      )}

      {/* 2. Slide-out Notebook Drawer */}
      {isOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: '380px',
          backgroundColor: '#0f172a',
          borderLeft: '1px solid #334155',
          boxShadow: '-8px 0 32px rgba(0, 0, 0, 0.7)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          animation: 'slideInRight 0.2s ease-out'
        }}>
          {/* Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            backgroundColor: '#1e293b',
            borderBottom: '1px solid #334155'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '20px' }}>📓</span>
              <div>
                <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                  Coach Notebook
                </h3>
                <p style={{ fontSize: '11px', color: '#94a3b8', margin: '2px 0 0 0' }}>
                  Live observations & notes
                </p>
              </div>
            </div>

            <button
              onClick={onToggle}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '6px',
                borderRadius: '6px'
              }}
            >
              <X size={18} />
            </button>
          </div>

          {/* Body Content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            
            {/* Live Coach Notes: 2 Positives & 2 Negatives (Updated every 2 min) */}
            <div style={{
              backgroundColor: '#1e293b',
              borderRadius: '12px',
              padding: '14px',
              border: '1px solid #334155',
              boxShadow: '0 4px 14px rgba(0,0,0,0.25)'
            }}>
              {/* Header with 2m live sync badge */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Sparkles size={14} color="#a855f7" />
                  <span style={{ fontSize: '11px', fontWeight: 800, color: '#c084fc', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Live Coach Notes
                  </span>
                </div>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  backgroundColor: 'rgba(16, 185, 129, 0.15)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  borderRadius: '12px',
                  padding: '2px 8px',
                  fontSize: '10px',
                  color: '#6ee7b7',
                  fontWeight: 600
                }}>
                  <span style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: '#10b981',
                    boxShadow: '0 0 6px #10b981'
                  }} />
                  <span>2m Sync • {getTimeAgo(coachNotes?.lastUpdated)}</span>
                </div>
              </div>

              {/* 🟢 2 Positives */}
              <div style={{ marginBottom: '12px' }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: '#4ade80',
                  textTransform: 'uppercase',
                  marginBottom: '6px',
                  letterSpacing: '0.03em'
                }}>
                  <CheckCircle2 size={13} color="#4ade80" />
                  <span>2 Positives (What's Going Well)</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {positives.map((text, idx) => (
                    <div
                      key={`pos_${idx}`}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '8px',
                        backgroundColor: 'rgba(16, 185, 129, 0.08)',
                        border: '1px solid rgba(16, 185, 129, 0.25)',
                        borderRadius: '8px',
                        padding: '8px 10px',
                        fontSize: '12px',
                        color: '#f0fdf4',
                        lineHeight: 1.4
                      }}
                    >
                      <span style={{ color: '#22c55e', fontSize: '12px', fontWeight: 700, flexShrink: 0 }}>✓</span>
                      <span style={{ flex: 1 }}>{text}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 🔴 2 Negatives / Friction Points */}
              <div>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: '#f87171',
                  textTransform: 'uppercase',
                  marginBottom: '6px',
                  letterSpacing: '0.03em'
                }}>
                  <AlertCircle size={13} color="#f87171" />
                  <span>2 Areas to Improve (Needs Attention)</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {negatives.map((text, idx) => (
                    <div
                      key={`neg_${idx}`}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '8px',
                        backgroundColor: 'rgba(239, 68, 68, 0.08)',
                        border: '1px solid rgba(239, 68, 68, 0.28)',
                        borderRadius: '8px',
                        padding: '8px 10px',
                        fontSize: '12px',
                        color: '#fef2f2',
                        lineHeight: 1.4
                      }}
                    >
                      <span style={{ color: '#ef4444', fontSize: '12px', fontWeight: 700, flexShrink: 0 }}>!</span>
                      <span style={{ flex: 1 }}>{text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

          </div>

          {/* Footer */}
          <div style={{
            padding: '14px 20px',
            backgroundColor: '#1e293b',
            borderTop: '1px solid #334155',
            display: 'flex',
            justifyContent: 'center'
          }}>
            <button
              onClick={onOpenFullReport}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                width: '100%',
                justifyContent: 'center',
                padding: '8px',
                borderRadius: '8px',
                backgroundColor: '#312e81',
                color: '#e0e7ff',
                border: '1px solid #4338ca',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <Sparkles size={14} color="#a855f7" />
              <span>Open Full Session Report</span>
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
