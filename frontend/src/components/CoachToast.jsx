import React, { useEffect, useState } from 'react';
import { Sparkles, X, Clock, Check, ArrowRight } from 'lucide-react';

/**
 * CoachToast
 * A compact, non-blocking toast banner taking up ~1/8th of the whiteboard canvas height.
 * - T2: Glanceable action toast (auto-dismisses in 4 seconds with countdown bar).
 * - T3: Persistent nudge for sustained confusion (≥10s) or repeated mistakes (stays until tapped).
 * - Primary Action: "Drop on Board" triggers instant visual diagram on the shared whiteboard.
 */
export default function CoachToast({
  toast,
  onApplyExample,
  onDismiss,
  onSnooze
}) {
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    if (!toast) return;

    // T2 auto-dismisses after 4 seconds
    if (toast.tier === 'T2') {
      const startTime = Date.now();
      const duration = 4000;
      const interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const remainingPct = Math.max(0, 100 - (elapsed / duration) * 100);
        setProgress(remainingPct);
        if (elapsed >= duration) {
          clearInterval(interval);
          onDismiss();
        }
      }, 50);

      return () => clearInterval(interval);
    } else {
      setProgress(100);
    }
  }, [toast, onDismiss]);

  if (!toast) return null;

  const isT3 = toast.tier === 'T3';
  const borderColor = isT3 ? '#ef4444' : '#f59e0b';
  const glowColor = isT3 ? 'rgba(239, 68, 68, 0.45)' : 'rgba(245, 158, 11, 0.35)';

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '24px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'clamp(380px, 60vw, 680px)',
        height: 'clamp(64px, 12vh, 80px)', // Approx 1/8th of whiteboard height
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        backdropFilter: 'blur(16px)',
        borderRadius: '14px',
        border: `1.5px solid ${borderColor}`,
        boxShadow: `0 12px 32px rgba(0, 0, 0, 0.6), 0 0 20px ${glowColor}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        gap: '14px',
        zIndex: 45,
        overflow: 'hidden',
        animation: 'fadeInUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
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
            backgroundColor: '#f59e0b',
            transition: 'width 0.05s linear'
          }}
        />
      )}

      {/* Left: Icon & Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
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
          {toast.example_type?.includes('pizza') ? '🍕' : isT3 ? '⚠️' : '💡'}
        </div>

        {/* Text */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
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
              {isT3 ? '10s sustained confusion' : 'Actionable suggestion'}
            </span>
          </div>

          <span
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: '#f8fafc',
              lineHeight: 1.3,
              marginTop: '2px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {toast.toast_text || 'Student stuck on fractions — try a pizza-slice example?'}
          </span>
        </div>
      </div>

      {/* Right: Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        {/* Primary Action Button: Drop on Board */}
        <button
          onClick={() => onApplyExample(toast.example_type || 'fraction_pizza')}
          title="Draw example directly on whiteboard canvas"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '7px 14px',
            borderRadius: '8px',
            backgroundColor: '#059669',
            color: '#ffffff',
            fontSize: '12px',
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
          <span>{toast.action_label || '🍕 Drop on Board'}</span>
          <ArrowRight size={13} />
        </button>

        {/* Snooze 2m (for T3) */}
        {isT3 && onSnooze && (
          <button
            onClick={onSnooze}
            title="Snooze alert for 2 minutes"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '6px 10px',
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

        {/* Dismiss Button */}
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
      </div>
    </div>
  );
}
