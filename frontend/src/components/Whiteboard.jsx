import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { 
  Pencil, 
  Eraser, 
  Trash2, 
  Highlighter, 
  Palette,
  Shapes,
  Square,
  Circle,
  Triangle,
  Minus,
  ArrowRight,
  Calculator as CalcIcon,
  Ruler as RulerIcon,
  Compass,
  Scissors,
  Lasso,
  ChevronDown,
  X,
  RotateCw,
  Hand,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2
} from 'lucide-react';

const PRESET_COLORS = [
  '#000000', // Black
  '#ef4444', // Red
  '#2563eb', // Blue
  '#10b981'  // Green
];

const BOARD_BG_COLOR = '#faf9f6'; // Soft off-white

// Utility: HSV to RGB (h in [0, 360], s in [0, 100], v in [0, 100])
function hsvToRgb(h, s, v) {
  const sat = s / 100;
  const val = v / 100;
  const c = val * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = val - c;
  let r = 0, g = 0, b = 0;
  if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
  else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
  else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
  else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
  else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
  else if (h >= 300 && h <= 360) { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}

// Utility: RGB to HSV
function rgbToHsv(r, g, b) {
  const normR = r / 255, normG = g / 255, normB = b / 255;
  const max = Math.max(normR, normG, normB), min = Math.min(normR, normG, normB);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (max !== min) {
    switch (max) {
      case normR: h = (normG - normB) / d + (normG < normB ? 6 : 0); break;
      case normG: h = (normB - normR) / d + 2; break;
      case normB: h = (normR - normG) / d + 4; break;
      default: break;
    }
    h /= 6;
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    v: Math.round(v * 100)
  };
}

// Utility: hex to { r, g, b }
function hexToRgb(hex) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const num = parseInt(c, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

// Utility: { r, g, b } to hex
function rgbToHex(r, g, b) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Distance from point (px, py) to segment (ax, ay)-(bx, by)
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - dy) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Line segment intersection test
function segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const ccw = (ax, ay, bx, by, cx, cy) => (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
  return (ccw(x1, y1, x3, y3, x4, y4) !== ccw(x2, y2, x3, y3, x4, y4)) &&
         (ccw(x1, y1, x2, y2, x3, y3) !== ccw(x1, y1, x2, y2, x4, y4));
}

// Ray-casting test if point is inside polygon
function isPointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

const Whiteboard = forwardRef(({ onStroke, socket }, ref) => {
  const canvasRef = useRef(null);
  const isDrawing = useRef(false);

  // Tools: 'pen', 'highlighter', 'eraser', 'stroke-eraser', 'lasso-eraser', 'shape', 'hand'
  const [tool, setTool] = useState('pen');
  const [prevTool, setPrevTool] = useState('pen');
  const [shapeType, setShapeType] = useState('rectangle'); // 'rectangle', 'circle', 'triangle', 'line', 'arrow'
  const [color, setColor] = useState('#000000');
  const [size, setSize] = useState(4); // Continuous width slider (1-40px)

  // Zoom and Pan (World Camera)
  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef({ x: 0, y: 0 });
  panRef.current = pan;
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });

  // Multi-touch 2-finger navigation tracking
  const activeTouches = useRef(new Map());
  const isTwoFingerNavigating = useRef(false);
  const touchNavStart = useRef(null);

  // Popovers & Floating Widgets
  const [showRgbPicker, setShowRgbPicker] = useState(false);
  const [showMathMenu, setShowMathMenu] = useState(false);
  const [showEraserMenu, setShowEraserMenu] = useState(false);

  const [showProtractor, setShowProtractor] = useState(false);
  const [showRuler, setShowRuler] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);

  // Stroke Tracking
  const rawPoints = useRef([]);
  const hasMoved = useRef(false);
  const lastDrawnPos = useRef(null);
  const currentElementId = useRef(null);

  // Persistent vector element store (all stored in world coordinates)
  const elementsRef = useRef([]);

  // Undo / Redo Stacks (records actions: { type: 'add', element } | { type: 'delete', element, index } | { type: 'batch_delete', items: [{ element, index }] })
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateHistoryState = () => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  };

  const pushUndoAction = (action) => {
    undoStackRef.current.push(action);
    redoStackRef.current = []; // Clear redo stack on new user action
    updateHistoryState();
  };

  // Live shape and lasso preview state (screen coordinates)
  const [activeShapePreview, setActiveShapePreview] = useState(null);
  const [activeLassoPoints, setActiveLassoPoints] = useState(null);

  // Convert Screen coordinates -> World coordinates
  const toWorld = (screenX, screenY) => {
    return {
      x: (screenX - pan.x) / zoom,
      y: (screenY - pan.y) / zoom
    };
  };

  // Convert World coordinates -> Screen coordinates
  const toScreen = (worldX, worldY) => {
    return {
      x: worldX * zoom + pan.x,
      y: worldY * zoom + pan.y
    };
  };

  // Expose snapshot extraction handle to parent (for AI telemetry)
  useImperativeHandle(ref, () => ({
    getSnapshot: () => {
      const canvas = canvasRef.current;
      if (!canvas) return null;

      // When zoomed or panned, generate a normalized 1.0x full-board render for pristine AI telemetry
      if (zoom !== 1.0 || pan.x !== 0 || pan.y !== 0) {
        const offscreen = document.createElement('canvas');
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        offscreen.width = Math.round(rect.width * dpr);
        offscreen.height = Math.round(rect.height * dpr);
        const offCtx = offscreen.getContext('2d');
        offCtx.scale(dpr, dpr);
        offCtx.fillStyle = BOARD_BG_COLOR;
        offCtx.fillRect(0, 0, rect.width, rect.height);

        // Render elements at standard scale
        for (const el of elementsRef.current) {
          renderElementToCtx(offCtx, el);
        }
        return offscreen.toDataURL('image/jpeg', 0.8);
      }

      return canvas.toDataURL('image/jpeg', 0.8);
    },
    clearBoard: () => {
      handleClear(true);
    }
  }));

  // Setup High-DPI canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      redrawAll();
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    return () => window.removeEventListener('resize', resizeCanvas);
  }, []);

  // Redraw when camera transform changes (zoom, pan)
  useEffect(() => {
    redrawAll();
  }, [zoom, pan]);

  // Listen for remote strokes and actions
  useEffect(() => {
    if (!socket) return;

    const handleMessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'whiteboard_stroke') {
          drawRemoteStroke(data.stroke);
        } else if (data.type === 'whiteboard_element') {
          const idx = elementsRef.current.findIndex(el => el.id === data.element.id);
          if (idx !== -1) {
            elementsRef.current[idx] = data.element;
          } else {
            elementsRef.current.push(data.element);
          }
          redrawAll();
        } else if (data.type === 'whiteboard_delete_element') {
          elementsRef.current = elementsRef.current.filter(el => el.id !== data.elementId);
          redrawAll();
        } else if (data.type === 'whiteboard_delete_elements') {
          const ids = new Set(data.elementIds);
          elementsRef.current = elementsRef.current.filter(el => !ids.has(el.id));
          redrawAll();
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

  // Keyboard shortcuts for Undo (Ctrl+Z / Cmd+Z) and Redo (Ctrl+Y / Cmd+Y / Ctrl+Shift+Z / Cmd+Shift+Z)
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't intercept shortcuts when typing in inputs/textareas/contentEditable
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) {
        return;
      }

      const isModifier = e.ctrlKey || e.metaKey;
      if (!isModifier) return;

      const key = e.key.toLowerCase();

      // Undo: Ctrl+Z or Cmd+Z (without Shift)
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } 
      // Redo: Ctrl+Y or Cmd+Y OR Ctrl+Shift+Z / Cmd+Shift+Z
      else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Full redraw of the canvas with current Zoom and Pan
  const redrawAll = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    if (ctx.save) ctx.save();
    if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (ctx.scale) ctx.scale(dpr, dpr);

    // Clear background
    if (ctx.fillRect) {
      ctx.fillStyle = BOARD_BG_COLOR;
      ctx.fillRect(0, 0, rect.width, rect.height);
    }

    // Apply Camera Transform
    if (ctx.translate) ctx.translate(pan.x, pan.y);
    if (ctx.scale) ctx.scale(zoom, zoom);

    // Render all elements in world coordinates
    for (const el of elementsRef.current) {
      renderElementToCtx(ctx, el);
    }
    ctx.restore();
  };

  // Render a single vector element (coordinates are in world space)
  const renderElementToCtx = (ctx, el) => {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (el.tool === 'eraser') {
      ctx.strokeStyle = BOARD_BG_COLOR;
      ctx.fillStyle = BOARD_BG_COLOR;
      ctx.lineWidth = el.size * 3.5;
      ctx.globalAlpha = 1.0;
    } else if (el.tool === 'highlighter') {
      ctx.strokeStyle = el.color;
      ctx.fillStyle = el.color;
      ctx.lineWidth = el.size * 3.5;
      ctx.globalAlpha = 0.35;
    } else {
      ctx.strokeStyle = el.color;
      ctx.fillStyle = el.color;
      ctx.lineWidth = el.size;
      ctx.globalAlpha = 1.0;
    }

    if (el.type === 'stroke') {
      if (el.isDot && el.points && el.points.length > 0) {
        const p = el.points[0];
        ctx.beginPath();
        ctx.arc(p.x, p.y, el.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (el.points && el.points.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(el.points[0].x, el.points[0].y);
        for (let i = 1; i < el.points.length; i++) {
          const prev = el.points[i - 1];
          const curr = el.points[i];
          const midX = (prev.x + curr.x) / 2;
          const midY = (prev.y + curr.y) / 2;
          ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
        }
        const lastP = el.points[el.points.length - 1];
        ctx.lineTo(lastP.x, lastP.y);
        ctx.stroke();
      }
    } else if (el.type === 'shape') {
      const { shapeType: sType, start, end } = el;
      if (!start || !end) return;
      const minX = Math.min(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);

      ctx.beginPath();
      if (sType === 'rectangle') {
        ctx.strokeRect(minX, minY, width, height);
      } else if (sType === 'circle') {
        const cx = (start.x + end.x) / 2;
        const cy = (start.y + end.y) / 2;
        const rx = width / 2;
        const ry = height / 2;
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (sType === 'triangle') {
        ctx.moveTo(start.x + width / 2, minY);
        ctx.lineTo(start.x, end.y);
        ctx.lineTo(end.x, end.y);
        ctx.closePath();
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
        const headLen = Math.max(12, el.size * 3);
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
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 16px monospace';
      ctx.fillText(el.text, el.x, el.y);
    }

    ctx.restore();
  };

  const clearCanvasLocal = () => {
    elementsRef.current = [];
    undoStackRef.current = [];
    redoStackRef.current = [];
    updateHistoryState();
    redrawAll();
  };

  // Undo / Redo Handlers
  const handleUndo = () => {
    if (undoStackRef.current.length === 0) return;
    const action = undoStackRef.current.pop();

    if (action.type === 'add') {
      // Undo an added element -> remove it from elementsRef and broadcast deletion
      const idx = elementsRef.current.findIndex(el => el.id === action.element.id);
      if (idx !== -1) {
        const removed = elementsRef.current.splice(idx, 1)[0];
        redoStackRef.current.push({ type: 'add', element: removed, index: idx });
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'whiteboard_delete_element',
            elementId: removed.id
          }));
        }
      }
    } else if (action.type === 'delete') {
      // Undo single deletion -> re-insert element at its original index and broadcast element
      const insertIdx = Math.min(action.index, elementsRef.current.length);
      elementsRef.current.splice(insertIdx, 0, action.element);
      redoStackRef.current.push({ type: 'delete', element: action.element, index: insertIdx });
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'whiteboard_element',
          element: action.element
        }));
      }
    } else if (action.type === 'batch_delete') {
      // Undo batch deletion (e.g. lasso or sweep eraser) -> re-insert elements and broadcast
      const restoredItems = [];
      const restoredElements = [];
      for (const item of action.items) {
        const insertIdx = Math.min(item.index, elementsRef.current.length);
        elementsRef.current.splice(insertIdx, 0, item.element);
        restoredItems.push({ element: item.element, index: insertIdx });
        restoredElements.push(item.element);
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'whiteboard_element',
            element: item.element
          }));
        }
      }
      redoStackRef.current.push({ type: 'batch_delete', items: restoredItems });
    }

    updateHistoryState();
    redrawAll();
  };

  const handleRedo = () => {
    if (redoStackRef.current.length === 0) return;
    const action = redoStackRef.current.pop();

    if (action.type === 'add') {
      // Redo add -> re-insert element and broadcast
      const insertIdx = action.index !== undefined ? Math.min(action.index, elementsRef.current.length) : elementsRef.current.length;
      elementsRef.current.splice(insertIdx, 0, action.element);
      undoStackRef.current.push({ type: 'add', element: action.element });
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'whiteboard_element',
          element: action.element
        }));
      }
    } else if (action.type === 'delete') {
      // Redo delete -> remove element and broadcast deletion
      const idx = elementsRef.current.findIndex(el => el.id === action.element.id);
      if (idx !== -1) {
        const removed = elementsRef.current.splice(idx, 1)[0];
        undoStackRef.current.push({ type: 'delete', element: removed, index: idx });
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'whiteboard_delete_element',
            elementId: removed.id
          }));
        }
      }
    } else if (action.type === 'batch_delete') {
      // Redo batch delete -> remove elements and broadcast deletion
      const deletedItems = [];
      const deletedIds = [];
      for (const item of action.items) {
        const idx = elementsRef.current.findIndex(el => el.id === item.element.id);
        if (idx !== -1) {
          const removed = elementsRef.current.splice(idx, 1)[0];
          deletedItems.push({ element: removed, index: idx });
          deletedIds.push(removed.id);
        }
      }
      undoStackRef.current.push({ type: 'batch_delete', items: deletedItems });
      if (deletedIds.length > 0 && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'whiteboard_delete_elements',
          elementIds: deletedIds
        }));
      }
    }

    updateHistoryState();
    redrawAll();
  };

  const drawRemoteStroke = (stroke) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width;
    const h = rect.height;

    const { x0, y0, x1, y1, cx, cy, isDot, color: sColor, size: sSize, tool: sTool } = stroke;

    if (ctx.save) ctx.save();
    if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (ctx.scale) ctx.scale(dpr, dpr);
    if (ctx.translate) ctx.translate(pan.x, pan.y);
    if (ctx.scale) ctx.scale(zoom, zoom);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (sTool === 'eraser') {
      ctx.strokeStyle = BOARD_BG_COLOR;
      ctx.fillStyle = BOARD_BG_COLOR;
      ctx.lineWidth = sSize * 3.5;
      ctx.globalAlpha = 1.0;
    } else if (sTool === 'highlighter') {
      ctx.strokeStyle = sColor;
      ctx.fillStyle = sColor;
      ctx.lineWidth = sSize * 3.5;
      ctx.globalAlpha = 0.35;
    } else {
      ctx.strokeStyle = sColor;
      ctx.fillStyle = sColor;
      ctx.lineWidth = sSize;
      ctx.globalAlpha = 1.0;
    }

    if (isDot) {
      ctx.beginPath();
      ctx.arc(x0 * w, y0 * h, (sTool === 'eraser' ? sSize * 1.75 : sSize / 2), 0, Math.PI * 2);
      ctx.fill();
    } else if (cx !== undefined && cy !== undefined) {
      ctx.beginPath();
      ctx.moveTo(x0 * w, y0 * h);
      ctx.quadraticCurveTo(cx * w, cy * h, x1 * w, y1 * h);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(x0 * w, y0 * h);
      ctx.lineTo(x1 * w, y1 * h);
      ctx.stroke();
    }
    ctx.restore();
  };

  // Get position in Screen Coordinates
  const getScreenPos = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
    const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  };

  // Hit-test whether point/segment intersects an element in world coordinates
  const hitTestElement = (worldPos, el, threshold = 16) => {
    const { x: px, y: py } = worldPos;

    if (el.type === 'stroke') {
      const pts = el.points;
      if (!pts || pts.length === 0) return false;
      if (pts.length === 1) {
        return Math.hypot(px - pts[0].x, py - pts[0].y) <= Math.max(threshold, (el.size || 4) + 8);
      }
      const maxDist = Math.max(threshold, (el.size || 4) / 2 + 8);
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= maxDist) {
          return true;
        }
      }
      return false;
    }

    if (el.type === 'shape') {
      const { start, end, shapeType: sType } = el;
      if (!start || !end) return false;
      const minX = Math.min(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const maxX = Math.max(start.x, end.x);
      const maxY = Math.max(start.y, end.y);

      if (sType === 'rectangle') {
        const d1 = distToSegment(px, py, minX, minY, maxX, minY);
        const d2 = distToSegment(px, py, maxX, minY, maxX, maxY);
        const d3 = distToSegment(px, py, maxX, maxY, minX, maxY);
        const d4 = distToSegment(px, py, minX, maxY, minX, minY);
        return Math.min(d1, d2, d3, d4) <= threshold;
      }
      if (sType === 'circle') {
        const cx = (start.x + end.x) / 2;
        const cy = (start.y + end.y) / 2;
        const r = (maxX - minX) / 2;
        const d = Math.hypot(px - cx, py - cy);
        return Math.abs(d - r) <= threshold;
      }
      if (sType === 'triangle') {
        const d1 = distToSegment(px, py, minX + (maxX - minX) / 2, minY, minX, maxY);
        const d2 = distToSegment(px, py, minX, maxY, maxX, maxY);
        const d3 = distToSegment(px, py, maxX, maxY, minX + (maxX - minX) / 2, minY);
        return Math.min(d1, d2, d3) <= threshold;
      }
      if (sType === 'line' || sType === 'arrow') {
        return distToSegment(px, py, start.x, start.y, end.x, end.y) <= threshold;
      }
    }

    if (el.type === 'text') {
      return px >= el.x && px <= el.x + 220 && py >= el.y - 25 && py <= el.y + 15;
    }

    return false;
  };

  // Test if an element is touched or crossed by an eraser path (p1 -> p2)
  const isElementCrossedByEraser = (p1, p2, el, threshold = 18) => {
    // 1. Point hit test at endpoints
    if (hitTestElement(p1, el, threshold) || hitTestElement(p2, el, threshold)) return true;

    // 2. Segment intersection test
    if (el.type === 'stroke') {
      const pts = el.points;
      if (!pts || pts.length < 2) return false;
      for (let i = 0; i < pts.length - 1; i++) {
        if (segmentsIntersect(p1.x, p1.y, p2.x, p2.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y)) {
          return true;
        }
      }
      return false;
    }

    if (el.type === 'shape') {
      const { start, end, shapeType: sType } = el;
      if (!start || !end) return false;
      const minX = Math.min(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const maxX = Math.max(start.x, end.x);
      const maxY = Math.max(start.y, end.y);

      if (sType === 'rectangle') {
        return segmentsIntersect(p1.x, p1.y, p2.x, p2.y, minX, minY, maxX, minY) ||
               segmentsIntersect(p1.x, p1.y, p2.x, p2.y, maxX, minY, maxX, maxY) ||
               segmentsIntersect(p1.x, p1.y, p2.x, p2.y, maxX, maxY, minX, maxY) ||
               segmentsIntersect(p1.x, p1.y, p2.x, p2.y, minX, maxY, minX, minY);
      }
      if (sType === 'line' || sType === 'arrow') {
        return segmentsIntersect(p1.x, p1.y, p2.x, p2.y, start.x, start.y, end.x, end.y);
      }
      if (sType === 'triangle') {
        const topX = minX + (maxX - minX) / 2;
        return segmentsIntersect(p1.x, p1.y, p2.x, p2.y, topX, minY, minX, maxY) ||
               segmentsIntersect(p1.x, p1.y, p2.x, p2.y, minX, maxY, maxX, maxY) ||
               segmentsIntersect(p1.x, p1.y, p2.x, p2.y, maxX, maxY, topX, minY);
      }
    }

    return false;
  };

  // Test if an element is circled inside the lasso polygon
  const isElementInLasso = (lassoPts, el) => {
    if (!lassoPts || lassoPts.length < 3) return false;

    if (el.type === 'stroke') {
      const pts = el.points;
      if (!pts || pts.length === 0) return false;
      let insideCount = 0;
      for (const p of pts) {
        if (isPointInPolygon(p.x, p.y, lassoPts)) insideCount++;
      }
      return insideCount >= Math.min(2, pts.length) || (insideCount / pts.length) >= 0.35;
    }

    if (el.type === 'shape') {
      const { start, end } = el;
      if (!start || !end) return false;
      const cx = (start.x + end.x) / 2;
      const cy = (start.y + end.y) / 2;
      return isPointInPolygon(cx, cy, lassoPts) || isPointInPolygon(start.x, start.y, lassoPts) || isPointInPolygon(end.x, end.y, lassoPts);
    }

    if (el.type === 'text') {
      return isPointInPolygon(el.x, el.y, lassoPts);
    }

    return false;
  };

  // Live drawing of quadratic segment onto canvas
  const drawQuadCurve = (startX, startY, ctrlX, ctrlY, endX, endY) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    if (ctx.save) ctx.save();
    if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (ctx.scale) ctx.scale(dpr, dpr);
    if (ctx.translate) ctx.translate(pan.x, pan.y);
    if (ctx.scale) ctx.scale(zoom, zoom);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (tool === 'eraser') {
      ctx.strokeStyle = BOARD_BG_COLOR;
      ctx.lineWidth = size * 3.5;
      ctx.globalAlpha = 1.0;
    } else if (tool === 'highlighter') {
      ctx.strokeStyle = color;
      ctx.lineWidth = size * 3.5;
      ctx.globalAlpha = 0.35;
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.globalAlpha = 1.0;
    }

    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo(ctrlX, ctrlY, endX, endY);
    ctx.stroke();
    ctx.restore();

    if (onStroke && rect.width > 0 && rect.height > 0) {
      onStroke({
        x0: startX / rect.width,
        y0: startY / rect.height,
        cx: ctrlX / rect.width,
        cy: ctrlY / rect.height,
        x1: endX / rect.width,
        y1: endY / rect.height,
        color,
        size,
        tool
      });
    }
  };

  // Pointer Down Handler
  const handlePointerDown = (e) => {
    try { e.target.setPointerCapture(e.pointerId); } catch {}
    activeTouches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Multi-touch 2-finger navigation: If 2 or more touches are active, pan the board (suppress drawing)
    if (activeTouches.current.size >= 2) {
      if (isDrawing.current) {
        isDrawing.current = false;
        rawPoints.current = [];
        lastDrawnPos.current = null;
        redrawAll();
      }
      setActiveShapePreview(null);
      setActiveLassoPoints(null);
      isTwoFingerNavigating.current = true;
      const touches = Array.from(activeTouches.current.values());
      touchNavStart.current = {
        midX: (touches[0].x + touches[1].x) / 2,
        midY: (touches[0].y + touches[1].y) / 2,
        panX: panRef.current.x,
        panY: panRef.current.y
      };
      return;
    }

    const sPos = getScreenPos(e);
    const wPos = toWorld(sPos.x, sPos.y);

    // Hand tool (Pan)
    if (tool === 'hand' || e.button === 1 || e.spaceKey) {
      isPanning.current = true;
      panStart.current = {
        x: e.clientX - pan.x,
        y: e.clientY - pan.y
      };
      return;
    }

    // Stroke Eraser (Click or Start Sweep)
    if (tool === 'stroke-eraser') {
      isDrawing.current = true;
      rawPoints.current = [wPos];
      // Check if clicked directly on an element
      const hitIdx = elementsRef.current.findLastIndex(el => hitTestElement(wPos, el, 18));
      if (hitIdx !== -1) {
        const deletedEl = elementsRef.current[hitIdx];
        elementsRef.current.splice(hitIdx, 1);
        pushUndoAction({ type: 'delete', element: deletedEl, index: hitIdx });
        redrawAll();
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'whiteboard_delete_element',
            elementId: deletedEl.id
          }));
        }
      }
      return;
    }

    // Lasso Eraser (Circle to delete)
    if (tool === 'lasso-eraser') {
      isDrawing.current = true;
      rawPoints.current = [wPos];
      setActiveLassoPoints([sPos]);
      return;
    }

    // Shape drawing
    if (tool === 'shape') {
      isDrawing.current = true;
      rawPoints.current = [wPos];
      setActiveShapePreview({
        start: sPos,
        end: sPos,
        shapeType,
        color,
        size: size * zoom
      });
      return;
    }

    // Freehand Pen / Highlighter / Brush Eraser
    isDrawing.current = true;
    hasMoved.current = false;
    currentElementId.current = `stroke_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    rawPoints.current = [wPos];
    lastDrawnPos.current = wPos;
  };

  // Pointer Move Handler
  const handlePointerMove = (e) => {
    if (activeTouches.current.has(e.pointerId)) {
      activeTouches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // 2-finger touchscreen navigation
    if (isTwoFingerNavigating.current || activeTouches.current.size >= 2) {
      const touches = Array.from(activeTouches.current.values());
      if (touches.length >= 2) {
        const curMidX = (touches[0].x + touches[1].x) / 2;
        const curMidY = (touches[0].y + touches[1].y) / 2;
        if (!touchNavStart.current) {
          touchNavStart.current = {
            midX: curMidX,
            midY: curMidY,
            panX: panRef.current.x,
            panY: panRef.current.y
          };
        }
        const dx = curMidX - touchNavStart.current.midX;
        const dy = curMidY - touchNavStart.current.midY;
        setPan({
          x: touchNavStart.current.panX + dx,
          y: touchNavStart.current.panY + dy
        });
      }
      return;
    }

    const sPos = getScreenPos(e);

    // Panning with Hand tool
    if (isPanning.current) {
      setPan({
        x: e.clientX - panStart.current.x,
        y: e.clientY - panStart.current.y
      });
      return;
    }

    if (!isDrawing.current) return;
    const wPos = toWorld(sPos.x, sPos.y);

    // Stroke Eraser (Sweep to delete)
    // As the user sweeps across lines without releasing, any stroke touched is deleted!
    if (tool === 'stroke-eraser') {
      const pts = rawPoints.current;
      const lastP = pts[pts.length - 1];
      pts.push(wPos);

      if (lastP) {
        const toDeleteIds = [];
        const deletedItems = [];
        elementsRef.current = elementsRef.current.filter((el, idx) => {
          if (isElementCrossedByEraser(lastP, wPos, el, 18)) {
            toDeleteIds.push(el.id);
            deletedItems.push({ element: el, index: idx });
            return false;
          }
          return true;
        });

        if (toDeleteIds.length > 0) {
          pushUndoAction({ type: 'batch_delete', items: deletedItems });
          redrawAll();
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'whiteboard_delete_elements',
              elementIds: toDeleteIds
            }));
          }
        }
      }
      return;
    }

    // Lasso Eraser drawing
    if (tool === 'lasso-eraser') {
      rawPoints.current.push(wPos);
      setActiveLassoPoints(prev => [...(prev || []), sPos]);
      return;
    }

    // Shape live preview
    if (tool === 'shape') {
      const startScreen = toScreen(rawPoints.current[0].x, rawPoints.current[0].y);
      setActiveShapePreview({
        start: startScreen,
        end: sPos,
        shapeType,
        color,
        size: size * zoom
      });
      return;
    }

    // Freehand stroke interpolation in world coordinates
    const pts = rawPoints.current;
    const lastRaw = pts[pts.length - 1];

    if (lastRaw) {
      const dist = Math.hypot(wPos.x - lastRaw.x, wPos.y - lastRaw.y);
      if (dist > 8 / zoom) {
        const steps = Math.min(Math.floor(dist / (6 / zoom)), 6);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          appendPoint({
            x: lastRaw.x + (wPos.x - lastRaw.x) * t,
            y: lastRaw.y + (wPos.y - lastRaw.y) * t
          });
        }
        return;
      }
    }

    appendPoint(wPos);
  };

  const appendPoint = (pos) => {
    if (!isDrawing.current || !lastDrawnPos.current) return;
    const pts = rawPoints.current;
    const lastRaw = pts[pts.length - 1];

    if (lastRaw) {
      const dist = Math.hypot(pos.x - lastRaw.x, pos.y - lastRaw.y);
      if (dist < 1.0 / zoom) return;
    }

    hasMoved.current = true;
    pts.push(pos);

    if (pts.length < 2) return;

    const prev = pts[pts.length - 2];
    const curr = pts[pts.length - 1];

    const midX = (prev.x + curr.x) / 2;
    const midY = (prev.y + curr.y) / 2;

    drawQuadCurve(lastDrawnPos.current.x, lastDrawnPos.current.y, prev.x, prev.y, midX, midY);
    lastDrawnPos.current = { x: midX, y: midY };
  };

  // Pointer Up Handler
  const handlePointerUp = (e) => {
    try { e.target.releasePointerCapture(e.pointerId); } catch {}
    activeTouches.current.delete(e.pointerId);

    if (isTwoFingerNavigating.current) {
      isDrawing.current = false;
      rawPoints.current = [];
      lastDrawnPos.current = null;
      if (activeTouches.current.size < 2) {
        isTwoFingerNavigating.current = false;
        touchNavStart.current = null;
      }
      return;
    }

    if (isPanning.current) {
      isPanning.current = false;
      return;
    }

    if (!isDrawing.current) return;
    const sPos = getScreenPos(e);
    const wPos = toWorld(sPos.x, sPos.y);

    // Finalize Stroke Eraser
    if (tool === 'stroke-eraser') {
      isDrawing.current = false;
      rawPoints.current = [];
      return;
    }

    // Finalize Lasso Eraser (Circle to delete)
    if (tool === 'lasso-eraser') {
      const lassoWorldPts = rawPoints.current;
      setActiveLassoPoints(null);
      isDrawing.current = false;
      rawPoints.current = [];

      if (lassoWorldPts && lassoWorldPts.length >= 3) {
        const toDeleteIds = [];
        const deletedItems = [];
        elementsRef.current = elementsRef.current.filter((el, idx) => {
          if (isElementInLasso(lassoWorldPts, el)) {
            toDeleteIds.push(el.id);
            deletedItems.push({ element: el, index: idx });
            return false;
          }
          return true;
        });

        if (toDeleteIds.length > 0) {
          pushUndoAction({ type: 'batch_delete', items: deletedItems });
          redrawAll();
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'whiteboard_delete_elements',
              elementIds: toDeleteIds
            }));
          }
        }
      }
      return;
    }

    // Finalize Shape
    if (tool === 'shape') {
      const startWorld = rawPoints.current[0];
      setActiveShapePreview(null);
      isDrawing.current = false;
      rawPoints.current = [];

      if (startWorld && wPos && (Math.abs(wPos.x - startWorld.x) > 3 || Math.abs(wPos.y - startWorld.y) > 3)) {
        const newShape = {
          id: `shape_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          type: 'shape',
          shapeType,
          start: startWorld,
          end: wPos,
          color,
          size
        };
        elementsRef.current.push(newShape);
        pushUndoAction({ type: 'add', element: newShape });
        redrawAll();

        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'whiteboard_element',
            element: newShape
          }));
        }
      }
      return;
    }

    // Finalize Freehand Pen / Highlighter
    const rect = canvasRef.current.getBoundingClientRect();
    const pts = rawPoints.current;

    if (!hasMoved.current && pts.length > 0) {
      // Single click dot
      const p = pts[0];
      const newDotElement = {
        id: currentElementId.current,
        type: 'stroke',
        tool,
        color,
        size,
        isDot: true,
        points: [p]
      };
      elementsRef.current.push(newDotElement);
      pushUndoAction({ type: 'add', element: newDotElement });
      redrawAll();

      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'whiteboard_element',
          element: newDotElement
        }));
      }

      if (onStroke && rect.width > 0 && rect.height > 0) {
        onStroke({
          x0: p.x / rect.width,
          y0: p.y / rect.height,
          isDot: true,
          color,
          size,
          tool
        });
      }
    } else if (hasMoved.current && lastDrawnPos.current && pts.length >= 2) {
      // Trailing segment
      const lastP = pts[pts.length - 1];
      drawQuadCurve(lastDrawnPos.current.x, lastDrawnPos.current.y, lastDrawnPos.current.x, lastDrawnPos.current.y, lastP.x, lastP.y);

      const newStrokeElement = {
        id: currentElementId.current,
        type: 'stroke',
        tool,
        color,
        size,
        points: [...pts]
      };
      elementsRef.current.push(newStrokeElement);
      pushUndoAction({ type: 'add', element: newStrokeElement });

      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'whiteboard_element',
          element: newStrokeElement
        }));
      }

      if (onStroke && rect.width > 0 && rect.height > 0) {
        onStroke({
          x0: lastDrawnPos.current.x / rect.width,
          y0: lastDrawnPos.current.y / rect.height,
          x1: lastP.x / rect.width,
          y1: lastP.y / rect.height,
          color,
          size,
          tool
        });
      }
    }

    isDrawing.current = false;
    rawPoints.current = [];
    lastDrawnPos.current = null;
  };

  // Trackpad 2-Finger Navigation & Wheel Zoom
  const handleWheel = (e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (e.ctrlKey) {
      // Intentional pinch-to-zoom on trackpad or Ctrl + Wheel zoom
      const zoomFactor = e.deltaY < 0 ? 1.05 : 0.95;
      const newZoom = Math.max(0.25, Math.min(4.0, Math.round(zoom * zoomFactor * 100) / 100));
      if (newZoom === zoom) return;

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Zoom towards cursor location
      const newPanX = mouseX - (mouseX - pan.x) * (newZoom / zoom);
      const newPanY = mouseY - (mouseY - pan.y) * (newZoom / zoom);

      setZoom(newZoom);
      setPan({ x: newPanX, y: newPanY });
    } else {
      // 2-finger trackpad drag / wheel navigates (pans) the whiteboard!
      setPan(prev => ({
        x: prev.x - e.deltaX,
        y: prev.y - e.deltaY
      }));
    }
  };

  const handleClear = (broadcast = true) => {
    clearCanvasLocal();
    if (broadcast && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'whiteboard_clear' }));
    }
  };

  const handlePasteTextToBoard = (text) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const centerWorld = toWorld(rect.width / 2, rect.height / 2);
    const newTextElement = {
      id: `text_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      type: 'text',
      text,
      x: centerWorld.x - 60,
      y: centerWorld.y
    };
    elementsRef.current.push(newTextElement);
    pushUndoAction({ type: 'add', element: newTextElement });
    redrawAll();

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'whiteboard_element',
        element: newTextElement
      }));
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#f1f5f9', userSelect: 'none' }}>
      {/* Top Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 10px',
        backgroundColor: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        zIndex: 20,
        flexWrap: 'nowrap',
        overflowX: 'auto',
        whiteSpace: 'nowrap'
      }}>
        {/* Basic Tools (Pen, Highlighter, Hand) */}
        <div style={{ display: 'flex', gap: '2px', background: '#f8fafc', padding: '2px', borderRadius: '8px', border: '1px solid #e2e8f0', flexShrink: 0 }}>
          <button 
            onClick={() => setTool('pen')}
            title="Pen"
            style={{
              padding: '5px 8px',
              borderRadius: '6px',
              background: tool === 'pen' ? '#2563eb' : 'transparent',
              color: tool === 'pen' ? '#ffffff' : '#64748b',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center'
            }}>
            <Pencil size={16} />
          </button>

          <button 
            onClick={() => setTool('highlighter')}
            title="Highlighter"
            style={{
              padding: '5px 8px',
              borderRadius: '6px',
              background: tool === 'highlighter' ? '#2563eb' : 'transparent',
              color: tool === 'highlighter' ? '#ffffff' : '#64748b',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center'
            }}>
            <Highlighter size={16} />
          </button>

          <button 
            onClick={() => {
              if (tool !== 'hand') {
                setPrevTool(tool);
                setTool('hand');
              } else {
                setTool(prevTool || 'pen');
              }
            }}
            title="Hand (Pan Board)"
            style={{
              padding: '5px 8px',
              borderRadius: '6px',
              background: tool === 'hand' ? '#2563eb' : 'transparent',
              color: tool === 'hand' ? '#ffffff' : '#64748b',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}>
            <Hand size={16} />
          </button>
        </div>

        {/* Eraser Options Dropdown */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            background: (tool === 'eraser' || tool === 'stroke-eraser' || tool === 'lasso-eraser') ? '#2563eb' : '#f8fafc',
            borderRadius: '8px',
            border: '1px solid #e2e8f0'
          }}>
            <button
              onClick={() => {
                if (tool !== 'eraser' && tool !== 'stroke-eraser' && tool !== 'lasso-eraser') {
                  setTool('eraser');
                } else {
                  setShowEraserMenu(!showEraserMenu);
                }
              }}
              title="Eraser"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '5px 8px',
                border: 'none',
                background: 'transparent',
                color: (tool === 'eraser' || tool === 'stroke-eraser' || tool === 'lasso-eraser') ? '#ffffff' : '#64748b',
                cursor: 'pointer',
                borderRadius: '8px 0 0 8px'
              }}>
              {tool === 'stroke-eraser' ? <Scissors size={16} /> : tool === 'lasso-eraser' ? <Lasso size={16} /> : <Eraser size={16} />}
              <span style={{ fontSize: '12px', fontWeight: 500 }}>
                {tool === 'stroke-eraser' ? 'Stroke' : tool === 'lasso-eraser' ? 'Lasso' : 'Eraser'}
              </span>
            </button>
            <button
              onClick={() => setShowEraserMenu(!showEraserMenu)}
              title="Eraser Modes"
              style={{
                padding: '5px 5px',
                border: 'none',
                background: 'transparent',
                color: (tool === 'eraser' || tool === 'stroke-eraser' || tool === 'lasso-eraser') ? '#ffffff' : '#64748b',
                cursor: 'pointer',
                borderRadius: '0 8px 8px 0',
                borderLeft: '1px solid rgba(200,200,200,0.3)'
              }}>
              <ChevronDown size={13} />
            </button>
          </div>

          {showEraserMenu && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              backgroundColor: '#ffffff',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
              boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
              zIndex: 50,
              minWidth: '220px',
              padding: '6px'
            }}>
              <button
                onClick={() => { setTool('eraser'); setShowEraserMenu(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  border: 'none',
                  background: tool === 'eraser' ? '#eff6ff' : 'transparent',
                  color: tool === 'eraser' ? '#2563eb' : '#334155',
                  cursor: 'pointer',
                  fontSize: '13px',
                  textAlign: 'left'
                }}>
                <Eraser size={16} />
                <div>
                  <div style={{ fontWeight: 600 }}>Brush Eraser</div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>Standard pixel brush</div>
                </div>
              </button>

              <button
                onClick={() => { setTool('stroke-eraser'); setShowEraserMenu(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  border: 'none',
                  background: tool === 'stroke-eraser' ? '#eff6ff' : 'transparent',
                  color: tool === 'stroke-eraser' ? '#2563eb' : '#334155',
                  cursor: 'pointer',
                  fontSize: '13px',
                  textAlign: 'left'
                }}>
                <Scissors size={16} />
                <div>
                  <div style={{ fontWeight: 600 }}>Stroke Eraser (Drag / Click)</div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>Sweep over or click any line to erase</div>
                </div>
              </button>

              <button
                onClick={() => { setTool('lasso-eraser'); setShowEraserMenu(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  border: 'none',
                  background: tool === 'lasso-eraser' ? '#eff6ff' : 'transparent',
                  color: tool === 'lasso-eraser' ? '#2563eb' : '#334155',
                  cursor: 'pointer',
                  fontSize: '13px',
                  textAlign: 'left'
                }}>
                <Lasso size={16} />
                <div>
                  <div style={{ fontWeight: 600 }}>Lasso Eraser</div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>Circle lines & shapes to delete</div>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Maths Dropdown Box (Shapes, Protractor, Ruler, Calculator) */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setShowMathMenu(!showMathMenu)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              padding: '5px 9px',
              borderRadius: '8px',
              backgroundColor: (tool === 'shape' || showProtractor || showRuler || showCalculator) ? '#4338ca' : '#f8fafc',
              color: (tool === 'shape' || showProtractor || showRuler || showCalculator) ? '#ffffff' : '#334155',
              border: '1px solid #cbd5e1',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600
            }}>
            <Shapes size={16} />
            <span>Maths</span>
            <ChevronDown size={13} />
          </button>

          {showMathMenu && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: '4px',
              backgroundColor: '#ffffff',
              borderRadius: '10px',
              border: '1px solid #e2e8f0',
              boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
              zIndex: 50,
              minWidth: '220px',
              padding: '8px'
            }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', padding: '4px 8px' }}>
                Geometric Shapes
              </div>

              {[
                { type: 'rectangle', label: 'Rectangle / Square', icon: <Square size={16} /> },
                { type: 'circle', label: 'Circle / Ellipse', icon: <Circle size={16} /> },
                { type: 'triangle', label: 'Triangle', icon: <Triangle size={16} /> },
                { type: 'line', label: 'Straight Line', icon: <Minus size={16} /> },
                { type: 'arrow', label: 'Arrow', icon: <ArrowRight size={16} /> },
              ].map(item => (
                <button
                  key={item.type}
                  onClick={() => {
                    setTool('shape');
                    setShapeType(item.type);
                    setShowMathMenu(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: '100%',
                    padding: '7px 10px',
                    borderRadius: '6px',
                    border: 'none',
                    background: (tool === 'shape' && shapeType === item.type) ? '#e0e7ff' : 'transparent',
                    color: (tool === 'shape' && shapeType === item.type) ? '#4338ca' : '#334155',
                    cursor: 'pointer',
                    fontSize: '13px',
                    textAlign: 'left'
                  }}>
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}

              <div style={{ height: '1px', background: '#e2e8f0', margin: '6px 0' }} />
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', padding: '4px 8px' }}>
                Maths Tools
              </div>

              <button
                onClick={() => { setShowProtractor(!showProtractor); setShowMathMenu(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: 'none',
                  background: showProtractor ? '#ecfdf5' : 'transparent',
                  color: showProtractor ? '#059669' : '#334155',
                  cursor: 'pointer',
                  fontSize: '13px'
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Compass size={16} />
                  <span>Protractor (180°)</span>
                </div>
                <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', background: showProtractor ? '#10b981' : '#f1f5f9', color: showProtractor ? '#ffffff' : '#64748b' }}>
                  {showProtractor ? 'ON' : 'OFF'}
                </span>
              </button>

              <button
                onClick={() => { setShowRuler(!showRuler); setShowMathMenu(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: 'none',
                  background: showRuler ? '#ecfdf5' : 'transparent',
                  color: showRuler ? '#059669' : '#334155',
                  cursor: 'pointer',
                  fontSize: '13px'
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <RulerIcon size={16} />
                  <span>Ruler (cm/mm)</span>
                </div>
                <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', background: showRuler ? '#10b981' : '#f1f5f9', color: showRuler ? '#ffffff' : '#64748b' }}>
                  {showRuler ? 'ON' : 'OFF'}
                </span>
              </button>

              <button
                onClick={() => { setShowCalculator(!showCalculator); setShowMathMenu(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: 'none',
                  background: showCalculator ? '#ecfdf5' : 'transparent',
                  color: showCalculator ? '#059669' : '#334155',
                  cursor: 'pointer',
                  fontSize: '13px'
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <CalcIcon size={16} />
                  <span>Calculator</span>
                </div>
                <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', background: showCalculator ? '#10b981' : '#f1f5f9', color: showCalculator ? '#ffffff' : '#64748b' }}>
                  {showCalculator ? 'ON' : 'OFF'}
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Color Palette + Paint.NET Style Square Color Picker */}
        {tool !== 'eraser' && tool !== 'stroke-eraser' && tool !== 'lasso-eraser' && tool !== 'hand' && (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', position: 'relative', flexShrink: 0 }}>
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                style={{
                  width: '20px',
                  height: '20px',
                  borderRadius: '50%',
                  backgroundColor: c,
                  border: color === c ? '2px solid #2563eb' : '1px solid #cbd5e1',
                  transform: color === c ? 'scale(1.15)' : 'scale(1)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                  cursor: 'pointer',
                  padding: 0
                }}
              />
            ))}

            {/* Square Color Picker Button */}
            <button
              onClick={() => setShowRgbPicker(!showRgbPicker)}
              title="Full RGB Color Control"
              style={{
                width: '22px',
                height: '22px',
                borderRadius: '4px',
                background: color,
                border: '2px solid #2563eb',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0
              }}>
              <Palette size={12} color={hexToRgb(color).r * 0.299 + hexToRgb(color).g * 0.587 + hexToRgb(color).b * 0.114 > 140 ? '#000000' : '#ffffff'} />
            </button>

            {/* Paint.NET Style 2D Square Color Picker Popover */}
            {showRgbPicker && (
              <PaintDotNetColorPicker
                currentColor={color}
                onSelectColor={(hex) => setColor(hex)}
                onClose={() => setShowRgbPicker(false)}
              />
            )}
          </div>
        )}

        {/* Continuous Pen Width Slider */}
        {tool !== 'hand' && (
          <div style={{ display: 'flex', gap: '5px', alignItems: 'center', padding: '2px 6px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0', flexShrink: 0 }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: '#64748b' }}>Size:</span>
            <input
              type="range"
              min="1"
              max="40"
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              style={{ width: '65px', accentColor: '#2563eb', cursor: 'pointer' }}
            />
            <div style={{
              width: '18px',
              height: '18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <div style={{
                width: `${Math.min(16, Math.max(2, size))}px`,
                height: `${Math.min(16, Math.max(2, size))}px`,
                borderRadius: '50%',
                backgroundColor: tool === 'eraser' || tool === 'stroke-eraser' || tool === 'lasso-eraser' ? '#94a3b8' : color
              }} />
            </div>
            <span style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace', minWidth: '24px' }}>
              {size}px
            </span>
          </div>
        )}

        {/* Undo and Redo buttons */}
        <div style={{ display: 'flex', gap: '2px', background: '#f8fafc', padding: '2px', borderRadius: '8px', border: '1px solid #e2e8f0', flexShrink: 0 }}>
          <button
            onClick={handleUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z / Cmd+Z)"
            style={{
              padding: '5px 8px',
              borderRadius: '6px',
              background: 'transparent',
              color: canUndo ? '#334155' : '#cbd5e1',
              border: 'none',
              cursor: canUndo ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12px'
            }}>
            <Undo2 size={16} />
          </button>
          <button
            onClick={handleRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Y / Cmd+Y)"
            style={{
              padding: '5px 8px',
              borderRadius: '6px',
              background: 'transparent',
              color: canRedo ? '#334155' : '#cbd5e1',
              border: 'none',
              cursor: canRedo ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12px'
            }}>
            <Redo2 size={16} />
          </button>
        </div>

        <div style={{ flex: 1, minWidth: '4px' }} />

        {/* Actions (Clear Board) */}
        <button
          onClick={() => handleClear(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            padding: '5px 10px',
            borderRadius: '6px',
            backgroundColor: '#fee2e2',
            color: '#b91c1c',
            fontSize: '12px',
            fontWeight: 500,
            cursor: 'pointer',
            border: 'none',
            flexShrink: 0
          }}>
          <Trash2 size={15} />
          Clear Board
        </button>
      </div>

      {/* Main Canvas Viewport with Pan, Zoom & Overlays */}
      <div 
        onWheel={handleWheel}
        style={{
          flex: 1,
          position: 'relative',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          touchAction: 'none',
          cursor: tool === 'hand' ? (isPanning.current ? 'grabbing' : 'grab') : tool === 'stroke-eraser' ? 'crosshair' : tool === 'lasso-eraser' ? 'crosshair' : tool === 'eraser' ? 'cell' : 'crosshair'
        }}>
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            touchAction: 'none',
            backgroundColor: BOARD_BG_COLOR
          }}
        />

        {/* SVG Live Preview Layer (Shapes & Lasso) */}
        <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {activeShapePreview && activeShapePreview.start && activeShapePreview.end && (
            (() => {
              const { start, end, shapeType: sType, color: sColor, size: sSize } = activeShapePreview;
              const minX = Math.min(start.x, end.x);
              const minY = Math.min(start.y, end.y);
              const width = Math.abs(end.x - start.x);
              const height = Math.abs(end.y - start.y);

              if (sType === 'rectangle') {
                return (
                  <rect
                    x={minX}
                    y={minY}
                    width={width}
                    height={height}
                    stroke={sColor}
                    strokeWidth={sSize}
                    fill="none"
                    strokeDasharray="4,4"
                  />
                );
              }
              if (sType === 'circle') {
                return (
                  <ellipse
                    cx={(start.x + end.x) / 2}
                    cy={(start.y + end.y) / 2}
                    rx={width / 2}
                    ry={height / 2}
                    stroke={sColor}
                    strokeWidth={sSize}
                    fill="none"
                    strokeDasharray="4,4"
                  />
                );
              }
              if (sType === 'triangle') {
                const points = `${start.x + width / 2},${minY} ${start.x},${end.y} ${end.x},${end.y}`;
                return (
                  <polygon
                    points={points}
                    stroke={sColor}
                    strokeWidth={sSize}
                    fill="none"
                    strokeDasharray="4,4"
                  />
                );
              }
              if (sType === 'line' || sType === 'arrow') {
                return (
                  <line
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    stroke={sColor}
                    strokeWidth={sSize}
                    strokeDasharray="4,4"
                  />
                );
              }
              return null;
            })()
          )}

          {activeLassoPoints && activeLassoPoints.length >= 2 && (
            <polygon
              points={activeLassoPoints.map(p => `${p.x},${p.y}`).join(' ')}
              stroke="#ef4444"
              strokeWidth={2}
              strokeDasharray="6,4"
              fill="rgba(239, 68, 68, 0.14)"
            />
          )}
        </svg>

        {/* Floating Zoom & Pan HUD at bottom-right */}
        <div style={{
          position: 'absolute',
          bottom: '16px',
          right: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '4px',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          border: '1px solid #e2e8f0',
          zIndex: 30
        }}>
          <button
            onClick={() => setZoom(z => Math.max(0.25, Math.round((z - 0.15) * 100) / 100))}
            title="Zoom Out"
            style={{
              padding: '6px 8px',
              borderRadius: '6px',
              border: 'none',
              background: 'transparent',
              color: '#334155',
              cursor: 'pointer'
            }}>
            <ZoomOut size={16} />
          </button>

          <button
            onClick={() => { setZoom(1.0); setPan({ x: 0, y: 0 }); }}
            title="Reset Zoom (100%)"
            style={{
              padding: '4px 8px',
              borderRadius: '4px',
              border: 'none',
              background: '#f1f5f9',
              color: '#334155',
              fontSize: '12px',
              fontWeight: 600,
              fontFamily: 'monospace',
              cursor: 'pointer'
            }}>
            {Math.round(zoom * 100)}%
          </button>

          <button
            onClick={() => setZoom(z => Math.min(4.0, Math.round((z + 0.15) * 100) / 100))}
            title="Zoom In"
            style={{
              padding: '6px 8px',
              borderRadius: '6px',
              border: 'none',
              background: 'transparent',
              color: '#334155',
              cursor: 'pointer'
            }}>
            <ZoomIn size={16} />
          </button>

          <div style={{ width: '1px', height: '18px', background: '#e2e8f0', margin: '0 2px' }} />

          <button
            onClick={() => {
              if (tool !== 'hand') {
                setPrevTool(tool);
                setTool('hand');
              } else {
                setTool(prevTool || 'pen');
              }
            }}
            title={tool === 'hand' ? 'Switch back to drawing' : 'Hand Pan Tool'}
            style={{
              padding: '6px 8px',
              borderRadius: '6px',
              border: 'none',
              background: tool === 'hand' ? '#2563eb' : 'transparent',
              color: tool === 'hand' ? '#ffffff' : '#334155',
              cursor: 'pointer'
            }}>
            <Hand size={16} />
          </button>
        </div>

        {/* Interactive Protractor Widget Overlay */}
        {showProtractor && (
          <ProtractorWidget onClose={() => setShowProtractor(false)} />
        )}

        {/* Interactive Ruler Widget Overlay */}
        {showRuler && (
          <RulerWidget onClose={() => setShowRuler(false)} />
        )}

        {/* Interactive Floating Scientific Calculator */}
        {showCalculator && (
          <CalculatorWidget 
            onClose={() => setShowCalculator(false)} 
            onPasteToBoard={handlePasteTextToBoard}
          />
        )}
      </div>
    </div>
  );
});

// Paint.NET Style 2D Square Color Picker Component
function PaintDotNetColorPicker({ currentColor, onSelectColor, onClose }) {
  const initialRgb = hexToRgb(currentColor);
  const initialHsv = rgbToHsv(initialRgb.r, initialRgb.g, initialRgb.b);

  const [hue, setHue] = useState(initialHsv.h);
  const [sat, setSat] = useState(initialHsv.s);
  const [val, setVal] = useState(initialHsv.v);

  const squareRef = useRef(null);
  const isDraggingSquare = useRef(false);

  // Sync back to hex color
  useEffect(() => {
    const rgb = hsvToRgb(hue, sat, val);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    onSelectColor(hex);
  }, [hue, sat, val]);

  const updateSquareCoord = (e) => {
    if (!squareRef.current) return;
    const rect = squareRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    const s = Math.round((x / rect.width) * 100);
    const v = Math.round((1 - y / rect.height) * 100);
    setSat(s);
    setVal(v);
  };

  const currentRgb = hsvToRgb(hue, sat, val);
  const hex = rgbToHex(currentRgb.r, currentRgb.g, currentRgb.b);

  return (
    <div style={{
      position: 'absolute',
      top: '100%',
      left: 0,
      marginTop: '8px',
      backgroundColor: '#ffffff',
      borderRadius: '12px',
      border: '1px solid #e2e8f0',
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      zIndex: 60,
      width: '250px',
      padding: '12px'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: '#1e293b' }}>Square Color Picker</div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#94a3b8' }}>
          <X size={15} />
        </button>
      </div>

      {/* 2D Saturation / Value Gradient Square (Paint.NET style) */}
      <div
        ref={squareRef}
        onPointerDown={(e) => {
          isDraggingSquare.current = true;
          try { e.target.setPointerCapture(e.pointerId); } catch {}
          updateSquareCoord(e);
        }}
        onPointerMove={(e) => {
          if (isDraggingSquare.current) updateSquareCoord(e);
        }}
        onPointerUp={(e) => {
          isDraggingSquare.current = false;
          try { e.target.releasePointerCapture(e.pointerId); } catch {}
        }}
        style={{
          width: '100%',
          height: '140px',
          borderRadius: '6px',
          position: 'relative',
          cursor: 'crosshair',
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hue}, 100%, 50%))`,
          boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)'
        }}>
        {/* Reticle / Color Picker Cursor */}
        <div style={{
          position: 'absolute',
          left: `${sat}%`,
          top: `${100 - val}%`,
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          border: '2px solid #ffffff',
          boxShadow: '0 0 2px 1px rgba(0,0,0,0.6)',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none'
        }} />
      </div>

      {/* Rainbow Hue Slider Bar */}
      <div style={{ marginTop: '10px', marginBottom: '10px' }}>
        <input
          type="range"
          min="0"
          max="360"
          value={hue}
          onChange={(e) => setHue(Number(e.target.value))}
          style={{
            width: '100%',
            height: '14px',
            borderRadius: '7px',
            appearance: 'none',
            outline: 'none',
            cursor: 'pointer',
            background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)'
          }}
        />
      </div>

      {/* Swatch & Values */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{
          width: '36px',
          height: '36px',
          borderRadius: '6px',
          backgroundColor: hex,
          border: '1px solid #cbd5e1',
          boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.1)'
        }} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontFamily: 'monospace', color: '#1e293b' }}>
            <span>HEX: {hex.toUpperCase()}</span>
            <span>H: {hue}°</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontFamily: 'monospace', color: '#64748b', marginTop: '2px' }}>
            <span>RGB: {currentRgb.r}, {currentRgb.g}, {currentRgb.b}</span>
            <span>S: {sat}% V: {val}%</span>
          </div>
        </div>
      </div>

      {/* Direct Hex Input */}
      <div style={{ display: 'flex', gap: '6px' }}>
        <input
          type="text"
          value={hex}
          onChange={(e) => {
            const valHex = e.target.value;
            if (/^#[0-9A-Fa-f]{6}$/.test(valHex)) {
              const rgb = hexToRgb(valHex);
              const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
              setHue(hsv.h);
              setSat(hsv.s);
              setVal(hsv.v);
            }
          }}
          style={{
            flex: 1,
            padding: '4px 8px',
            borderRadius: '4px',
            border: '1px solid #cbd5e1',
            fontSize: '12px',
            fontFamily: 'monospace'
          }}
        />
        <button
          onClick={onClose}
          style={{
            padding: '4px 12px',
            borderRadius: '4px',
            backgroundColor: '#2563eb',
            color: '#ffffff',
            border: 'none',
            fontSize: '12px',
            fontWeight: 500,
            cursor: 'pointer'
          }}>
          Done
        </button>
      </div>
    </div>
  );
}

