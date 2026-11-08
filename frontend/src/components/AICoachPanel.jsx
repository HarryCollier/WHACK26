import React, { useState, useEffect } from 'react';
import { 
  Sparkles, 
  BrainCircuit, 
  AlertCircle, 
  CheckCircle2, 
  Clock, 
  Activity, 
  Settings, 
  Key, 
  RefreshCw, 
  ChevronRight, 
  TrendingUp, 
  Volume2, 
  PenTool, 
  Eye, 
  X,
  HelpCircle,
  Target,
  FileCheck2
} from 'lucide-react';
import { getApiBase } from '../config/apiConfig';

export const LiveEngagementBadge = ({ roomCode, socket, role, onClick }) => {
  const [pulse, setPulse] = useState({
    engagement_score: 0,
    status_label: 'Waiting for Student Video',
    status_color: 'gray',
    attention_state: 'no_face',
    student_face_detected: false,
    brow_furrow_level: 0.0,
    gaze_direction: 'unknown',
    actionable_hint: 'Check if student camera is on.'
  });

  // Listen for WebSocket pulses and poll every 15s as fallback
  useEffect(() => {
    let isMounted = true;

    // 1. WebSocket listener
    if (socket) {
      const handleMessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'engagement_pulse' && data.data) {
            if (isMounted) setPulse(data.data);
          }
        } catch {}
      };
      socket.addEventListener('message', handleMessage);
    }

    // 2. 15-second polling fallback
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
    const interval = setInterval(fetchPulse, 15000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [roomCode, socket]);

  // Color mapping
  const colorMap = {
    green: { bg: '#064e3b', border: '#059669', text: '#6ee7b7', dot: '#10b981' },
    yellow: { bg: '#451a03', border: '#d97706', text: '#fde68a', dot: '#f59e0b' },
    red: { bg: '#450a0a', border: '#dc2626', text: '#fca5a5', dot: '#ef4444' },
    gray: { bg: '#1e293b', border: '#475569', text: '#94a3b8', dot: '#64748b' }
  };

  const c = colorMap[pulse.status_color] || colorMap.gray;

  return (
    <button
      onClick={onClick}
      title={`${pulse.status_label} - Click to open AI Pedagogical Coach`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '5px 12px',
        borderRadius: '20px',
        backgroundColor: c.bg,
        border: `1px solid ${c.border}`,
        color: c.text,
        fontSize: '12px',
        fontWeight: 600,
        cursor: 'pointer',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        transition: 'all 0.2s ease'
      }}>
      <span style={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: c.dot,
        boxShadow: `0 0 6px ${c.dot}`
      }} />
      <span>{pulse.student_face_detected ? `${pulse.engagement_score}% Engaged` : 'Student Idle'}</span>
      <span style={{ opacity: 0.6, fontSize: '11px', borderLeft: '1px solid rgba(255,255,255,0.2)', paddingLeft: '6px' }}>
        {pulse.attention_state === 'confused' ? 'Confused' : pulse.attention_state === 'distracted' ? 'Off-screen' : pulse.attention_state === 'attentive' ? 'Focused' : 'No Face'}
      </span>
    </button>
  );
};

