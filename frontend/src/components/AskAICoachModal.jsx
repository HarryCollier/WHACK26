import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, 
  Send, 
  MessageSquare, 
  Copy, 
  Check, 
  X, 
  RefreshCw, 
  FileText, 
  Home, 
  Lightbulb, 
  Clock, 
  Volume2, 
  PenTool, 
  HelpCircle,
  GraduationCap
} from 'lucide-react';
import { getApiBase } from '../config/apiConfig';

/**
 * Strips LaTeX math delimiters ($$...$$, $...$, \(...\), \[...\], \frac)
 * and formats them into clean, human-readable text.
 */
function cleanMathNotation(str) {
  if (!str) return '';
  return str
    .replace(/\\times\b/g, '×')
    .replace(/\\div\b/g, '÷')
    .replace(/\\cdot\b/g, '·')
    .replace(/\\le(q)?\b/g, '≤')
    .replace(/\\ge(q)?\b/g, '≥')
    .replace(/\\ne(q)?\b/g, '≠')
    .replace(/\\pm\b/g, '±')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
    .replace(/\$\$([^\$]+)\$\$/g, '$1')
    .replace(/\\\[([^\]]+)\\\]/g, '$1')
    .replace(/\\\(([^\)]+)\\\)/g, '$1')
    .replace(/(?<![\$\w])\$([^\$\n]+?)\$(?![\$\w])/g, (match, inner) => {
      const trimmed = inner.trim();
      // Retain pure currency amounts like $50 or $100
      if (/^\d+([.,]\d+)?$/.test(trimmed)) return match;
      return trimmed;
    });
}

/**
 * Lightweight Markdown Formatter
 * Formats headings, bold text, bullet points, numbers, and inline code without heavy external dependencies.
 */
function FormattedMessage({ text }) {
  if (!text) return null;

  const cleanedText = cleanMathNotation(text);
  const lines = cleanedText.split('\n');

  return (
    <div style={{ lineHeight: 1.6, fontSize: '14px', color: '#e2e8f0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {lines.map((line, idx) => {
        const trimmed = line.trim();

        if (!trimmed) {
          return <div key={idx} style={{ height: '6px' }} />;
        }

        // Heading 3
        if (trimmed.startsWith('### ')) {
          return (
            <h4 key={idx} style={{ margin: '8px 0 2px 0', fontSize: '15px', fontWeight: 700, color: '#38bdf8' }}>
              {formatInline(trimmed.slice(4))}
            </h4>
          );
        }

        // Heading 2
        if (trimmed.startsWith('## ')) {
          return (
            <h3 key={idx} style={{ margin: '10px 0 4px 0', fontSize: '16px', fontWeight: 700, color: '#60a5fa' }}>
              {formatInline(trimmed.slice(3))}
            </h3>
          );
        }

        // Bullet point (* or -)
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          return (
            <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', paddingLeft: '6px' }}>
              <span style={{ color: '#38bdf8', fontSize: '14px', lineHeight: '20px' }}>•</span>
              <div style={{ flex: 1 }}>{formatInline(trimmed.slice(2))}</div>
            </div>
          );
        }

        // Numbered list (e.g. 1. )
        const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
        if (numMatch) {
          return (
            <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', paddingLeft: '6px' }}>
              <span style={{ color: '#60a5fa', fontWeight: 700, fontSize: '13px', minWidth: '18px' }}>
                {numMatch[1]}.
              </span>
              <div style={{ flex: 1 }}>{formatInline(numMatch[2])}</div>
            </div>
          );
        }

        // Regular paragraph
        return (
          <p key={idx} style={{ margin: 0 }}>
            {formatInline(trimmed)}
          </p>
        );
      })}
    </div>
  );
}

