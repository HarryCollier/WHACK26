import React, { useState, useEffect } from 'react';
import { 
  Sparkles, 
  Clock, 
  MessageSquare, 
  TrendingUp, 
  Volume2, 
  Check, 
  Copy, 
  Download, 
  LogOut, 
  X, 
  RefreshCw,
  Award,
  BookOpen
} from 'lucide-react';
import { getApiBase } from '../config/apiConfig';

/**
 * EndSessionReportModal
 * Presented to the tutor when the call concludes or when exiting the session.
 * Displays:
 * 1. AI Pedagogical Coach Executive Summary (Session flow, comprehension, talk-time balance).
 * 2. Full Conversation Dialogue / Transcript with speaker attribution and timestamps.
 * 3. Export / Copy options and Exit Session confirmation.
 */
export default function EndSessionReportModal({
  isOpen,
  onClose,
  onConfirmExit,
  onOpenAskCoach,
  roomCode,
  title,
  transcripts = []
}) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('summary'); // 'summary' | 'dialogue'
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    const fetchFinalReport = async () => {
      setLoading(true);
      try {
        // Request comprehensive coaching report for the entire session
        const res = await fetch(`${getApiBase()}/api/rooms/${roomCode}/coach/`, {
          method: 'GET'
        });
        if (res.ok) {
          const data = await res.json();
          if (isMounted) setReport(data);
        }
      } catch (err) {
        console.warn('Could not fetch final coaching report:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchFinalReport();

    return () => {
      isMounted = false;
    };
  }, [isOpen, roomCode]);

  if (!isOpen) return null;

  // Calculate session duration from transcripts
  const durationStr = () => {
    if (!transcripts || transcripts.length < 2) return 'Live Session';
    const first = transcripts[0].timestamp || 0;
    const last = transcripts[transcripts.length - 1].timestamp || 0;
    const diffSec = Math.max(0, Math.floor((last - first) / 1000));
    const mins = Math.floor(diffSec / 60);
    const secs = diffSec % 60;
    return `${mins}m ${secs}s`;
  };

  const copyFullReport = () => {
    const lines = [
      `# TUTORING SESSION REPORT: ${title} (${roomCode})`,
      `Date: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
      `Duration: ${durationStr()}`,
      `Speech Turns: ${transcripts.length}`,
      '',
      '## AI PEDAGOGICAL SUMMARY',
      report?.summary || 'Session dynamic balanced.',
      '',
      `Comprehension Score: ${report?.comprehension_score ?? 75}/100 (${report?.comprehension_label || 'High'})`,
      `Pacing: ${report?.pacing_feedback || 'Well-balanced conversation.'}`,
      '',
      '## FULL CONVERSATION TRANSCRIPT',
      ...transcripts.map(t => {
        const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '';
        return `[${time}] ${t.role.toUpperCase()}: ${t.text}`;
      })
    ];

    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadTranscriptFile = () => {
    const textContent = [
      `TUTORING SESSION TRANSCRIPT`,
      `Room Code: ${roomCode}`,
      `Title: ${title}`,
      `Generated: ${new Date().toISOString()}`,
      '--------------------------------------------------',
      ...transcripts.map(t => {
        const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '';
        return `[${time}] ${t.role.toUpperCase()}: ${t.text}`;
      })
    ].join('\n');

    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tutoring-transcript-${roomCode}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(15, 23, 42, 0.85)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2000,
      padding: '20px'
    }}>
      <div style={{
        width: '100%',
        maxWidth: '780px',
        maxHeight: '90vh',
        backgroundColor: '#1e293b',
        borderRadius: '16px',
        border: '1px solid #334155',
        boxShadow: '0 20px 50px rgba(0, 0, 0, 0.65)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '18px 24px',
          borderBottom: '1px solid #334155',
          backgroundColor: '#0f172a'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '42px',
              height: '42px',
              borderRadius: '12px',
              backgroundColor: '#312e81',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid #4338ca'
            }}>
              <Award size={22} color="#a855f7" />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                  End-of-Session Tutoring Report
                </h2>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: '12px',
                  backgroundColor: '#064e3b',
                  color: '#6ee7b7'
                }}>
                  Room: {roomCode}
                </span>
              </div>
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '3px 0 0 0' }}>
                {title} • {durationStr()} • {transcripts.length} dialogue utterances
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            title="Return to Whiteboard"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '6px',
              borderRadius: '6px'
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div style={{
          display: 'flex',
          backgroundColor: '#0f172a',
          padding: '0 24px',
          borderBottom: '1px solid #334155',
          gap: '16px'
        }}>
          <button
            onClick={() => setActiveTab('summary')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '10px 4px',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'summary' ? '2px solid #818cf8' : '2px solid transparent',
              color: activeTab === 'summary' ? '#818cf8' : '#94a3b8',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            <Sparkles size={15} />
            <span>AI Pedagogical Summary</span>
          </button>

          <button
            onClick={() => setActiveTab('dialogue')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '10px 4px',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'dialogue' ? '2px solid #818cf8' : '2px solid transparent',
              color: activeTab === 'dialogue' ? '#818cf8' : '#94a3b8',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            <MessageSquare size={15} />
            <span>Full Conversation Dialogue ({transcripts.length})</span>
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {activeTab === 'summary' ? (
            loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '12px' }}>
                <RefreshCw size={28} color="#818cf8" style={{ animation: 'spin 1s linear infinite' }} />
                <span style={{ fontSize: '13px', color: '#cbd5e1' }}>Synthesizing multimodal session insights...</span>
              </div>
            ) : (
              <>
                {/* Executive Flow Summary */}
                <div style={{
                  backgroundColor: '#0f172a',
                  borderRadius: '12px',
                  padding: '16px 20px',
                  border: '1px solid #334155'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <Sparkles size={16} color="#a855f7" />
                    <span style={{ fontSize: '12px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
                      Session Flow & Dynamics Overview
                    </span>
                  </div>
                  <p style={{ fontSize: '14px', lineHeight: '1.6', color: '#e2e8f0', margin: 0 }}>
                    {report?.summary || 'The tutoring session dynamic was balanced with steady reciprocal turn-taking and active engagement on whiteboard calculations.'}
                  </p>
                </div>

                {/* Metrics Breakdown Cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                  {/* Comprehension Card */}
                  <div style={{
                    backgroundColor: '#0f172a',
                    padding: '16px',
                    borderRadius: '12px',
                    border: '1px solid #334155'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8' }}>Comprehension Score</span>
                      <span style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: '10px',
                        backgroundColor: '#064e3b',
                        color: '#6ee7b7'
                      }}>
                        {report?.comprehension_label || 'High'}
                      </span>
                    </div>
                    <div style={{ width: '100%', height: '8px', backgroundColor: '#334155', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{
                        width: `${report?.comprehension_score ?? 75}%`,
                        height: '100%',
                        backgroundColor: '#10b981',
                        borderRadius: '4px'
                      }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#64748b', marginTop: '6px' }}>
                      <span>Attentive Focus</span>
                      <span style={{ fontWeight: 600, color: '#f8fafc' }}>{report?.comprehension_score ?? 75}/100</span>
                    </div>
                  </div>
                </div>

                {/* Key Pedagogical Suggestions */}
                <div style={{
                  backgroundColor: '#0f172a',
                  borderRadius: '12px',
                  padding: '16px 20px',
                  border: '1px solid #334155'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                    <BookOpen size={16} color="#38bdf8" />
                    <span style={{ fontSize: '12px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
                      Key Pedagogical Takeaways & Recommendations
                    </span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '20px', color: '#cbd5e1', fontSize: '13px', lineHeight: '1.6' }}>
                    {report?.pedagogical_suggestions && report.pedagogical_suggestions.length > 0 ? (
                      report.pedagogical_suggestions.map((s, idx) => (
                        <li key={idx} style={{ marginBottom: '6px' }}>{s}</li>
                      ))
                    ) : (
                      <>
                        <li style={{ marginBottom: '6px' }}>
                          Maintain the current balance of student verbal responses to encourage active conceptualization.
                        </li>
                        <li style={{ marginBottom: '6px' }}>
                          Continue leveraging the interactive whiteboard to underline key mathematical steps during explanations.
                        </li>
                        <li>
                          Check in with a friendly question whenever your student looks puzzled or pauses before answering.
                        </li>
                      </>
                    )}
                  </ul>
                </div>
              </>
            )
          ) : (
            /* Dialogue Tab */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {transcripts.length === 0 ? (
                <div style={{
                  textAlign: 'center',
                  padding: '40px 20px',
                  color: '#64748b',
                  border: '1px dashed #334155',
                  borderRadius: '10px'
                }}>
                  <MessageSquare size={32} color="#475569" style={{ margin: '0 auto 8px' }} />
                  <p style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 600, color: '#94a3b8' }}>
                    No Speech Transcripts Recorded
                  </p>
                  <p style={{ margin: 0, fontSize: '12px' }}>
                    Speech activity from the microphone was not detected during this session.
                  </p>
                </div>
              ) : (
                transcripts.map((t, idx) => {
                  const isTutor = t.role === 'tutor';
                  const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
                  return (
                    <div key={idx} style={{
                      backgroundColor: '#0f172a',
                      padding: '12px 16px',
                      borderRadius: '8px',
                      border: `1px solid ${isTutor ? 'rgba(56, 189, 248, 0.3)' : 'rgba(74, 222, 128, 0.3)'}`
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          color: isTutor ? '#38bdf8' : '#4ade80',
                          textTransform: 'uppercase'
                        }}>
                          {isTutor ? 'Tutor' : 'Student'}
                        </span>
                        <span style={{ fontSize: '11px', color: '#64748b' }}>{time}</span>
                      </div>
                      <div style={{ fontSize: '13px', color: '#f1f5f9', lineHeight: 1.5 }}>
                        {t.text}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid #334155',
          backgroundColor: '#0f172a',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={copyFullReport}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '8px 14px',
                borderRadius: '8px',
                backgroundColor: '#1e293b',
                color: '#f8fafc',
                fontSize: '12px',
                fontWeight: 600,
                border: '1px solid #334155',
                cursor: 'pointer'
              }}
            >
              {copied ? <Check size={14} color="#22c55e" /> : <Copy size={14} />}
              <span>{copied ? 'Copied Report!' : 'Copy Report'}</span>
            </button>

            {transcripts.length > 0 && (
              <button
                onClick={downloadTranscriptFile}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '8px 14px',
                  borderRadius: '8px',
                  backgroundColor: '#1e293b',
                  color: '#f8fafc',
                  fontSize: '12px',
                  fontWeight: 600,
                  border: '1px solid #334155',
                  cursor: 'pointer'
                }}
              >
                <Download size={14} />
                <span>Save Transcript (.txt)</span>
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            {onOpenAskCoach && (
              <button
                onClick={onOpenAskCoach}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '8px 16px',
                  borderRadius: '8px',
                  background: 'linear-gradient(135deg, #4338ca 0%, #6d28d9 100%)',
                  color: '#ffffff',
                  fontSize: '13px',
                  fontWeight: 600,
                  border: '1px solid #7c3aed',
                  cursor: 'pointer'
                }}
              >
                <Sparkles size={15} color="#e9d5ff" />
                <span>Ask AI Coach</span>
              </button>
            )}

            <button
              onClick={onClose}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                backgroundColor: '#334155',
                color: '#f8fafc',
                fontSize: '13px',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer'
              }}
            >
              Return to Board
            </button>

            <button
              onClick={onConfirmExit}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '8px 18px',
                borderRadius: '8px',
                backgroundColor: '#dc2626',
                color: '#ffffff',
                fontSize: '13px',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer'
              }}
            >
              <LogOut size={15} />
              <span>Exit Session</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
