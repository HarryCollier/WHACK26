import '@testing-library/jest-dom';

// Mock HTMLCanvasElement.getContext
HTMLCanvasElement.prototype.getContext = () => ({
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  lineCap: '',
  lineJoin: '',
  globalAlpha: 1.0,
  fillRect: () => {},
  clearRect: () => {},
  getImageData: () => ({ width: 0, height: 0, data: [] }),
  putImageData: () => {},
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  stroke: () => {},
  save: () => {},
  restore: () => {},
  drawImage: () => {}
});

HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,mockCanvasData';