function formatInline(str) {
  // Split by bold (**bold**) and inline code (`code`)
  const parts = [];
  const regex = /(\*\*.*?\*\*|`.*?`)/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(str)) !== null) {
    if (match.index > lastIdx) {
      parts.push(str.substring(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={match.index} style={{ color: '#f8fafc', fontWeight: 700 }}>
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code key={match.index} style={{
          backgroundColor: '#1e293b',
          color: '#38bdf8',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '13px',
          fontFamily: 'monospace',
          border: '1px solid #334155'
        }}>
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < str.length) {
    parts.push(str.substring(lastIdx));
  }

  return parts.length > 0 ? parts : str;
}


export default function AskAICoachModal({
  isOpen,
  onClose,
  onOpenReviewReport,
  onLeave,
  roomCode,
  title,
  role = 'tutor',
  getWhiteboardSnapshot = null
}) {
  const [messages, setMessages] = useState([]);
  const [inputPrompt, setInputPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [engineUsed, setEngineUsed] = useState('auto');
  const [sessionStats, setSessionStats] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const chatBottomRef = useRef(null);
  const textareaRef = useRef(null);

  // Initialize conversation and fetch quick session stats
  useEffect(() => {
    if (!isOpen) return;

    // Load initial welcome message if empty
    if (messages.length === 0) {
      setMessages([
        {
          id: 'welcome',
          role: 'assistant',
          content: `Hello! I'm your **AI Pedagogical Coach** for **${title || 'this session'}** (Room \`${roomCode}\`).\n\nI followed along with your lesson — observing how your student engaged, where they hesitated or seemed puzzled, and the math equations you both worked on together on the whiteboard.\n\nAsk me anything! For example, how to guide them through place-value confusion, ideas for fun follow-up practice problems, or tips on conversational pacing.`,
          timestamp: Date.now()
        }
      ]);
    }

    // Fetch brief telemetry stats
    const fetchStats = async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/rooms/${roomCode}/stats/`);
        if (res.ok) {
          const data = await res.json();
          setSessionStats(data);
        }
      } catch (err) {
        console.debug('Could not load session stats for Ask Coach:', err);
      }
    };
    fetchStats();
  }, [isOpen, roomCode, title]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  if (!isOpen) return null;

  const inspirationChips = [
    "Why did the student write 16 for 21 - 1 = ?",
    "Where did the student seem most puzzled or hesitant?",
    "Give me 3 practice problems to reinforce today's lesson",
    "How was my conversational pacing and wait time?"
  ];

  const handleSend = async (overridePrompt = null) => {
    const promptToSend = (overridePrompt || inputPrompt).trim();
    if (!promptToSend || loading) return;

    const userMsg = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: promptToSend,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMsg]);
    setInputPrompt('');
    setLoading(true);

    try {
      const storedKey = localStorage.getItem('whack_gemini_api_key') || localStorage.getItem('whack_openai_api_key') || undefined;
      const storedProvider = localStorage.getItem('whack_llm_provider') || undefined;

      // Extract current whiteboard snapshot if callback provided
      let wbSnapshot = undefined;
      if (getWhiteboardSnapshot) {
        try {
          wbSnapshot = getWhiteboardSnapshot();
        } catch {}
      }

      // Prepare conversation history excluding the welcome message
      const historyPayload = messages
        .filter(m => m.id !== 'welcome')
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch(`${getApiBase()}/api/rooms/${roomCode}/coach/ask/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: promptToSend,
          chat_history: historyPayload,
          apiKey: storedKey,
          provider: storedProvider !== 'auto' ? storedProvider : undefined,
          whiteboardSnapshot: wbSnapshot
        })
      });

      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }

      const data = await res.json();
      if (data.provider_used) {
        setEngineUsed(data.provider_used);
      }

      const botMsg = {
        id: `assistant_${Date.now()}`,
        role: 'assistant',
        content: data.response || "I was unable to analyze this question based on the telemetry. Please try asking in a different way.",
        timestamp: Date.now(),
        provider: data.provider_used
      };

      setMessages(prev => [...prev, botMsg]);
    } catch (err) {
      console.error('Error sending prompt to AI Coach:', err);
      const errorMsg = {
        id: `err_${Date.now()}`,
        role: 'assistant',
        content: "Sorry, I encountered an issue connecting to the pedagogical analysis engine. Please try again or check your server connection.",
        timestamp: Date.now(),
        isError: true
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setLoading(false);
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const copyMessage = (id, text) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
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
      zIndex: 10000,
      padding: '16px'
    }}>
      <div style={{
        backgroundColor: '#0f172a',
        border: '1px solid #334155',
        borderRadius: '16px',
        width: '880px',
        maxWidth: '96vw',
        height: '86vh',
        maxHeight: '780px',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
        color: '#f8fafc',
        overflow: 'hidden'
      }}>
        {/* Top Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 24px',
          borderBottom: '1px solid #334155',
          backgroundColor: '#1e293b'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '42px',
              height: '42px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(79, 70, 229, 0.4)'
            }}>
              <Sparkles size={22} color="#ffffff" />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: '#f8fafc' }}>
                  Ask AI Coach
                </h2>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  backgroundColor: '#312e81',
                  color: '#c7d2fe',
                  border: '1px solid #4338ca',
                  padding: '2px 8px',
                  borderRadius: '12px'
                }}>
                  Session Data Grounded
                </span>
              </div>
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '3px 0 0 0' }}>
                Interactive pedagogical feedback for room <strong style={{ color: '#38bdf8' }}>{roomCode}</strong>
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{
              fontSize: '11px',
              color: '#64748b',
              backgroundColor: '#0f172a',
              padding: '4px 10px',
              borderRadius: '6px',
              border: '1px solid #334155'
            }}>
              Engine: <strong style={{ color: '#94a3b8' }}>{engineUsed}</strong>
            </span>
            <button
              onClick={onClose}
              title="Close window"
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '6px',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                transition: 'color 0.15s ease'
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Telemetry Summary Bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          padding: '10px 24px',
          backgroundColor: '#131d2e',
          borderBottom: '1px solid #1e293b',
          fontSize: '12px',
          color: '#94a3b8',
          flexWrap: 'wrap'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Clock size={14} color="#38bdf8" />
            <span>Duration: <strong style={{ color: '#e2e8f0' }}>{sessionStats?.duration || 'Active'}</strong></span>
          </div>
          <span style={{ color: '#334155' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Volume2 size={14} color="#4ade80" />
            <span>Transcripts: <strong style={{ color: '#e2e8f0' }}>{sessionStats?.transcript_count ?? messages.length} turns</strong></span>
          </div>
          <span style={{ color: '#334155' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <PenTool size={14} color="#a855f7" />
            <span>Board Legend: <strong style={{ color: '#93c5fd' }}>Tutor (Black)</strong> vs <strong style={{ color: '#4ade80' }}>Pupil (Green)</strong></span>
          </div>
        </div>

        {/* Conversation Stream */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '18px'
        }}>
          {messages.map((msg) => {
            const isUser = msg.role === 'user';
            return (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: isUser ? 'flex-end' : 'flex-start',
                  width: '100%'
                }}
              >
                {/* Speaker Header */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  marginBottom: '6px',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: isUser ? '#60a5fa' : '#a855f7'
                }}>
                  {isUser ? (
                    <>
                      <span>You (Tutor)</span>
                      <GraduationCap size={13} />
                    </>
                  ) : (
                    <>
                      <Sparkles size={13} />
                      <span>AI Pedagogical Coach</span>
                    </>
                  )}
                  <span style={{ color: '#64748b', fontWeight: 400, marginLeft: '4px' }}>
                    {msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>

                {/* Message Bubble */}
                <div style={{
                  position: 'relative',
                  maxWidth: isUser ? '75%' : '88%',
                  padding: '14px 18px',
                  borderRadius: isUser ? '14px 4px 14px 14px' : '4px 14px 14px 14px',
                  backgroundColor: isUser ? '#1e3a8a' : '#1e293b',
                  border: `1px solid ${isUser ? '#2563eb' : '#334155'}`,
                  color: '#f8fafc',
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)'
                }}>
                  {isUser ? (
                    <div style={{ fontSize: '14px', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                      {msg.content}
                    </div>
                  ) : (
                    <FormattedMessage text={msg.content} />
                  )}

                  {/* Copy Button for Assistant responses */}
                  {!isUser && msg.id !== 'welcome' && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px', paddingTop: '6px', borderTop: '1px solid #334155' }}>
                      <button
                        onClick={() => copyMessage(msg.id, msg.content)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: copiedId === msg.id ? '#4ade80' : '#94a3b8',
                          fontSize: '11px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          cursor: 'pointer',
                          padding: '2px 6px',
                          borderRadius: '4px'
                        }}
                      >
                        {copiedId === msg.id ? (
                          <>
                            <Check size={12} color="#4ade80" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy size={12} />
                            <span>Copy Advice</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Loading Indicator */}
          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 600, color: '#a855f7' }}>
                <Sparkles size={13} />
                <span>AI Pedagogical Coach</span>
              </div>
              <div style={{
                padding: '14px 20px',
                borderRadius: '4px 14px 14px 14px',
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                color: '#94a3b8',
                fontSize: '13px'
              }}>
                <RefreshCw size={15} className="spin-animation" style={{ animation: 'spin 1.5s linear infinite' }} />
                <span>Analyzing session telemetry & formulating grounded coaching advice...</span>
              </div>
            </div>
          )}

          <div ref={chatBottomRef} />
        </div>

        {/* Inspiration Chips */}
        <div style={{
          padding: '8px 24px 12px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          overflowX: 'auto',
          backgroundColor: '#0f172a',
          borderTop: '1px solid #1e293b'
        }}>
          <span style={{ fontSize: '11px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
            <Lightbulb size={13} color="#f59e0b" />
            Try asking:
          </span>
          {inspirationChips.map((chip, idx) => (
            <button
              key={idx}
              onClick={() => handleSend(chip)}
              disabled={loading}
              style={{
                backgroundColor: '#1e293b',
                color: '#cbd5e1',
                border: '1px solid #334155',
                padding: '5px 12px',
                borderRadius: '16px',
                fontSize: '12px',
                cursor: loading ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
                transition: 'all 0.15s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#334155';
                e.currentTarget.style.borderColor = '#475569';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#1e293b';
                e.currentTarget.style.borderColor = '#334155';
              }}
            >
              {chip}
            </button>
          ))}
        </div>

        {/* Input Bar */}
        <div style={{
          padding: '12px 24px',
          backgroundColor: '#1e293b',
          borderTop: '1px solid #334155',
          display: 'flex',
          gap: '10px',
          alignItems: 'flex-end'
        }}>
          <textarea
            ref={textareaRef}
            rows={2}
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            placeholder="Ask the AI Coach anything (e.g. 'Why did the student write 16 for 21 - 1 = ?', 'How was my wait time?')..."
            style={{
              flex: 1,
              padding: '10px 14px',
              borderRadius: '10px',
              backgroundColor: '#0f172a',
              color: '#f8fafc',
              border: '1px solid #475569',
              fontSize: '13px',
              fontFamily: 'inherit',
              resize: 'none',
              outline: 'none',
              lineHeight: 1.4
            }}
          />

          <button
            onClick={() => handleSend()}
            disabled={!inputPrompt.trim() || loading}
            style={{
              height: '42px',
              padding: '0 18px',
              borderRadius: '10px',
              backgroundColor: !inputPrompt.trim() || loading ? '#334155' : '#2563eb',
              color: !inputPrompt.trim() || loading ? '#64748b' : '#ffffff',
              border: 'none',
              fontSize: '13px',
              fontWeight: 600,
              cursor: !inputPrompt.trim() || loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.15s ease',
              boxShadow: inputPrompt.trim() && !loading ? '0 4px 12px rgba(37, 99, 235, 0.35)' : 'none'
            }}
          >
            <span>Ask</span>
            <Send size={15} />
          </button>
        </div>

        {/* Bottom Footer Navigation */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 24px',
          backgroundColor: '#0f172a',
          borderTop: '1px solid #1e293b'
        }}>
          <button
            onClick={() => {
              onClose();
              if (onOpenReviewReport) onOpenReviewReport();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 14px',
              borderRadius: '8px',
              backgroundColor: '#1e293b',
              color: '#93c5fd',
              border: '1px solid #3b82f6',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            <FileText size={15} />
            <span>Review Full Session Report</span>
          </button>

          <button
            onClick={onLeave}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 16px',
              borderRadius: '8px',
              backgroundColor: '#334155',
              color: '#f8fafc',
              border: '1px solid #475569',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            <Home size={15} />
            <span>Return to Home Screen</span>
          </button>
        </div>
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
