import React, { useState, useEffect, useRef } from 'react';
import { Activity, X, RefreshCw, Layers, Video, Mic, Brain, MessageSquare, Eye, PenTool } from 'lucide-react';

// ── Colour helpers ─────────────────────────────────────────────────────────
const ROLE_COLOUR = { tutor: '#38bdf8', student: '#4ade80' };
const ENGAGEMENT_COLOUR = { engaged: '#22c55e', neutral: '#facc15', distracted: '#ef4444', unknown: '#64748b' };
const CHANGE_COLOUR = { none: '#475569', minor: '#facc15', moderate: '#f97316', major: '#ef4444' };

function Badge({ label, color }) {
  return (
    <span style={{
      fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
      backgroundColor: color + '22', color, border: `1px solid ${color}44`
    }}>
      {label}
    </span>
  );
}

function SectionCard({ children, style }) {
  return (
    <div style={{
      padding: '12px', backgroundColor: '#0f172a', borderRadius: '8px',
      border: '1px solid #334155', ...style
    }}>
      {children}
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
      {children}
    </div>
  );
}

// ── Tab: Live Stats (existing diagnostics) ────────────────────────────────
function StatsTab({ stats }) {
  if (!stats) return <span style={{ color: '#64748b', fontSize: '13px' }}>Loading…</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
        <SectionCard>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#38bdf8', fontSize: '11px', marginBottom: '5px' }}>
            <Video size={12} /><span>Video (0.5s)</span>
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc' }}>
            {(stats.video_frames.tutor_count || 0) + (stats.video_frames.student_count || 0)}
          </div>
          <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '3px' }}>
            T: {stats.video_frames.tutor_count} | S: {stats.video_frames.student_count}
          </div>
        </SectionCard>
        <SectionCard>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#a855f7', fontSize: '11px', marginBottom: '5px' }}>
            <Layers size={12} /><span>Whiteboard</span>
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc' }}>{stats.whiteboard.history_count}</div>
          <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '3px' }}>
            {stats.whiteboard.has_most_recent ? 'Active' : 'Empty'}
          </div>
        </SectionCard>
        <SectionCard>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#22c55e', fontSize: '11px', marginBottom: '5px' }}>
            <Mic size={12} /><span>Transcripts</span>
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc' }}>{stats.transcripts.length}</div>
          <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '3px' }}>Whisper processed</div>
        </SectionCard>
      </div>

      {/* Peers */}
      <SectionCard>
        <SectionTitle>Active Peers ({stats.active_peers.length})</SectionTitle>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {stats.active_peers.map((p, i) => (
            <span key={i} style={{ fontSize: '11px', padding: '2px 7px', borderRadius: '4px', backgroundColor: '#334155', color: '#f8fafc' }}>{p}</span>
          ))}
        </div>
      </SectionCard>

      {/* Transcripts */}
      <SectionCard>
        <SectionTitle>Transcript Log</SectionTitle>
        <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {stats.transcripts.length === 0
            ? <span style={{ fontSize: '12px', color: '#64748b' }}>No speech recorded yet.</span>
            : stats.transcripts.map((t, i) => (
              <div key={i} style={{ fontSize: '12px', color: '#cbd5e1' }}>
                <span style={{ color: ROLE_COLOUR[t.role] || '#94a3b8', fontWeight: 700 }}>[{(t.role || '?').toUpperCase()}]</span>{' '}{t.text}
              </div>
            ))}
        </div>
      </SectionCard>
    </div>
  );
}

