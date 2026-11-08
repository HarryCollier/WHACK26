import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, 
  X, 
  Wand2, 
  Send, 
  Check, 
  RefreshCw, 
  Layers, 
  Eye, 
  HelpCircle,
  TrendingUp,
  BrainCircuit
} from 'lucide-react';
import { getApiBase } from '../config/apiConfig';

const PROMPT_PRESETS = [
  {
    label: '🔢 Similar Practice Problems',
    prompt: 'Create 2 follow-up practice problems with clear answer boxes matching the question style and difficulty of our recent work.'
  },
  {
    label: '🧱 Visual Model / Diagram',
    prompt: 'Draw a clear visual model (such as a number line, bar model, or place value chart) to help scaffold the concept we are discussing.'
  },
  {
    label: '🪜 Step-by-Step Scaffold',
    prompt: 'Create a scaffolded problem broken into 2 steps with guidance boxes to help the student process the steps.'
  },
  {
    label: '🚀 Challenge Extension',
    prompt: 'Generate an extension challenge question that builds slightly upon the questions we just solved on the board.'
  },
  {
    label: '📝 Word Problem Context',
    prompt: 'Create a relatable real-world story problem based on the math operations we are practicing, with an answer box.'
  }
];

export default function AIWhiteboardGeneratorModal({
  isOpen,
  onClose,
  roomCode,
  whiteboardRef,
  getWhiteboardSnapshot
}) {
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [generatedContent, setGeneratedContent] = useState(null);
  const [providerUsed, setProviderUsed] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [placedSuccess, setPlacedSuccess] = useState(false);
  const [contextInfo, setContextInfo] = useState(null);
  const previewCanvasRef = useRef(null);

  // Load session context preview on modal open
  useEffect(() => {
    if (!isOpen) {
      setGeneratedContent(null);
      setProviderUsed('');
      setErrorMsg('');
      setPlacedSuccess(false);
      return;
    }

    const fetchSessionPreview = async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/rooms/${roomCode}/stats/`);
        if (res.ok) {
          const data = await res.json();
          setContextInfo(data);
        }
      } catch (err) {
        console.warn('Could not fetch stats for prompt generator:', err);
      }
    };
    fetchSessionPreview();
  }, [isOpen, roomCode]);

  // Render miniature visual preview on canvas when content is generated
  useEffect(() => {
    if (!generatedContent || !previewCanvasRef.current) return;

    const canvas = previewCanvasRef.current;
    const ctx = canvas.getContext('2d');
    const width = generatedContent.width || 520;
    const height = generatedContent.height || 330;

    // Scale canvas to fit container
    const dpr = window.devicePixelRatio || 1;
    const containerW = canvas.parentElement ? canvas.parentElement.clientWidth : 500;
    const scale = Math.min(1.0, (containerW - 24) / width);

    canvas.width = Math.round(width * scale * dpr);
    canvas.height = Math.round(height * scale * dpr);
    canvas.style.width = `${Math.round(width * scale)}px`;
    canvas.style.height = `${Math.round(height * scale)}px`;

    ctx.save();
    ctx.scale(scale * dpr, scale * dpr);

    // Clear
    ctx.fillStyle = '#faf9f6';
    ctx.fillRect(0, 0, width, height);

    // Render elements
    for (const el of (generatedContent.elements || [])) {
      ctx.save();
      const drawColor = el.color || '#0f172a';
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = el.size || 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (el.type === 'shape') {
        const { shapeType: sType, start, end, fillColor } = el;
        if (!start || !end) continue;
        const minX = Math.min(start.x, end.x);
        const minY = Math.min(start.y, end.y);
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);

        if (fillColor) {
          ctx.fillStyle = fillColor;
          if (sType === 'rectangle') {
            ctx.fillRect(minX, minY, w, h);
          } else if (sType === 'circle') {
            ctx.beginPath();
            ctx.ellipse((start.x + end.x) / 2, (start.y + end.y) / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        ctx.beginPath();
        if (sType === 'rectangle') {
          ctx.strokeRect(minX, minY, w, h);
        } else if (sType === 'circle') {
          ctx.ellipse((start.x + end.x) / 2, (start.y + end.y) / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else if (sType === 'line') {
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        } else if (sType === 'arrow') {
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();

          const angle = Math.atan2(end.y - start.y, end.x - start.x);
          const headLen = Math.max(10, (el.size || 2) * 2.5);
          ctx.beginPath();
          ctx.moveTo(end.x, end.y);
          ctx.lineTo(
            end.x - headLen * Math.cos(angle - Math.PI / 6),
            end.y - headLen * Math.sin(angle - Math.PI / 6)
          );
          ctx.moveTo(end.x, end.y);
          ctx.lineTo(
            end.x - headLen * Math.cos(angle + Math.PI / 6),
            end.y - headLen * Math.sin(angle + Math.PI / 6)
          );
          ctx.stroke();
        }
      } else if (el.type === 'text') {
        ctx.fillStyle = drawColor;
        const fSize = el.fontSize || 16;
        const fWeight = el.fontWeight || 'bold';
        ctx.font = `${fWeight} ${fSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;

        const rawText = String(el.text || '');
        const maxWidth = el.maxWidth || Math.max(260, width - el.x - 20);
        const lineHeight = Math.round(fSize * 1.35);

        const rawLines = rawText.split('\n');
        let lineY = el.y;

        for (const rawLine of rawLines) {
          if (!rawLine) {
            lineY += lineHeight;
            continue;
          }

          if (ctx.measureText(rawLine).width <= maxWidth) {
            ctx.fillText(rawLine, el.x, lineY);
            lineY += lineHeight;
          } else {
            const words = rawLine.split(' ');
            let currentLine = '';
            for (let n = 0; n < words.length; n++) {
              const testLine = currentLine ? `${currentLine} ${words[n]}` : words[n];
              if (ctx.measureText(testLine).width > maxWidth && currentLine) {
                ctx.fillText(currentLine, el.x, lineY);
                currentLine = words[n];
                lineY += lineHeight;
              } else {
                currentLine = testLine;
              }
            }
            if (currentLine) {
              ctx.fillText(currentLine, el.x, lineY);
              lineY += lineHeight;
            }
          }
        }
      }
      ctx.restore();
    }
    ctx.restore();
  }, [generatedContent]);

  if (!isOpen) return null;

  const handleGenerate = async (customPrompt) => {
    const promptToSend = (customPrompt || prompt).trim();
    if (!promptToSend) {
      setErrorMsg('Please enter an instruction or select one of the suggested presets.');
      return;
    }

    setIsLoading(true);
    setErrorMsg('');
    setPlacedSuccess(false);

    try {
      let wbSnapshot = null;
      if (getWhiteboardSnapshot) {
        try { wbSnapshot = getWhiteboardSnapshot(); } catch {}
      }

      const res = await fetch(`${getApiBase()}/api/rooms/${roomCode}/whiteboard/generate/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: promptToSend,
          whiteboardSnapshot: wbSnapshot
        })
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data && data.result) {
        setGeneratedContent(data.result);
        setProviderUsed(data.provider_used || '');
      } else {
        throw new Error('Invalid content generated from server.');
      }
    } catch (err) {
      console.error('Whiteboard generator failed:', err);
      setErrorMsg('Failed to generate content. Please verify your prompt or try one of the presets.');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePlaceOnBoard = () => {
    if (!generatedContent || !whiteboardRef?.current?.insertGeneratedContent) {
      setErrorMsg('Whiteboard interface not ready to accept elements.');
      return;
    }

    try {
      whiteboardRef.current.insertGeneratedContent({
        elements: generatedContent.elements,
        width: generatedContent.width || 520,
        height: generatedContent.height || 330,
        title: generatedContent.title,
        summary: generatedContent.summary
      });
      setPlacedSuccess(true);
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err) {
      console.error('Failed to insert elements onto board:', err);
      setErrorMsg('Could not insert onto whiteboard.');
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(15, 23, 42, 0.78)',
      backdropFilter: 'blur(6px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10500,
      userSelect: 'none'
    }}>
      <div style={{
        backgroundColor: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '16px',
        width: '92%',
        maxWidth: '680px',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
        color: '#f8fafc',
        overflow: 'hidden'
      }}>
        {/* Modal Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid #334155',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'linear-gradient(135deg, rgba(15, 118, 110, 0.25) 0%, rgba(30, 41, 59, 1) 100%)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              backgroundColor: '#0f766e',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#5eead4',
              boxShadow: '0 2px 8px rgba(15, 118, 110, 0.4)'
            }}>
              <Wand2 size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: '#f8fafc' }}>
                AI Whiteboard Generator
              </h3>
              <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>
                Instruct the AI to create questions, models, and scaffolds tailored to your lesson
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '6px',
              borderRadius: '6px'
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = '#ffffff'}
            onMouseLeave={(e) => e.currentTarget.style.color = '#94a3b8'}
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Active Context Banner */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            backgroundColor: '#0f172a',
            borderRadius: '8px',
            border: '1px solid #334155',
            fontSize: '12px',
            color: '#94a3b8'
          }}>
            <BrainCircuit size={15} style={{ color: '#2dd4bf', flexShrink: 0 }} />
            <span>
              <strong>Context Tailoring Active:</strong> The AI automatically reads your current whiteboard writing and dialogue trends to match your question style.
            </span>
          </div>

          {/* Quick Preset Buttons */}
          <div>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '8px', display: 'block' }}>
              Quick Teaching Presets:
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {PROMPT_PRESETS.map((preset, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setPrompt(preset.prompt);
                    handleGenerate(preset.prompt);
                  }}
                  disabled={isLoading}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: '#1e293b',
                    border: '1px solid #475569',
                    borderRadius: '20px',
                    color: '#e2e8f0',
                    fontSize: '12px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#334155';
                    e.currentTarget.style.borderColor = '#2dd4bf';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#1e293b';
                    e.currentTarget.style.borderColor = '#475569';
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom Instruction Input */}
          <div>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#cbd5e1', marginBottom: '6px', display: 'block' }}>
              Or write a specific instruction for the board:
            </label>
            <div style={{ position: 'relative' }}>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g., Draw 2 subtraction practice problems with borrowing matching our recent questions, with an answer box for the student."
                rows={3}
                disabled={isLoading}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  backgroundColor: '#0f172a',
                  border: '1px solid #475569',
                  borderRadius: '10px',
                  color: '#f8fafc',
                  fontSize: '13px',
                  lineHeight: 1.5,
                  resize: 'none',
                  outline: 'none',
                  fontFamily: 'inherit'
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    handleGenerate();
                  }
                }}
              />
            </div>
          </div>

          {errorMsg && (
            <div style={{
              padding: '10px 14px',
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid #ef4444',
              borderRadius: '8px',
              color: '#fca5a5',
              fontSize: '13px'
            }}>
              {errorMsg}
            </div>
          )}

          {/* Generated Result Preview Card */}
          {generatedContent && (
            <div style={{
              backgroundColor: '#0f172a',
              borderRadius: '12px',
              border: '1px solid #334155',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              animation: 'fadeInSlideDown 0.2s ease-out'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Eye size={16} style={{ color: '#38bdf8' }} />
                  <span style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc' }}>
                    {generatedContent.title || 'Generated Whiteboard Content'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {providerUsed && (
                    <span style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      color: providerUsed === 'gemini' ? '#38bdf8' : providerUsed === 'openai' ? '#34d399' : '#94a3b8',
                      backgroundColor: '#1e293b',
                      border: '1px solid #334155',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}>
                      <Sparkles size={11} /> {providerUsed === 'gemini' ? 'Gemini 3.5' : providerUsed === 'openai' ? 'OpenAI GPT-4o' : 'Smart Engine'}
                    </span>
                  )}
                  <span style={{ fontSize: '11px', color: '#94a3b8', backgroundColor: '#1e293b', padding: '2px 8px', borderRadius: '4px', border: '1px solid #334155' }}>
                    {generatedContent.elements?.length || 0} vector elements
                  </span>
                </div>
              </div>

              {generatedContent.summary && (
                <p style={{ margin: 0, fontSize: '12px', color: '#cbd5e1', lineHeight: 1.4 }}>
                  {generatedContent.summary}
                </p>
              )}

              {/* Visual Preview Canvas Container */}
              <div style={{
                backgroundColor: '#faf9f6',
                borderRadius: '8px',
                border: '1px solid #cbd5e1',
                padding: '10px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: '160px',
                overflow: 'hidden'
              }}>
                <canvas ref={previewCanvasRef} style={{ display: 'block', borderRadius: '4px' }} />
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div style={{
          padding: '14px 20px',
          borderTop: '1px solid #334155',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: '#0f172a'
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              backgroundColor: 'transparent',
              color: '#94a3b8',
              border: '1px solid #334155',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => handleGenerate()}
              disabled={isLoading || !prompt.trim()}
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
                cursor: (isLoading || !prompt.trim()) ? 'not-allowed' : 'pointer',
                opacity: (isLoading || !prompt.trim()) ? 0.6 : 1
              }}
            >
              {isLoading ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  <span>Drafting...</span>
                </>
              ) : (
                <>
                  <Sparkles size={14} color="#38bdf8" />
                  <span>{generatedContent ? 'Regenerate' : 'Generate Content'}</span>
                </>
              )}
            </button>

            {generatedContent && (
              <button
                onClick={handlePlaceOnBoard}
                disabled={placedSuccess}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '8px 18px',
                  borderRadius: '8px',
                  backgroundColor: placedSuccess ? '#059669' : '#0f766e',
                  color: '#ffffff',
                  border: 'none',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: placedSuccess ? 'default' : 'pointer',
                  boxShadow: '0 4px 12px rgba(15, 118, 110, 0.4)',
                  transition: 'background-color 0.15s ease'
                }}
              >
                {placedSuccess ? (
                  <>
                    <Check size={16} />
                    <span>Drawn on Board!</span>
                  </>
                ) : (
                  <>
                    <Wand2 size={16} />
                    <span>Draw onto Whiteboard</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