export default function AICoachPanel({ roomCode, socket, role, whiteboardRef, isOpen, onClose }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastAutoUpdate, setLastAutoUpdate] = useState(null);

  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [provider, setProvider] = useState(localStorage.getItem('whack_llm_provider') || 'auto');
  const [apiKey, setApiKey] = useState(localStorage.getItem('whack_llm_key') || '');
  const [keySaved, setKeySaved] = useState(false);

  // Listen for real-time background whiteboard evaluations broadcasted from server
  useEffect(() => {
    if (!socket) return;
    const handleWsMessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'coaching_report_updated' && data.data) {
          setReport(data.data);
          setLoading(false);
          setLastAutoUpdate(new Date());
        }
      } catch {}
    };
    socket.addEventListener('message', handleWsMessage);
    return () => socket.removeEventListener('message', handleWsMessage);
  }, [socket]);

  // Fetch or trigger report
  const fetchReport = async (forceGenerate = false) => {
    setLoading(true);
    setError(null);
    try {
      let currentSnapshot = null;
      if (whiteboardRef?.current?.getSnapshot) {
        currentSnapshot = whiteboardRef.current.getSnapshot();
      }

      const url = `${getApiBase()}/api/rooms/${roomCode}/coach/`;
      const options = forceGenerate ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKey.trim() || undefined,
          provider: provider !== 'auto' ? provider : undefined,
          whiteboardSnapshot: currentSnapshot || undefined
        })
      } : {
        method: 'GET'
      };

      const res = await fetch(url, options);
      if (!res.ok) {
        throw new Error(`Failed to generate coaching report (Status ${res.status})`);
      }
      const data = await res.json();
      setReport(data);
    } catch (err) {
      setError(err.message || 'Could not fetch coaching report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchReport(false);
    }
  }, [isOpen, roomCode]);

  // Periodic auto-update every 2 minutes when open
  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => {
      fetchReport(true);
    }, 120000);
    return () => clearInterval(interval);
  }, [isOpen, roomCode, apiKey, provider]);

  const handleSaveSettings = () => {
    localStorage.setItem('whack_llm_provider', provider);
    localStorage.setItem('whack_llm_key', apiKey.trim());
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'set_llm_config',
        apiKey: apiKey.trim() || undefined,
        provider: provider !== 'auto' ? provider : undefined
      }));
    }
    fetchReport(true);
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      right: 0,
      width: '450px',
      maxWidth: '92vw',
      height: '100vh',
      backgroundColor: '#0f172a',
      color: '#f8fafc',
      zIndex: 100,
      boxShadow: '-6px 0 24px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      borderLeft: '1px solid #334155',
      userSelect: 'none'
    }}>
      {/* Drawer Header */}
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid #1e293b',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#1e293b'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            backgroundColor: '#4338ca',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ffffff'
          }}>
            <BrainCircuit size={18} />
          </div>
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
              AI Pedagogical Coach
              <span style={{ fontSize: '10px', backgroundColor: '#312e81', color: '#c7d2fe', padding: '2px 6px', borderRadius: '4px' }}>
                LIVE
              </span>
            </h3>
            <p style={{ fontSize: '11px', color: '#94a3b8', margin: '2px 0 0 0' }}>
              Multimodal feedback & comprehension tracking
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => setShowSettings(!showSettings)}
            title="Configure LLM Provider & API Key"
            style={{
              background: showSettings ? '#334155' : 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '6px',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center'
            }}>
            <Settings size={16} />
          </button>

          <button
            onClick={onClose}
            title="Close Drawer"
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
      </div>

      {/* Settings / API Key Pop-down */}
      {showSettings && (
        <div style={{
          padding: '14px 18px',
          backgroundColor: '#1e293b',
          borderBottom: '1px solid #334155'
        }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#f8fafc', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Key size={14} color="#38bdf8" />
            <span>LLM Provider Configuration</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div>
              <label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>
                Select Engine / Provider:
              </label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  backgroundColor: '#0f172a',
                  color: '#f8fafc',
                  border: '1px solid #475569',
                  fontSize: '12px'
                }}>
                <option value="auto">Auto (Gemini &gt; OpenAI &gt; Heuristic)</option>
                <option value="gemini">Google Gemini (Free Tier on Google AI Studio)</option>
                <option value="openai">OpenAI GPT-4o-mini</option>
                <option value="ollama">Ollama (Local Llama 3.1 / Qwen)</option>
                <option value="heuristic">Heuristic Engine (No API key needed)</option>
              </select>
            </div>

            {(provider === 'gemini' || provider === 'openai' || provider === 'auto') && (
              <div>
                <label style={{ fontSize: '11px', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>
                  API Key (Gemini or OpenAI):
                </label>
                <input
                  type="password"
                  placeholder="Paste AI Studio or OpenAI API key..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: '6px',
                    backgroundColor: '#0f172a',
                    color: '#f8fafc',
                    border: '1px solid #475569',
                    fontSize: '12px',
                    fontFamily: 'monospace'
                  }}
                />
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
              <span style={{ fontSize: '11px', color: '#64748b' }}>
                {keySaved ? 'Saved & refreshed!' : 'API keys stay stored locally in your browser.'}
              </span>
              <button
                onClick={handleSaveSettings}
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  backgroundColor: '#2563eb',
                  color: '#ffffff',
                  fontSize: '12px',
                  fontWeight: 600,
                  border: 'none',
                  cursor: 'pointer'
                }}>
                Save & Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Drawer Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        
        {/* Action Bar (Refresh button, Provider badge, Live auto-update status) */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#94a3b8' }}>
              <Sparkles size={13} color="#a855f7" />
              <span>Engine: <strong>{report?.provider_used || 'Heuristic / Auto'}</strong></span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: '#6ee7b7' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#10b981', display: 'inline-block', boxShadow: '0 0 6px #10b981' }} />
              <span>Auto-analyzing board in background {lastAutoUpdate ? `(${lastAutoUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })})` : ''}</span>
            </div>
          </div>

          <button
            onClick={() => fetchReport(true)}
            disabled={loading}
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
              border: '1px solid #2563eb',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1
            }}>
            <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            <span>{loading ? 'Analyzing...' : 'Reload Report'}</span>
          </button>
        </div>

        {error && (
          <div style={{
            padding: '10px 14px',
            backgroundColor: '#450a0a',
            border: '1px solid #dc2626',
            borderRadius: '8px',
            color: '#fca5a5',
            fontSize: '12px'
          }}>
            {error}
          </div>
        )}

        {loading && !report && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8' }}>
            <RefreshCw size={24} style={{ animation: 'spin 1s linear infinite', marginBottom: '12px' }} />
            <p style={{ fontSize: '13px', margin: 0 }}>Synthesizing speech, video & whiteboard data...</p>
          </div>
        )}

        {report && (
          <>
            {/* Executive Summary */}
            <div style={{
              backgroundColor: '#1e293b',
              borderRadius: '10px',
              padding: '14px 16px',
              border: '1px solid #334155'
            }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '6px' }}>
                Session Flow Overview
              </div>
              <p style={{ fontSize: '13px', lineHeight: 1.5, margin: 0, color: '#f1f5f9' }}>
                {report.summary}
              </p>
            </div>

            {/* Comprehension Gauge */}
            <div style={{
              backgroundColor: '#1e293b',
              borderRadius: '10px',
              padding: '12px 14px',
              border: '1px solid #334155'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8' }}>Comprehension</span>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: '4px',
                  backgroundColor: report.comprehension_rating === 'High' ? '#064e3b' : report.comprehension_rating === 'Moderate' ? '#451a03' : '#450a0a',
                  color: report.comprehension_rating === 'High' ? '#6ee7b7' : report.comprehension_rating === 'Moderate' ? '#fde68a' : '#fca5a5'
                }}>
                  {report.comprehension_rating}
                </span>
              </div>
              <div style={{ height: '8px', backgroundColor: '#334155', borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{
                  width: `${report.comprehension_score || 70}%`,
                  height: '100%',
                  backgroundColor: report.comprehension_rating === 'High' ? '#10b981' : report.comprehension_rating === 'Moderate' ? '#f59e0b' : '#ef4444',
                  borderRadius: '4px',
                  transition: 'width 0.5s ease'
                }} />
              </div>
              <div style={{ textAlign: 'right', fontSize: '11px', color: '#64748b', marginTop: '4px', fontFamily: 'monospace' }}>
                {report.comprehension_score || 70}/100
              </div>
            </div>

            {/* Student Right vs Wrong / Areas For Growth */}
            {(report.what_student_did_well || report.areas_for_growth) && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr',
                gap: '10px'
              }}>
                {report.what_student_did_well && (
                  <div style={{
                    backgroundColor: 'rgba(16, 185, 129, 0.08)',
                    borderRadius: '10px',
                    padding: '12px 14px',
                    border: '1px solid rgba(16, 185, 129, 0.25)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px'
                  }}>
                    <div style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      color: '#34d399',
                      textTransform: 'uppercase',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}>
                      <CheckCircle2 size={14} color="#34d399" />
                      <span>What Student Is Doing Right</span>
                    </div>
                    <p style={{ fontSize: '12px', color: '#e2e8f0', margin: 0, lineHeight: 1.45 }}>
                      {report.what_student_did_well}
                    </p>
                  </div>
                )}

                {report.areas_for_growth && (
                  <div style={{
                    backgroundColor: 'rgba(239, 68, 68, 0.08)',
                    borderRadius: '10px',
                    padding: '12px 14px',
                    border: '1px solid rgba(239, 68, 68, 0.25)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px'
                  }}>
                    <div style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      color: '#f87171',
                      textTransform: 'uppercase',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}>
                      <AlertCircle size={14} color="#f87171" />
                      <span>What Student Is Struggling With</span>
                    </div>
                    <p style={{ fontSize: '12px', color: '#fca5a5', margin: 0, lineHeight: 1.45 }}>
                      {report.areas_for_growth}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Pacing Advice Note */}
            {report.pacing?.advice && (
              <div style={{
                backgroundColor: 'rgba(59, 130, 246, 0.08)',
                border: '1px solid #1e3a8a',
                borderRadius: '8px',
                padding: '10px 14px',
                fontSize: '12px',
                color: '#bfdbfe',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                <Volume2 size={16} color="#60a5fa" style={{ flexShrink: 0 }} />
                <span>{report.pacing.advice}</span>
              </div>
            )}

            {/* Detected Friction Points / Confusion Moments */}
            <div style={{
              backgroundColor: '#1e293b',
              borderRadius: '10px',
              padding: '14px 16px',
              border: '1px solid #334155'
            }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <AlertCircle size={14} color="#f59e0b" />
                <span>Observed Confusion & Friction Points</span>
              </div>

              {(!report.friction_points || report.friction_points.length === 0) ? (
                <div style={{ fontSize: '12px', color: '#6ee7b7', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <CheckCircle2 size={15} />
                  <span>No severe confusion or disengagement spikes detected!</span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {report.friction_points.map((pt, i) => (
                    <div key={i} style={{
                      backgroundColor: '#0f172a',
                      borderRadius: '8px',
                      padding: '10px 12px',
                      borderLeft: '3px solid #f59e0b'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: '#f59e0b' }}>{pt.time_label || 'Moment'}</span>
                      </div>
                      <p style={{ fontSize: '12px', margin: '0 0 6px 0', color: '#cbd5e1' }}>
                        {pt.observation}
                      </p>
                      <div style={{ fontSize: '11px', color: '#93c5fd', display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                        <span style={{ fontWeight: 600 }}>Tip:</span>
                        <span>{pt.recommendation}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Whiteboard Content & Pupil Alignment */}
            {report.whiteboard_relevance && (
              <div style={{
                backgroundColor: '#1e293b',
                borderRadius: '10px',
                padding: '14px 16px',
                border: '1px solid #334155',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Target size={14} color="#38bdf8" />
                    <span>Pupil Whiteboard Alignment</span>
                  </div>
                  <span style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: '4px',
                    backgroundColor: (report.whiteboard_relevance.alignment_score || 0) >= 70 ? '#064e3b' : (report.whiteboard_relevance.alignment_score || 0) >= 40 ? '#451a03' : '#450a0a',
                    color: (report.whiteboard_relevance.alignment_score || 0) >= 70 ? '#6ee7b7' : (report.whiteboard_relevance.alignment_score || 0) >= 40 ? '#fde68a' : '#fca5a5'
                  }}>
                    {report.whiteboard_relevance.alignment_score || 0}% Relevant
                  </span>
                </div>

                {/* 3 Pillars of Alignment */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                  <div style={{ backgroundColor: '#0f172a', padding: '8px', borderRadius: '6px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '2px' }}>Latest Question</div>
                    <div style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      color: report.whiteboard_relevance.relevance_to_latest_question === 'High' ? '#4ade80' : report.whiteboard_relevance.relevance_to_latest_question === 'Moderate' ? '#facc15' : '#94a3b8'
                    }}>
                      {report.whiteboard_relevance.relevance_to_latest_question || 'N/A'}
                    </div>
                  </div>

                  <div style={{ backgroundColor: '#0f172a', padding: '8px', borderRadius: '6px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '2px' }}>Topic Match</div>
                    <div style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      color: report.whiteboard_relevance.relevance_to_topic === 'High' ? '#4ade80' : report.whiteboard_relevance.relevance_to_topic === 'Moderate' ? '#facc15' : '#f87171'
                    }}>
                      {report.whiteboard_relevance.relevance_to_topic || 'Moderate'}
                    </div>
                  </div>

                  <div style={{ backgroundColor: '#0f172a', padding: '8px', borderRadius: '6px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '2px' }}>Tutor Interaction</div>
                    <div style={{
                      fontSize: '10px',
                      fontWeight: 700,
                      color: '#38bdf8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }} title={report.whiteboard_relevance.interaction_with_tutor_work}>
                      {report.whiteboard_relevance.interaction_with_tutor_work || 'None'}
                    </div>
                  </div>
                </div>

                {/* Observed pupil work */}
                {report.whiteboard_relevance.observed_pupil_work && (
                  <div style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: 1.4 }}>
                    <strong style={{ color: '#f1f5f9' }}>Observed pupil work:</strong> {report.whiteboard_relevance.observed_pupil_work}
                  </div>
                )}

                {/* Pedagogical Insight */}
                {report.whiteboard_relevance.pedagogical_insight && (
                  <div style={{
                    backgroundColor: 'rgba(56, 189, 248, 0.08)',
                    borderLeft: '3px solid #38bdf8',
                    padding: '8px 10px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    color: '#bae6fd'
                  }}>
                    {report.whiteboard_relevance.pedagogical_insight}
                  </div>
                )}
              </div>
            )}

            {/* Whiteboard Utilization */}
            {report.whiteboard_feedback && (
              <div style={{
                backgroundColor: '#1e293b',
                borderRadius: '10px',
                padding: '12px 14px',
                border: '1px solid #334155'
              }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <PenTool size={14} color="#38bdf8" />
                  <span>Whiteboard & Visual Learning</span>
                </div>
                <p style={{ fontSize: '12px', color: '#e2e8f0', margin: 0, lineHeight: 1.4 }}>
                  {report.whiteboard_feedback}
                </p>
              </div>
            )}

            {/* Actionable Tips / Next Steps */}
            {report.actionable_tips && report.actionable_tips.length > 0 && (
              <div style={{
                backgroundColor: '#1e293b',
                borderRadius: '10px',
                padding: '14px 16px',
                border: '1px solid #334155'
              }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <TrendingUp size={14} color="#10b981" />
                  <span>Recommended Next Steps For Tutor</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {report.actionable_tips.map((tip, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', color: '#f1f5f9' }}>
                      <span style={{ color: '#10b981', fontWeight: 700 }}>•</span>
                      <span>{tip}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
