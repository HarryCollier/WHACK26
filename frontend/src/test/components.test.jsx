import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import Lobby from '../components/Lobby';
import Whiteboard from '../components/Whiteboard';
import { STREAM_CONFIG } from '../config/streamConfig';

describe('STREAM_CONFIG', () => {
  it('defines required configurable intervals for reports & video processing', () => {
    expect(STREAM_CONFIG.VIDEO_SNAPSHOT_INTERVAL_MS).toBe(500);
    expect(STREAM_CONFIG.WHITEBOARD_SNAPSHOT_INTERVAL_MS).toBeGreaterThan(0);
    expect(STREAM_CONFIG.AUDIO_CHUNK_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe('Lobby Component', () => {
  it('renders tab switcher between tutor and student', () => {
    render(<Lobby onEnterRoom={vi.fn()} />);
    expect(screen.getByText(/Create as Tutor/i)).toBeInTheDocument();
    expect(screen.getByText(/Join as Student/i)).toBeInTheDocument();
  });

  it('switches to student join form and handles join submission', async () => {
    const mockEnter = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ room_code: 'JOINED1', title: 'Session', role: 'student' })
    });

    render(<Lobby onEnterRoom={mockEnter} />);
    
    // Switch to student tab
    fireEvent.click(screen.getByText(/Join as Student/i));
    expect(screen.getByText(/Join Session/i)).toBeInTheDocument();

    const roomInput = screen.getByPlaceholderText(/e\.g\. A3F89C/i);
    const passInput = screen.getByPlaceholderText(/Enter room password/i);

    fireEvent.change(roomInput, { target: { value: 'JOINED1' } });
    fireEvent.change(passInput, { target: { value: 'secretPass' } });

    fireEvent.click(screen.getByText(/Join Session/i));

    await waitFor(() => {
      expect(mockEnter).toHaveBeenCalledWith({
        roomCode: 'JOINED1',
        title: 'Session',
        role: 'student'
      });
    });
  });

  it('calls create room API when submitting as tutor', async () => {
    const mockEnter = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ room_code: 'ROOM99', title: 'Calculus', role: 'tutor' })
    });

    render(<Lobby onEnterRoom={mockEnter} />);
    const passcodeInputs = screen.getAllByPlaceholderText(/Set a password for student entry/i);
    fireEvent.change(passcodeInputs[0], { target: { value: 'secretpass' } });

    fireEvent.click(screen.getByText(/Create & Launch Room/i));

    await waitFor(() => {
      expect(mockEnter).toHaveBeenCalledWith({
        roomCode: 'ROOM99',
        title: 'Calculus',
        role: 'tutor'
      });
    });
  });
});

describe('Whiteboard Component', () => {
  it('renders tools and allows tool selection', () => {
    render(<Whiteboard />);
    expect(screen.getByTitle('Pen')).toBeInTheDocument();
    expect(screen.getByTitle('Highlighter')).toBeInTheDocument();
    expect(screen.getByTitle('Eraser')).toBeInTheDocument();
    expect(screen.getByTitle(/Hand \(Pan Board\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Clear Board/i)).toBeInTheDocument();
    expect(screen.queryByText(/Save Snapshot/i)).toBeNull();
  });

  it('exposes snapshot and clear methods via ref', () => {
    const ref = React.createRef();
    render(<Whiteboard ref={ref} />);
    
    expect(typeof ref.current.getSnapshot).toBe('function');
    expect(typeof ref.current.clearBoard).toBe('function');

    const snapshot = ref.current.getSnapshot();
    expect(snapshot).toContain('data:image/jpeg;base64');
  });

  it('renders maths dropdown, rgb color control, and eraser mode dropdown', () => {
    render(<Whiteboard />);
    expect(screen.getByText('Maths')).toBeInTheDocument();
    expect(screen.getByTitle('Full RGB Color Control')).toBeInTheDocument();
    expect(screen.getByTitle('Eraser Modes')).toBeInTheDocument();
  });
});