// ── Tab: LLM Payload ──────────────────────────────────────────────────────
function TelemetryTab({ telemetry, loading }) {
  const [section, setSection] = useState('dialogue');

  if (loading && !telemetry) {
    return <span style={{ color: '#64748b', fontSize: '13px' }}>Loading telemetry…</span>;
  }
  if (!telemetry) {
    return <span style={{ color: '#64748b', fontSize: '13px' }}>No telemetry yet — join a call and speak first.</span>;
  }

  const subTabs = [
    { id: 'dialogue', label: 'Dialogue', icon: <MessageSquare size={12} /> },
    { id: 'video', label: 'Video', icon: <Eye size={12} /> },
    { id: 'whiteboard', label: 'Whiteboard', icon: <PenTool size={12} /> },
    { id: 'prompt', label: 'LLM Prompt', icon: <Brain size={12} /> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Meta bar */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge label={`Room ${telemetry.room_code}`} color="#38bdf8" />
        <Badge label={`Duration: ${telemetry.session_duration_label}`} color="#a855f7" />
        <Badge label={`${telemetry.dialogue_timeline?.length || 0} utterances`} color="#22c55e" />
      </div>

      {/* Sub-tab strip */}
      <div style={{ display: 'flex', gap: '4px' }}>
        {subTabs.map(t => (
          <button key={t.id} onClick={() => setSection(t.id)} style={{
            display: 'flex', alignItems: 'center', gap: '4px',
            padding: '5px 10px', borderRadius: '5px', fontSize: '11px', fontWeight: 600,
            backgroundColor: section === t.id ? '#1e40af' : '#1e293b',
            color: section === t.id ? '#bfdbfe' : '#94a3b8',
            border: section === t.id ? '1px solid #3b82f6' : '1px solid #334155',
            cursor: 'pointer',
          }}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* Section content */}
      {section === 'dialogue' && <DialogueSection timeline={telemetry.dialogue_timeline} />}
      {section === 'video' && <VideoSection video={telemetry.video_telemetry} />}
      {section === 'whiteboard' && <WhiteboardSection wb={telemetry.whiteboard_telemetry} />}
      {section === 'prompt' && <PromptSection text={telemetry.llm_prompt_context} />}
    </div>
  );
}

function DialogueSection({ timeline }) {
  if (!timeline || timeline.length === 0) {
    return <SectionCard><span style={{ color: '#64748b', fontSize: '12px' }}>No dialogue recorded yet.</span></SectionCard>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '340px', overflowY: 'auto' }}>
      {timeline.map((entry, i) => {
        const af = entry.acoustic_features;
        const hasAcoustic = af && !af.error;
        return (
          <SectionCard key={i}>
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'monospace' }}>{entry.time_label}</span>
              <Badge label={entry.role.toUpperCase()} color={ROLE_COLOUR[entry.role] || '#94a3b8'} />
              {hasAcoustic && <Badge label={`conf: ${af.confidence_signal}`} color={af.confidence_signal === 'high' ? '#22c55e' : af.confidence_signal === 'medium' ? '#facc15' : '#ef4444'} />}
              {hasAcoustic && af.pause_count > 0 && <Badge label={`${af.pause_count} pause${af.pause_count !== 1 ? 's' : ''}`} color="#f97316" />}
            </div>
            {/* Speech */}
            <div style={{ fontSize: '13px', color: '#e2e8f0', marginBottom: hasAcoustic ? '6px' : '0' }}>
              "{entry.speech}"
            </div>
            {/* Acoustic detail */}
            {hasAcoustic && (
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                {af.pitch_mean_hz > 0 && <Metric label="Pitch" value={`${af.pitch_mean_hz.toFixed(0)} Hz`} />}
                {af.rms_mean != null && <Metric label="Loudness" value={af.rms_mean.toFixed(4)} />}
                {af.energy_variance != null && <Metric label="Energy var" value={af.energy_variance.toExponential(1)} />}
                {af.pause_total_sec > 0 && <Metric label="Pause" value={`${af.pause_total_sec}s`} />}
                {af.speaking_rate_wpm && <Metric label="WPM" value={af.speaking_rate_wpm} />}
              </div>
            )}
          </SectionCard>
        );
      })}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div style={{ fontSize: '10px', color: '#94a3b8' }}>
      <span style={{ color: '#64748b' }}>{label}: </span>
      <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>{value}</span>
    </div>
  );
}

