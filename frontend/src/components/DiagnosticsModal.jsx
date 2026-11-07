import React, { useState, useEffect } from 'react';
import { Activity, X, RefreshCw, Layers, Video, Mic } from 'lucide-react';

const DiagnosticsModal = ({ roomCode, isOpen, onClose }) => {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchStats = async () => {
    if (!roomCode) return;
    try {
      setLoading(true);
      const res = await fetch(`http://localhost:8000/api/rooms/${roomCode}/stats/`);
      if (!res.ok) {
        throw new Error(`Room session not active or not found (Status: ${res.status})`);
      }
      const data = await res.json();
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    fetchStats();

    let timer;
    if (autoRefresh) {
      timer = setInterval(fetchStats, 1000); // 1s live poll while modal open
    }
    return () => clearInterval(timer);
  }, [isOpen, autoRefresh, roomCode]);

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      backdropFilter: 'blur(3px)'
    }}>
      <div style={{
        width: '560px',
        maxHeight: '85vh',
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '12px',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid #334155',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: '#0f172a'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Activity size={18} color="#38bdf8" />
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#f8fafc' }}>
              Live Server Session Diagnostics
            </h3>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              style={{
                fontSize: '11px',
                padding: '4px 8px',
                borderRadius: '4px',
                backgroundColor: autoRefresh ? '#064e3b' : '#334155',
                color: autoRefresh ? '#6ee7b7' : '#94a3b8',
                fontWeight: 600
              }}>
              {autoRefresh ? 'Auto 1s (On)' : 'Paused'}
            </button>
            <button
              onClick={fetchStats}
              disabled={loading}
              title="Refresh"
              style={{ background: 'transparent', color: '#94a3b8' }}>
              <RefreshCw size={15} />
            </button>
            <button
              onClick={onClose}
              style={{ background: 'transparent', color: '#94a3b8' }}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div style={{ padding: '20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {error && (
            <div style={{
              padding: '10px 14px',
              borderRadius: '8px',
              backgroundColor: '#451a1a',
              border: '1px solid #7f1d1d',
              color: '#fca5a5',
              fontSize: '13px'
            }}>
              {error}
            </div>
          )}

          {stats && (
            <>
              {/* Top Summary Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                <div style={{
                  padding: '12px',
                  backgroundColor: '#0f172a',
                  borderRadius: '8px',
                  border: '1px solid #334155'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#38bdf8', fontSize: '12px', marginBottom: '6px' }}>
                    <Video size={14} />
                    <span>Video (0.5s)</span>
                  </div>
                  <div style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc' }}>
                    {(stats.video_frames.tutor_count || 0) + (stats.video_frames.student_count || 0)}
                  </div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                    Tutor: {stats.video_frames.tutor_count} | Student: {stats.video_frames.student_count}
                  </div>
                </div>

                <div style={{
                  padding: '12px',
                  backgroundColor: '#0f172a',
                  borderRadius: '8px',
                  border: '1px solid #334155'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#a855f7', fontSize: '12px', marginBottom: '6px' }}>
                    <Layers size={14} />
                    <span>Whiteboard</span>
                  </div>
                  <div style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc' }}>
                    {stats.whiteboard.history_count}
                  </div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                    Active: {stats.whiteboard.has_most_recent ? 'Captured' : 'Empty'}
                  </div>
                </div>

                <div style={{
                  padding: '12px',
                  backgroundColor: '#0f172a',
                  borderRadius: '8px',
                  border: '1px solid #334155'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#22c55e', fontSize: '12px', marginBottom: '6px' }}>
                    <Mic size={14} />
                    <span>Transcripts</span>
                  </div>
                  <div style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc' }}>
                    {stats.transcripts.length}
                  </div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                    Whisper processed
                  </div>
                </div>
              </div>

              {/* Connected Peers list */}
              <div style={{
                padding: '12px',
                backgroundColor: '#0f172a',
                borderRadius: '8px',
                border: '1px solid #334155'
              }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px' }}>
                  Active In-Memory Peers ({stats.active_peers.length})
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {stats.active_peers.map((peer, i) => (
                    <span key={i} style={{
                      fontSize: '11px',
                      padding: '3px 8px',
                      borderRadius: '4px',
                      backgroundColor: '#334155',
                      color: '#f8fafc'
                    }}>
                      {peer}
                    </span>
                  ))}
                </div>
              </div>

              {/* Recent Transcript log */}
              <div style={{
                padding: '12px',
                backgroundColor: '#0f172a',
                borderRadius: '8px',
                border: '1px solid #334155'
              }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '8px' }}>
                  Transcripts in Server Memory
                </div>
                <div style={{ maxHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {stats.transcripts.length === 0 ? (
                    <span style={{ fontSize: '12px', color: '#64748b' }}>No speech recorded yet.</span>
                  ) : (
                    stats.transcripts.map((t, i) => (
                      <div key={i} style={{ fontSize: '12px', color: '#cbd5e1' }}>
                        <span style={{ color: t.role === 'tutor' ? '#38bdf8' : '#4ade80', fontWeight: 600 }}>
                          [{t.role.toUpperCase()}]
                        </span>{' '}
                        {t.text}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DiagnosticsModal;
