import React, { useState } from 'react';
import { BookOpen, X, Sparkles, ChevronRight, CheckCircle2, AlertCircle, Clock } from 'lucide-react';

/**
 * CoachNotebook
 * Right-edge collapsible tab and drawer for the tutor.
 * - Tab: Sits quietly on the right border with an unread badge ("📓 2").
 * - Drawer: Opens on tap without obstructing the lesson, showing a chronological timeline
 *   and top takeaways.
 */
export default function CoachNotebook({
  isOpen,
  onToggle,
  entries = [],
  topTakeaways = [],
  onOpenFullReport,
  onApplyExample
}) {
  const unreadCount = entries.filter(e => !e.read).length;

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
          {unreadCount > 0 && (
            <span style={{
              width: '18px',
              height: '18px',
              borderRadius: '50%',
              backgroundColor: '#ef4444',
              color: '#ffffff',
              fontSize: '10px',
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 8px rgba(239, 68, 68, 0.6)'
            }}>
              {unreadCount}
            </span>
          )}
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
                  Live observations & timeline
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
            {/* Top Takeaways Block */}
            <div style={{
              backgroundColor: '#1e293b',
              borderRadius: '10px',
              padding: '14px',
              border: '1px solid #334155'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <Sparkles size={14} color="#a855f7" />
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#c084fc', textTransform: 'uppercase' }}>
                  Top Takeaways
                </span>
              </div>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#e2e8f0', lineHeight: 1.5 }}>
                {topTakeaways.length > 0 ? (
                  topTakeaways.map((t, idx) => (
                    <li key={idx} style={{ marginBottom: '6px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ flex: 1 }}>{t}</span>
                      {onApplyExample && (
                        <button
                          onClick={() => {
                            const isFraction = t.toLowerCase().includes('fraction') || t.toLowerCase().includes('pizza');
                            const isNumberLine = t.toLowerCase().includes('number line');
                            const exampleType = isFraction ? 'fraction_pizza' : (isNumberLine ? 'number_line' : 'nudge_hint');
                            onApplyExample(exampleType, {
                              title: '💡 Takeaway Visual Scaffold',
                              toast_text: t,
                              action_label: 'Explore visual representation'
                            });
                          }}
                          title="Drop visual scaffold onto whiteboard"
                          style={{
                            padding: '2px 7px',
                            borderRadius: '5px',
                            backgroundColor: '#059669',
                            color: '#ffffff',
                            fontSize: '10px',
                            fontWeight: 700,
                            border: 'none',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            boxShadow: '0 1px 3px rgba(5, 150, 105, 0.3)'
                          }}
                        >
                          ✋ Drop
                        </button>
                      )}
                    </li>
                  ))
                ) : (
                  <>
                    <li style={{ marginBottom: '4px' }}>Fractions division: Favor visual representations (pizza, number line).</li>
                    <li>Student responds rapidly when given a concrete example first.</li>
                  </>
                )}
              </ul>
            </div>

            {/* Timeline Log */}
            <div>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '10px' }}>
                Session Timeline ({entries.length})
              </div>

              {entries.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px 10px', color: '#64748b', fontSize: '12px' }}>
                  No alerts or nudges yet. The session is quiet and running smoothly.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {entries.map((entry, idx) => {
                    const isT3 = entry.tier === 'T3';
                    const isT2 = entry.tier === 'T2';
                    const icon = isT3 ? '🔴' : isT2 ? '🟡' : '🟢';
                    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

                    return (
                      <div
                        key={idx}
                        style={{
                          backgroundColor: '#1e293b',
                          borderRadius: '8px',
                          padding: '10px 12px',
                          border: `1px solid ${isT3 ? 'rgba(239, 68, 68, 0.3)' : 'rgba(51, 65, 85, 0.7)'}`,
                          fontSize: '12px',
                          color: '#f8fafc',
                          lineHeight: 1.4
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                          <span style={{ fontWeight: 600, color: isT3 ? '#fca5a5' : isT2 ? '#fde68a' : '#86efac' }}>
                            {icon} {entry.category || 'Observation'}
                          </span>
                          <span style={{ fontSize: '10px', color: '#64748b' }}>{time}</span>
                        </div>
                        <div style={{ color: '#cbd5e1' }}>
                          {entry.text}
                        </div>
                        {entry.suggestion ? (
                          <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                            <div style={{ fontSize: '11px', color: '#38bdf8', fontStyle: 'italic', flex: 1 }}>
                              💡 {entry.suggestion}
                            </div>
                            {onApplyExample && (
                              <button
                                onClick={() => onApplyExample(entry.example_type || 'nudge_hint', {
                                  title: `💡 Coach Tip: ${entry.category || 'Guidance'}`,
                                  action_label: entry.suggestion,
                                  toast_text: entry.text,
                                  ...entry
                                })}
                                title="Drop this guidance onto whiteboard as a draggable card"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '3px',
                                  padding: '3px 8px',
                                  borderRadius: '5px',
                                  backgroundColor: '#059669',
                                  color: '#ffffff',
                                  fontSize: '10.5px',
                                  fontWeight: 700,
                                  border: 'none',
                                  cursor: 'pointer',
                                  whiteSpace: 'nowrap',
                                  boxShadow: '0 1px 4px rgba(5, 150, 105, 0.3)'
                                }}
                              >
                                <span>✋ Drop</span>
                              </button>
                            )}
                          </div>
                        ) : onApplyExample && (
                          <div style={{ marginTop: '6px', display: 'flex', justifyContent: 'flex-end' }}>
                            <button
                              onClick={() => onApplyExample(entry.example_type || 'nudge_hint', {
                                title: `💡 Coach Observation: ${entry.category || 'Note'}`,
                                toast_text: entry.text,
                                ...entry
                              })}
                              title="Drop this observation onto whiteboard as a draggable card"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '3px',
                                padding: '2px 7px',
                                borderRadius: '5px',
                                backgroundColor: '#334155',
                                color: '#e2e8f0',
                                fontSize: '10px',
                                fontWeight: 600,
                                border: '1px solid #475569',
                                cursor: 'pointer',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              <span>✋ Drop Note</span>
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
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