function VideoSection({ video }) {
  if (!video) return <SectionCard><span style={{ color: '#64748b', fontSize: '12px' }}>No video data.</span></SectionCard>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '340px', overflowY: 'auto' }}>
      {['tutor', 'student'].map(role => {
        const vt = video[role];
        if (!vt) return null;
        const engAvg = vt.engagement_avg;
        const engColor = engAvg == null ? '#64748b' : engAvg >= 0.65 ? '#22c55e' : engAvg >= 0.40 ? '#facc15' : '#ef4444';
        return (
          <SectionCard key={role}>
            {/* Header with Role, Attention state, and Engagement Bar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: ROLE_COLOUR[role] }}>{role.toUpperCase()}</span>
                {vt.current_attention && (
                  <Badge label={vt.current_attention.toUpperCase()} color={vt.current_attention === 'focused' || vt.current_attention === 'engaged_happy' ? '#22c55e' : vt.current_attention === 'reading_board' ? '#38bdf8' : vt.current_attention === 'confused' ? '#f59e0b' : '#ef4444'} />
                )}
              </div>
              {engAvg != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '10px', color: '#94a3b8' }}>Engagement:</span>
                  <div style={{ width: '80px', height: '6px', borderRadius: '3px', backgroundColor: '#1e293b', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, Math.max(5, engAvg * 100))}%`, height: '100%', backgroundColor: engColor, borderRadius: '3px' }} />
                  </div>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: engColor }}>{(engAvg * 100).toFixed(0)}%</span>
                </div>
              )}
            </div>

            {/* Comprehensive Metrics Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginBottom: '8px', backgroundColor: '#020617', padding: '8px', borderRadius: '6px' }}>
              <Metric label="Frames (analyzed/total)" value={`${vt.frames_analysed} / ${vt.frames_captured}`} />
              {vt.head_yaw_avg != null && <Metric label="Head Yaw (L/R)" value={`${vt.head_yaw_avg.toFixed(1)}°`} />}
              {vt.head_pitch_avg != null && <Metric label="Head Pitch (U/D)" value={`${vt.head_pitch_avg.toFixed(1)}°`} />}
              {vt.brow_furrow_avg != null && <Metric label="Brow Furrow (confusion)" value={`${(vt.brow_furrow_avg * 100).toFixed(0)}%`} />}
              {vt.smile_avg != null && <Metric label="Smile / Affect" value={`${(vt.smile_avg * 100).toFixed(0)}%`} />}
              {vt.eye_openness_avg != null && <Metric label="Eye Openness" value={`${(vt.eye_openness_avg * 100).toFixed(0)}%`} />}
            </div>

            {/* Gaze & Attention Distributions */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '8px' }}>
              {vt.gaze_summary && Object.keys(vt.gaze_summary).length > 0 && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '3px' }}>Gaze Distribution</div>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {Object.entries(vt.gaze_summary).sort((a, b) => b[1] - a[1]).map(([g, count]) => (
                      <Badge key={g} label={`${g}: ${count}`} color={g === 'forward' ? '#22c55e' : g === 'down' ? '#38bdf8' : '#f97316'} />
                    ))}
                  </div>
                </div>
              )}
              {vt.attention_summary && Object.keys(vt.attention_summary).length > 0 && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '3px' }}>Attention States</div>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {Object.entries(vt.attention_summary).sort((a, b) => b[1] - a[1]).map(([att, count]) => (
                      <Badge key={att} label={`${att}: ${count}`} color="#a855f7" />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Trend Timeline */}
            {vt.engagement_trend && vt.engagement_trend.length > 0 && (
              <div>
                <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>Timeline Flow (Sampled)</div>
                <div style={{ display: 'flex', gap: '3px', alignItems: 'flex-end', height: '28px', backgroundColor: '#020617', padding: '2px', borderRadius: '4px' }}>
                  {vt.engagement_trend.map((pt, i) => {
                    const score = pt.engagement_score ?? 0;
                    const col = score >= 0.65 ? '#22c55e' : score >= 0.40 ? '#facc15' : '#ef4444';
                    return (
                      <div key={i} title={`t=${pt.timestamp_ms}ms | ${pt.attention_state || pt.engagement_label} | score=${(score * 100).toFixed(0)}% | gaze=${pt.gaze}`}
                        style={{ flex: 1, minWidth: '4px', borderRadius: '2px', backgroundColor: col, height: `${Math.max(4, score * 24)}px` }} />
                    );
                  })}
                </div>
              </div>
            )}
          </SectionCard>
        );
      })}
    </div>
  );
}

