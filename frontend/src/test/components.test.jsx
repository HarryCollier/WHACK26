import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import Lobby from '../components/Lobby';
import Whiteboard from '../components/Whiteboard';
import AICoachPanel, { LiveEngagementBadge } from '../components/AICoachPanel';
import CoachNotebook from '../components/CoachNotebook';
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

describe('AI Coach & Engagement Components', () => {
  it('renders LiveEngagementBadge and handles click', () => {
    const handleClick = vi.fn();
    render(<LiveEngagementBadge roomCode="TEST1" role="tutor" onClick={handleClick} />);
    
    const badge = screen.getByRole('button');
    expect(badge).toBeInTheDocument();
    fireEvent.click(badge);
    expect(handleClick).toHaveBeenCalled();
  });

  it('renders AICoachPanel with pedagogical coaching metrics', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        summary: "Balanced lesson flow with strong student participation.",
        comprehension_rating: "High",
        comprehension_score: 88,
        pacing: {
          tutor_talk_pct: 60,
          student_talk_pct: 40,
          status: "Balanced",
          advice: "Good pacing and wait time."
        },
        friction_points: [],
        whiteboard_feedback: "Active whiteboard diagramming.",
        actionable_tips: ["Keep up the interactive questions."]
      })
    });

    render(<AICoachPanel roomCode="TEST1" role="tutor" isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText(/AI Pedagogical Coach/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Balanced lesson flow/i)).toBeInTheDocument();
      expect(screen.getByText(/88\/100/i)).toBeInTheDocument();
      expect(screen.getByText(/Talk-Time Split/i)).toBeInTheDocument();
    });
  });

  it('renders CoachNotebook with exactly 2 positives, 2 negatives, and 2m sync badge', () => {
    const handleApply = vi.fn();
    const mockNotes = {
      positives: [
        'Positive 1: High student attentiveness during calculation.',
        'Positive 2: Balanced turn taking between tutor and student.'
      ],
      negatives: [
        'Negative 1: Brow furrow confusion detected on multi-step fraction.',
        'Negative 2: Extend wait time after asking questions to 4 seconds.'
      ],
      lastUpdated: Date.now() - 30000
    };

    render(
      <CoachNotebook
        isOpen={true}
        onToggle={vi.fn()}
        coachNotes={mockNotes}
        onApplyExample={handleApply}
      />
    );

    expect(screen.getByText(/Live Coach Notes/i)).toBeInTheDocument();
    expect(screen.getByText(/2m Sync/i)).toBeInTheDocument();
    expect(screen.getByText(/2 Positives \(What's Going Well\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Positive 1: High student attentiveness/i)).toBeInTheDocument();
    expect(screen.getByText(/Positive 2: Balanced turn taking/i)).toBeInTheDocument();

    expect(screen.getByText(/2 Areas to Improve \(Needs Attention\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Negative 1: Brow furrow confusion/i)).toBeInTheDocument();
    expect(screen.getByText(/Negative 2: Extend wait time/i)).toBeInTheDocument();
  });
});
