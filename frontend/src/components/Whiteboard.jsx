import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { 
  Pencil, 
  Eraser, 
  RotateCcw, 
  Trash2, 
  Highlighter,
  Download
} from 'lucide-react';

const COLORS = [
  '#000000', '#ef4444', '#3b82f6', '#10b981', 
  '#f59e0b', '#8b5cf6', '#ec4899', '#ffffff'
];

const STROKE_SIZES = [2, 4, 8, 14];

const Whiteboard = forwardRef(({ onStroke, socket }, ref) => {
  const canvasRef = useRef(null);
  const isDrawing = useRef(false);
  const [tool, setTool] = useState('pen'); // 'pen', 'highlighter', 'eraser'
  const [color, setColor] = useState('#000000');
  const [size, setSize] = useState(4);
  const [history, setHistory] = useState([]);

  // Provide snapshot extraction handle to parent
  useImperativeHandle(ref, () => ({
    getSnapshot: () => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      return canvas.toDataURL('image/jpeg', 0.8);
    },
    clearBoard: () => {
      handleClear(true);
    }
  }));

  // Setup canvas resolution and white background
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const tempImage = ctx.getImageData(0, 0, canvas.width, canvas.height);
      
      canvas.width = rect.width;
      canvas.height = rect.height;

      // Fill with solid white
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Restore if had previous drawing
      if (tempImage.width > 0 && tempImage.height > 0) {
        ctx.putImageData(tempImage, 0, 0);
      }
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    return () => window.removeEventListener('resize', resizeCanvas);
  }, []);

  // Listen for remote strokes from other peer
  useEffect(() => {
    if (!socket) return;

    const handleMessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'whiteboard_stroke') {
          drawRemoteStroke(data.stroke);
        } else if (data.type === 'whiteboard_clear') {
          clearCanvasLocal();
        }
      } catch (err) {
        console.error('Failed to parse incoming whiteboard ws message', err);
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket]);

  const clearCanvasLocal = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  const drawRemoteStroke = (stroke) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const { x0, y0, x1, y1, color, size, tool } = stroke;
    // Scale normalized coordinates (0-1) to local canvas dimensions
    const startX = x0 * canvas.width;
    const startY = y0 * canvas.height;
    const endX = x1 * canvas.width;
    const endY = y1 * canvas.height;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);

    if (tool === 'eraser') {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = size * 3;
      ctx.globalAlpha = 1.0;
    } else if (tool === 'highlighter') {
      ctx.strokeStyle = color;
      ctx.lineWidth = size * 3;
      ctx.globalAlpha = 0.35;
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.globalAlpha = 1.0;
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  };

  const lastPos = useRef({ x: 0, y: 0 });

  const getPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  };

  const startDrawing = (e) => {
    const pos = getPos(e);
    isDrawing.current = true;
    lastPos.current = pos;
  };

  const draw = (e) => {
    if (!isDrawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const pos = getPos(e);

    const x0 = lastPos.current.x;
    const y0 = lastPos.current.y;
    const x1 = pos.x;
    const y1 = pos.y;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);

    if (tool === 'eraser') {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = size * 3;
      ctx.globalAlpha = 1.0;
    } else if (tool === 'highlighter') {
      ctx.strokeStyle = color;
      ctx.lineWidth = size * 3;
      ctx.globalAlpha = 0.35;
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.globalAlpha = 1.0;
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();

    // Broadcast normalized stroke (0-1) to keep it resolution independent
    const strokeData = {
      x0: x0 / canvas.width,
      y0: y0 / canvas.height,
      x1: x1 / canvas.width,
      y1: y1 / canvas.height,
      color,
      size,
      tool
    };

    if (onStroke) onStroke(strokeData);

    lastPos.current = pos;
  };

  const stopDrawing = () => {
    isDrawing.current = false;
  };

  const handleClear = (broadcast = true) => {
    clearCanvasLocal();
    if (broadcast && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'whiteboard_clear' }));
    }
  };

  const downloadCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `whiteboard-${Date.now()}.png`;
    link.href = canvas.toDataURL();
    link.click();
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#f1f5f9' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 16px',
        backgroundColor: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        zIndex: 10,
        flexWrap: 'wrap'
      }}>
        {/* Tool selectors */}
        <div style={{ display: 'flex', gap: '4px', background: '#f8fafc', padding: '4px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <button 
            onClick={() => setTool('pen')}
            title="Pen"
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              background: tool === 'pen' ? '#2563eb' : 'transparent',
              color: tool === 'pen' ? '#ffffff' : '#64748b',
              display: 'flex',
              alignItems: 'center'
            }}>
            <Pencil size={18} />
          </button>

          <button 
            onClick={() => setTool('highlighter')}
            title="Highlighter"
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              background: tool === 'highlighter' ? '#2563eb' : 'transparent',
              color: tool === 'highlighter' ? '#ffffff' : '#64748b',
              display: 'flex',
              alignItems: 'center'
            }}>
            <Highlighter size={18} />
          </button>

          <button 
            onClick={() => setTool('eraser')}
            title="Eraser"
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              background: tool === 'eraser' ? '#2563eb' : 'transparent',
              color: tool === 'eraser' ? '#ffffff' : '#64748b',
              display: 'flex',
              alignItems: 'center'
            }}>
            <Eraser size={18} />
          </button>
        </div>

        {/* Color Palette */}
        {tool !== 'eraser' && (
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  backgroundColor: c,
                  border: color === c ? '2px solid #2563eb' : '1px solid #cbd5e1',
                  transform: color === c ? 'scale(1.15)' : 'scale(1)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.1)'
                }}
              />
            ))}
          </div>
        )}

        {/* Stroke Size Selector */}
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginLeft: '6px' }}>
          {STROKE_SIZES.map((s) => (
            <button
              key={s}
              onClick={() => setSize(s)}
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '6px',
                backgroundColor: size === s ? '#e0e7ff' : '#f8fafc',
                border: size === s ? '1px solid #6366f1' : '1px solid #cbd5e1',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
              <div style={{
                width: `${s + 2}px`,
                height: `${s + 2}px`,
                borderRadius: '50%',
                backgroundColor: '#334155'
              }} />
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Action Buttons */}
        <button
          onClick={() => handleClear(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 12px',
            borderRadius: '6px',
            backgroundColor: '#fee2e2',
            color: '#b91c1c',
            fontSize: '13px',
            fontWeight: 500
          }}>
          <Trash2 size={16} />
          Clear Board
        </button>

        <button
          onClick={downloadCanvas}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 12px',
            borderRadius: '6px',
            backgroundColor: '#f1f5f9',
            color: '#334155',
            fontSize: '13px',
            fontWeight: 500
          }}>
          <Download size={16} />
          Save Snapshot
        </button>
      </div>

      {/* Main Canvas Viewport */}
      <div style={{ flex: 1, position: 'relative', width: '100%', height: '100%', cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}>
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            touchAction: 'none'
          }}
        />
      </div>
    </div>
  );
});

export default Whiteboard;