function WhiteboardSection({ wb }) {
  if (!wb) return <SectionCard><span style={{ color: '#64748b', fontSize: '12px' }}>No whiteboard data.</span></SectionCard>;
  const summ = wb.summary || {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '340px', overflowY: 'auto' }}>
      <SectionCard>
        <SectionTitle>Summary</SectionTitle>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <Metric label="Total snapshots" value={wb.total_snapshots} />
          <Metric label="Major edits" value={summ.major_edits ?? 0} />
          <Metric label="Idle snapshots" value={summ.idle_snapshots ?? 0} />
          {summ.avg_change_percent != null && <Metric label="Avg change/snap" value={`${summ.avg_change_percent.toFixed(1)}%`} />}
        </div>
      </SectionCard>
      {wb.delta_history && wb.delta_history.length > 0 && (
        <SectionCard>
          <SectionTitle>Delta log ({wb.delta_history.length} snapshots)</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {wb.delta_history.map((d, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                <span style={{ color: '#64748b', fontFamily: 'monospace', minWidth: '28px' }}>#{i + 1}</span>
                <Badge label={d.change_level} color={CHANGE_COLOUR[d.change_level] || '#64748b'} />
                <span style={{ color: '#94a3b8' }}>{d.change_percent?.toFixed(1)}% changed</span>
                {d.dominant_change_region && <span style={{ color: '#64748b' }}>→ {d.dominant_change_region}</span>}
                {d.is_blank && <Badge label="blank" color="#64748b" />}
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function PromptSection({ text }) {
  const ref = useRef();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(text || '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '11px', color: '#64748b' }}>Ready-to-paste LLM context block</span>
        <button onClick={copy} style={{
          fontSize: '11px', padding: '4px 10px', borderRadius: '5px',
          backgroundColor: copied ? '#064e3b' : '#1e3a5f', color: copied ? '#6ee7b7' : '#93c5fd',
          border: `1px solid ${copied ? '#065f46' : '#1d4ed8'}`, cursor: 'pointer', fontWeight: 600
        }}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={ref} style={{
        fontSize: '11px', color: '#cbd5e1', backgroundColor: '#020617',
        border: '1px solid #1e293b', borderRadius: '6px', padding: '12px',
        overflowY: 'auto', maxHeight: '300px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontFamily: 'monospace', lineHeight: 1.6
      }}>
        {text || 'No data yet.'}
      </pre>
    </div>
  );
}

// ── Main modal ─────────────────────────────────────────────────────────────
const DiagnosticsModal = ({ roomCode, isOpen, onClose }) => {
  const [stats, setStats] = useState(null);
  const [telemetry, setTelemetry] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [activeTab, setActiveTab] = useState('stats');

  const fetchAll = async () => {
    if (!roomCode) return;
    setLoading(true);
    try {
      const [sRes, tRes] = await Promise.all([
        fetch(`http://localhost:8000/api/rooms/${roomCode}/stats/`),
        fetch(`http://localhost:8000/api/rooms/${roomCode}/telemetry/`)
      ]);
      if (sRes.ok) setStats(await sRes.json());
      if (tRes.ok) setTelemetry(await tRes.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    fetchAll();
    if (!autoRefresh) return;
    const timer = setInterval(fetchAll, 2000);
    return () => clearInterval(timer);
  }, [isOpen, autoRefresh, roomCode]);

  if (!isOpen) return null;

  const tabs = [
    { id: 'stats', label: 'Live Stats', icon: <Activity size={13} /> },
    { id: 'telemetry', label: 'LLM Payload', icon: <Brain size={13} /> },
  ];

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.75)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(3px)'
    }}>
      <div style={{
        width: '660px', maxHeight: '88vh', backgroundColor: '#1e293b',
        border: '1px solid #334155', borderRadius: '12px',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 18px', borderBottom: '1px solid #334155',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          backgroundColor: '#0f172a'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Activity size={16} color="#38bdf8" />
            <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc' }}>Session Diagnostics</h3>
            {loading && <span style={{ fontSize: '10px', color: '#64748b' }}>↻</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button onClick={() => setAutoRefresh(a => !a)} style={{
              fontSize: '10px', padding: '3px 7px', borderRadius: '4px',
              backgroundColor: autoRefresh ? '#064e3b' : '#334155',
              color: autoRefresh ? '#6ee7b7' : '#94a3b8', fontWeight: 600, border: 'none', cursor: 'pointer'
            }}>
              {autoRefresh ? 'Auto 2s' : 'Paused'}
            </button>
            <button onClick={fetchAll} disabled={loading} style={{ background: 'transparent', color: '#94a3b8', border: 'none', cursor: 'pointer' }}>
              <RefreshCw size={14} />
            </button>
            <button onClick={onClose} style={{ background: 'transparent', color: '#94a3b8', border: 'none', cursor: 'pointer' }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid #334155', backgroundColor: '#0f172a', padding: '0 18px' }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '8px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
              border: 'none', borderBottom: activeTab === t.id ? '2px solid #38bdf8' : '2px solid transparent',
              color: activeTab === t.id ? '#38bdf8' : '#64748b',
              backgroundColor: 'transparent', marginBottom: '-1px'
            }}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: '16px 18px', overflowY: 'auto', flex: 1 }}>
          {error && (
            <div style={{ padding: '8px 12px', borderRadius: '6px', backgroundColor: '#451a1a', border: '1px solid #7f1d1d', color: '#fca5a5', fontSize: '12px', marginBottom: '12px' }}>
              {error}
            </div>
          )}
          {activeTab === 'stats' && <StatsTab stats={stats} />}
          {activeTab === 'telemetry' && <TelemetryTab telemetry={telemetry} loading={loading} />}
        </div>
      </div>
    </div>
  );
};

export default DiagnosticsModal;
