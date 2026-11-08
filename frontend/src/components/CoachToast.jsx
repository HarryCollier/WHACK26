import React, { useEffect, useState } from 'react';
import { Sparkles, X, Clock, Check, ArrowRight } from 'lucide-react';

/**
 * CoachToast
 * A compact, non-blocking toast banner taking up ~1/8th of the whiteboard canvas height.
 * - T2: Glanceable action toast (auto-dismisses in 4 seconds with countdown bar).
 * - T3: Persistent nudge for majority confusion (>50% over 6s) or repeated mistakes (stays until tapped).
 * - Primary Action: "Drop on Board" triggers instant visual diagram on the shared whiteboard.
 */
export default function CoachToast({
  toast,
  onApplyExample,
  onDismiss,
  onSnooze
}) {
  const [progress, setProgress] = useState(100);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    if (!toast) return;

    // T2 auto-dismisses after 4 seconds, but pauses whenever hovered
    if (toast.tier === 'T2') {
      if (isHovered) return; // Pause countdown while hovering

      const startTime = Date.now();
      const currentProgress = progress;
      const totalDuration = 4000;

      const interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const remainingPct = Math.max(0, currentProgress - (elapsed / totalDuration) * 100);
        setProgress(remainingPct);
        if (remainingPct <= 0) {
          clearInterval(interval);
          onDismiss();
        }
      }, 50);

      return () => clearInterval(interval);
    } else {
      setProgress(100);
    }
  }, [toast, onDismiss, isHovered]);

  if (!toast) return null;

  const isT3 = toast.tier === 'T3';
  const borderColor = isT3 ? '#ef4444' : '#f59e0b';
  const glowColor = isT3 ? 'rgba(239, 68, 68, 0.45)' : 'rgba(245, 158, 11, 0.35)';

  const iconEmoji = toast.example_type?.includes('pizza')
    ? '🍕'
    : toast.example_type?.includes('place_value')
    ? '🔢'
    : toast.example_type?.includes('circle')
    ? '⭕'
    : toast.example_type?.includes('rect')
    ? '📐'
    : toast.example_type?.includes('number_line')
    ? '📏'
    : isT3 ? '⚠️' : '💡';

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        position: 'absolute',
        bottom: '24px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: isHovered ? 'clamp(440px, 65vw, 760px)' : 'clamp(380px, 60vw, 680px)',
        height: isHovered ? 'auto' : 'clamp(64px, 12vh, 80px)',
        minHeight: '64px',
        backgroundColor: 'rgba(15, 23, 42, 0.97)',
        backdropFilter: 'blur(16px)',
        borderRadius: isHovered ? '16px' : '14px',
        border: `1.5px solid ${borderColor}`,
        boxShadow: `0 16px 36px rgba(0, 0, 0, 0.65), 0 0 24px ${glowColor}`,
        display: 'flex',
        flexDirection: isHovered ? 'column' : 'row',
        alignItems: isHovered ? 'stretch' : 'center',
        justifyContent: isHovered ? 'flex-start' : 'space-between',
        padding: isHovered ? '14px 18px' : '0 16px',
        gap: isHovered ? '10px' : '14px',
        zIndex: 45,
        overflow: 'hidden',
        animation: 'fadeInUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        transition: 'all 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        userSelect: 'none'
      }}
    >
      {/* T2 Progress bar countdown */}
      {toast.tier === 'T2' && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            height: '3px',
            width: `${progress}%`,
            backgroundColor: isHovered ? '#38bdf8' : '#f59e0b',
            transition: 'width 0.05s linear, background-color 0.2s ease'
          }}
        />
      )}

      {/* When Hovered: Expanded Header Row */}
      {isHovered ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: isT3 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                border: `1px solid ${borderColor}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '16px'
              }}
            >
              {iconEmoji}
            </div>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 800,
                padding: '2px 6px',
                borderRadius: '4px',
                backgroundColor: isT3 ? '#991b1b' : '#92400e',
                color: '#ffffff',
                textTransform: 'uppercase',
                letterSpacing: '0.04em'
              }}
            >
              {isT3 ? 'Nudge' : 'Quick Tip'}
            </span>
            <span style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 600 }}>
              {toast.context_badge || 'Pedagogical Recommendation'}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '10px', color: '#94a3b8', fontStyle: 'italic' }}>
              ⏸️ Auto-dismiss paused
            </span>
            <button
              onClick={onDismiss}
              title="Dismiss notification"
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '4px',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center'
              }}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      ) : null}

      {/* Main Toast Content */}
      <div style={{ display: 'flex', alignItems: isHovered ? 'flex-start' : 'center', gap: '10px', minWidth: 0, flex: 1 }}>
        {!isHovered && (
          <div
            style={{
              width: '38px',
              height: '38px',
              borderRadius: '10px',
              backgroundColor: isT3 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(245, 158, 11, 0.2)',
              border: `1px solid ${borderColor}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '18px',
              flexShrink: 0
            }}
          >
            {iconEmoji}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          {!isHovered && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 800,
                  padding: '1px 5px',
                  borderRadius: '4px',
                  backgroundColor: isT3 ? '#991b1b' : '#92400e',
                  color: '#ffffff',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em'
                }}
              >
                {isT3 ? 'Nudge' : 'Quick Tip'}
              </span>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                {toast.context_badge || (isT3 ? 'Majority confusion (6s)' : 'Actionable suggestion')}
              </span>
            </div>
          )}

          <span
            style={{
              fontSize: isHovered ? '14px' : '13px',
              fontWeight: 600,
              color: '#f8fafc',
              lineHeight: 1.4,
              marginTop: isHovered ? '0px' : '2px',
              whiteSpace: isHovered ? 'normal' : 'nowrap',
              overflow: isHovered ? 'visible' : 'hidden',
              textOverflow: isHovered ? 'clip' : 'ellipsis'
            }}
          >
            {toast.toast_text || 'Student stuck on problem — suggest visual breakdown?'}
          </span>

          {/* Stepping Stone & Counter-Example Pills */}
          {(toast.stepping_stone || toast.counter_example) && (
            <div style={{ display: 'flex', flexDirection: isHovered ? 'column' : 'row', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
              {toast.stepping_stone && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  backgroundColor: 'rgba(2, 132, 199, 0.25)',
                  border: '1px solid rgba(56, 189, 248, 0.4)',
                  borderRadius: '6px',
                  padding: '2px 8px',
                  fontSize: '11px',
                  color: '#bae6fd',
                  fontWeight: 600
                }}>
                  <span>💡</span>
                  <span>{toast.stepping_stone}</span>
                </div>
              )}
              {isHovered && toast.counter_example && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  backgroundColor: 'rgba(168, 85, 247, 0.2)',
                  border: '1px solid rgba(192, 132, 252, 0.35)',
                  borderRadius: '6px',
                  padding: '2px 8px',
                  fontSize: '11px',
                  color: '#e9d5ff',
                  fontWeight: 500
                }}>
                  <span>🔍</span>
                  <span>{toast.counter_example}</span>
                </div>
              )}
            </div>
          )}

          {/* Expanded Detail / Pedagogical Context on Hover */}
          {isHovered && toast.reasoning && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px 12px',
                borderRadius: '8px',
                backgroundColor: 'rgba(30, 41, 59, 0.85)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                fontSize: '12px',
                color: '#cbd5e1',
                lineHeight: 1.45
              }}
            >
              <div style={{ color: '#93c5fd', fontWeight: 700, marginBottom: '2px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                Pedagogical Insight
              </div>
              <div>{toast.reasoning}</div>
            </div>
          )}
        </div>
      </div>

      {/* Actions (Drop on Board, Drop Stepping Stone, Snooze, Dismiss) */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: isHovered ? 'flex-end' : 'flex-end',
        gap: '8px',
        flexShrink: 0,
        marginTop: isHovered ? '4px' : '0px'
      }}>
        {/* Optional Secondary Action: Drop Stepping Stone directly onto canvas */}
        {toast.stepping_stone && (
          <button
            onClick={() => onApplyExample({ type: 'stepping_stone_text', text: toast.stepping_stone })}
            title="Write stepping stone question directly onto whiteboard"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              padding: isHovered ? '8px 14px' : '6px 12px',
              borderRadius: '8px',
              backgroundColor: '#0284c7',
              color: '#ffffff',
              fontSize: isHovered ? '12px' : '11px',
              fontWeight: 700,
              border: 'none',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(2, 132, 199, 0.35)',
              transition: 'all 0.15s ease',
              whiteSpace: 'nowrap'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#0369a1';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#0284c7';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            <span>📝 Drop Example</span>
          </button>
        )}

        {/* Primary Action Button: Drop on Board */}
        <button
          onClick={() => onApplyExample(toast.custom_diagram || toast.example_type || 'fraction_pizza', toast)}
          title="Draw example directly on whiteboard canvas as a draggable card"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: isHovered ? '8px 16px' : '7px 14px',
            borderRadius: '8px',
            backgroundColor: '#059669',
            color: '#ffffff',
            fontSize: isHovered ? '13px' : '12px',
            fontWeight: 700,
            border: 'none',
            cursor: 'pointer',
            boxShadow: '0 2px 10px rgba(5, 150, 105, 0.4)',
            transition: 'all 0.15s ease',
            whiteSpace: 'nowrap'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#10b981';
            e.currentTarget.style.transform = 'translateY(-1px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#059669';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          <span>{toast.action_label || '📐 Drop on Board'}</span>
          <ArrowRight size={13} />
        </button>

        {/* Snooze 2m */}
        {onSnooze && (
          <button
            onClick={onSnooze}
            title="Snooze alert for 2 minutes"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: isHovered ? '8px 12px' : '6px 10px',
              borderRadius: '8px',
              backgroundColor: '#1e293b',
              color: '#94a3b8',
              fontSize: '11px',
              fontWeight: 600,
              border: '1px solid #334155',
              cursor: 'pointer'
            }}
          >
            <Clock size={12} />
            <span>2m</span>
          </button>
        )}

        {/* Dismiss Button (only shown in compact mode here since expanded mode has it in header) */}
        {!isHovered && (
          <button
            onClick={onDismiss}
            title="Dismiss notification"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '6px',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center'
            }}
          >
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