// Interactive 180° Protractor Widget
function ProtractorWidget({ onClose }) {
  const [pos, setPos] = useState({ x: 180, y: 140 });
  const [rotation, setRotation] = useState(0);
  const [needleAngle, setNeedleAngle] = useState(45);
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const radius = 140;

  const handlePointerDown = (e) => {
    isDragging.current = true;
    dragOffset.current = {
      x: e.clientX - pos.x,
      y: e.clientY - pos.y
    };
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  };

  const handlePointerMove = (e) => {
    if (!isDragging.current) return;
    setPos({
      x: e.clientX - dragOffset.current.x,
      y: e.clientY - dragOffset.current.y
    });
  };

  const handlePointerUp = (e) => {
    isDragging.current = false;
    try { e.target.releasePointerCapture(e.pointerId); } catch {}
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${radius * 2}px`,
        height: `${radius + 50}px`,
        zIndex: 35,
        cursor: 'grab'
      }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '3px 8px',
        backgroundColor: 'rgba(15, 23, 42, 0.85)',
        backdropFilter: 'blur(4px)',
        borderRadius: '6px',
        color: '#f8fafc',
        fontSize: '11px',
        marginBottom: '2px',
        userSelect: 'none'
      }}>
        <span style={{ fontWeight: 600 }}>📐 {needleAngle.toFixed(1)}°</span>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button
            onClick={() => setRotation((r) => (r + 15) % 360)}
            title="Rotate Protractor 15°"
            style={{ background: 'transparent', border: 'none', color: '#38bdf8', cursor: 'pointer', padding: 0 }}>
            <RotateCw size={12} />
          </button>
          <button
            onClick={onClose}
            title="Close Protractor"
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 0 }}>
            <X size={12} />
          </button>
        </div>
      </div>

      <svg
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        width={radius * 2}
        height={radius + 10}
        style={{
          transform: `rotate(${rotation}deg)`,
          transformOrigin: `${radius}px ${radius}px`,
          filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.18))'
        }}>
        <path
          d={`M 10 ${radius} A ${radius - 10} ${radius - 10} 0 0 1 ${radius * 2 - 10} ${radius} Z`}
          fill="rgba(240, 249, 255, 0.82)"
          stroke="#0284c7"
          strokeWidth="1.5"
        />

        <line x1={radius} y1={radius - 8} x2={radius} y2={radius + 8} stroke="#0284c7" strokeWidth="1.5" />
        <line x1={radius - 8} y1={radius} x2={radius + 8} y2={radius} stroke="#0284c7" strokeWidth="1.5" />

        {Array.from({ length: 19 }).map((_, i) => {
          const deg = i * 10;
          const rad = (deg * Math.PI) / 180;
          const innerR = radius - 24;
          const outerR = radius - 10;
          const x1 = radius - outerR * Math.cos(rad);
          const y1 = radius - outerR * Math.sin(rad);
          const x2 = radius - innerR * Math.cos(rad);
          const y2 = radius - innerR * Math.sin(rad);

          const textR = radius - 34;
          const tx = radius - textR * Math.cos(rad);
          const ty = radius - textR * Math.sin(rad);

          return (
            <g key={deg}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0369a1" strokeWidth={deg % 45 === 0 ? "2" : "1"} />
              <text x={tx} y={ty + 3} fontSize="9" textAnchor="middle" fill="#0369a1" fontWeight={deg % 90 === 0 ? "bold" : "normal"}>
                {deg}
              </text>
            </g>
          );
        })}

        {(() => {
          const rad = (needleAngle * Math.PI) / 180;
          const nx = radius - (radius - 12) * Math.cos(rad);
          const ny = radius - (radius - 12) * Math.sin(rad);
          return (
            <g>
              <line x1={radius} y1={radius} x2={nx} y2={ny} stroke="#ef4444" strokeWidth="2" strokeDasharray="3,2" />
              <circle
                cx={nx}
                cy={ny}
                r="7"
                fill="#ef4444"
                stroke="#ffffff"
                strokeWidth="1.5"
                style={{ cursor: 'pointer' }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  const onNeedleMove = (ev) => {
                    const rect = e.target.ownerSVGElement.getBoundingClientRect();
                    const cx = rect.left + radius;
                    const cy = rect.top + radius;
                    const dx = cx - ev.clientX;
                    const dy = cy - ev.clientY;
                    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                    if (angle < 0) angle = 0;
                    if (angle > 180) angle = 180;
                    setNeedleAngle(angle);
                  };
                  const onNeedleUp = () => {
                    window.removeEventListener('pointermove', onNeedleMove);
                    window.removeEventListener('pointerup', onNeedleUp);
                  };
                  window.addEventListener('pointermove', onNeedleMove);
                  window.addEventListener('pointerup', onNeedleUp);
                }}
              />
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

// Interactive Metric Ruler Widget
function RulerWidget({ onClose }) {
  const [pos, setPos] = useState({ x: 200, y: 320 });
  const [rotation, setRotation] = useState(0);
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const length = 360;
  const height = 54;

  const handlePointerDown = (e) => {
    isDragging.current = true;
    dragOffset.current = {
      x: e.clientX - pos.x,
      y: e.clientY - pos.y
    };
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  };

  const handlePointerMove = (e) => {
    if (!isDragging.current) return;
    setPos({
      x: e.clientX - dragOffset.current.x,
      y: e.clientY - dragOffset.current.y
    });
  };

  const handlePointerUp = (e) => {
    isDragging.current = false;
    try { e.target.releasePointerCapture(e.pointerId); } catch {}
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${length}px`,
        height: `${height + 26}px`,
        zIndex: 35,
        cursor: 'grab'
      }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '2px 8px',
        backgroundColor: 'rgba(15, 23, 42, 0.85)',
        backdropFilter: 'blur(4px)',
        borderRadius: '6px',
        color: '#f8fafc',
        fontSize: '11px',
        marginBottom: '2px',
        userSelect: 'none'
      }}>
        <span>📏 12.0 cm (360 px)</span>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button
            onClick={() => setRotation((r) => (r + 15) % 360)}
            title="Rotate Ruler 15°"
            style={{ background: 'transparent', border: 'none', color: '#38bdf8', cursor: 'pointer', padding: 0 }}>
            <RotateCw size={12} />
          </button>
          <button
            onClick={onClose}
            title="Close Ruler"
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 0 }}>
            <X size={12} />
          </button>
        </div>
      </div>

      <svg
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        width={length}
        height={height}
        style={{
          transform: `rotate(${rotation}deg)`,
          transformOrigin: 'top left',
          filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.18))'
        }}>
        <rect
          x="0"
          y="0"
          width={length}
          height={height}
          rx="4"
          fill="rgba(254, 252, 232, 0.85)"
          stroke="#ca8a04"
          strokeWidth="1.5"
        />

        {Array.from({ length: 120 }).map((_, mm) => {
          const x = mm * 3;
          if (x > length) return null;
          const isCm = mm % 10 === 0;
          const isHalfCm = mm % 5 === 0 && !isCm;
          const tickLen = isCm ? 18 : isHalfCm ? 12 : 6;

          return (
            <g key={mm}>
              <line x1={x} y1={0} x2={x} y2={tickLen} stroke="#854d0e" strokeWidth={isCm ? "1.5" : "0.75"} />
              {isCm && (
                <text x={x + 2} y={tickLen + 10} fontSize="10" fill="#854d0e" fontWeight="bold">
                  {mm / 10}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Floating Scientific Calculator Widget
function CalculatorWidget({ onClose, onPasteToBoard }) {
  const [pos, setPos] = useState({ x: 240, y: 160 });
  const [expr, setExpr] = useState('');
  const [display, setDisplay] = useState('0');
  const [isScientific, setIsScientific] = useState(false);
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const handlePointerDown = (e) => {
    isDragging.current = true;
    dragOffset.current = {
      x: e.clientX - pos.x,
      y: e.clientY - pos.y
    };
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  };

  const handlePointerMove = (e) => {
    if (!isDragging.current) return;
    setPos({
      x: e.clientX - dragOffset.current.x,
      y: e.clientY - dragOffset.current.y
    });
  };

  const handlePointerUp = (e) => {
    isDragging.current = false;
    try { e.target.releasePointerCapture(e.pointerId); } catch {}
  };

  const handlePress = (val) => {
    if (val === 'C') {
      setExpr('');
      setDisplay('0');
      return;
    }

    if (val === 'DEL') {
      const next = expr.slice(0, -1);
      setExpr(next);
      setDisplay(next || '0');
      return;
    }

    if (val === '=') {
      try {
        let safeExpr = expr
          .replace(/×/g, '*')
          .replace(/÷/g, '/')
          .replace(/π/g, 'Math.PI')
          .replace(/e/g, 'Math.E')
          .replace(/sin\(/g, 'Math.sin((Math.PI/180)*')
          .replace(/cos\(/g, 'Math.cos((Math.PI/180)*')
          .replace(/tan\(/g, 'Math.tan((Math.PI/180)*')
          .replace(/√\(/g, 'Math.sqrt(');

        if (/[a-zA-Z_$]/.test(safeExpr.replace(/Math\.(sin|cos|tan|sqrt|PI|E)/g, ''))) {
          setDisplay('Error');
          return;
        }

        const res = Function(`"use strict"; return (${safeExpr})`)();
        const formatted = typeof res === 'number' ? (Number.isInteger(res) ? String(res) : res.toFixed(4).replace(/\.?0+$/, '')) : 'Error';
        setDisplay(formatted);
      } catch {
        setDisplay('Error');
      }
      return;
    }

    const next = expr + val;
    setExpr(next);
    setDisplay(next);
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: isScientific ? '320px' : '260px',
        backgroundColor: '#1e293b',
        borderRadius: '12px',
        border: '1px solid #334155',
        boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
        zIndex: 40,
        userSelect: 'none',
        overflow: 'hidden'
      }}>
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          padding: '8px 12px',
          backgroundColor: '#0f172a',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'grab',
          borderBottom: '1px solid #334155'
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: '#f8fafc' }}>
          <CalcIcon size={14} color="#38bdf8" />
          <span>Calculator</span>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button
            onClick={() => setIsScientific(!isScientific)}
            style={{
              background: isScientific ? '#3b82f6' : '#334155',
              color: '#ffffff',
              border: 'none',
              borderRadius: '4px',
              padding: '2px 6px',
              fontSize: '10px',
              cursor: 'pointer'
            }}>
            {isScientific ? 'Standard' : 'Scientific'}
          </button>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 0 }}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div style={{ padding: '12px', backgroundColor: '#0f172a', borderBottom: '1px solid #334155', textAlign: 'right' }}>
        <div style={{ fontSize: '11px', color: '#94a3b8', minHeight: '16px', overflow: 'hidden' }}>{expr || '0'}</div>
        <div style={{ fontSize: '20px', fontWeight: 700, color: '#38bdf8', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {display}
        </div>
      </div>

      <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {isScientific && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px', marginBottom: '4px' }}>
            {['sin(', 'cos(', 'tan(', '√(', 'π', '(', ')', '^'].map((key) => (
              <button
                key={key}
                onClick={() => handlePress(key)}
                style={{
                  padding: '6px',
                  borderRadius: '4px',
                  backgroundColor: '#334155',
                  color: '#93c5fd',
                  border: 'none',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}>
                {key}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px' }}>
          {['C', 'DEL', '%', '÷'].map((k) => (
            <button
              key={k}
              onClick={() => handlePress(k)}
              style={{
                padding: '10px',
                borderRadius: '6px',
                backgroundColor: '#475569',
                color: '#ffffff',
                border: 'none',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer'
              }}>
              {k}
            </button>
          ))}

          {['7', '8', '9', '×'].map((k) => (
            <button
              key={k}
              onClick={() => handlePress(k)}
              style={{
                padding: '10px',
                borderRadius: '6px',
                backgroundColor: k === '×' ? '#f59e0b' : '#1e293b',
                color: '#ffffff',
                border: '1px solid #334155',
                fontWeight: 600,
                fontSize: '14px',
                cursor: 'pointer'
              }}>
              {k}
            </button>
          ))}

          {['4', '5', '6', '-'].map((k) => (
            <button
              key={k}
              onClick={() => handlePress(k)}
              style={{
                padding: '10px',
                borderRadius: '6px',
                backgroundColor: k === '-' ? '#f59e0b' : '#1e293b',
                color: '#ffffff',
                border: '1px solid #334155',
                fontWeight: 600,
                fontSize: '14px',
                cursor: 'pointer'
              }}>
              {k}
            </button>
          ))}

          {['1', '2', '3', '+'].map((k) => (
            <button
              key={k}
              onClick={() => handlePress(k)}
              style={{
                padding: '10px',
                borderRadius: '6px',
                backgroundColor: k === '+' ? '#f59e0b' : '#1e293b',
                color: '#ffffff',
                border: '1px solid #334155',
                fontWeight: 600,
                fontSize: '14px',
                cursor: 'pointer'
              }}>
              {k}
            </button>
          ))}

          {['0', '.', '='].map((k) => (
            <button
              key={k}
              onClick={() => handlePress(k)}
              style={{
                gridColumn: k === '=' ? 'span 2' : 'span 1',
                padding: '10px',
                borderRadius: '6px',
                backgroundColor: k === '=' ? '#2563eb' : '#1e293b',
                color: '#ffffff',
                border: '1px solid #334155',
                fontWeight: 700,
                fontSize: '14px',
                cursor: 'pointer'
              }}>
              {k}
            </button>
          ))}
        </div>

        <button
          onClick={() => {
            if (display && display !== 'Error') {
              onPasteToBoard(`${expr || display} = ${display}`);
            }
          }}
          style={{
            marginTop: '4px',
            padding: '8px',
            borderRadius: '6px',
            backgroundColor: '#059669',
            color: '#ffffff',
            border: 'none',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px'
          }}>
          <span>Paste Result to Whiteboard</span>
        </button>
      </div>
    </div>
  );
}

export default Whiteboard;
