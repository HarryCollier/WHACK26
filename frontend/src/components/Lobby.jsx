import React, { useState } from 'react';
import { Video, BookOpen, Users } from 'lucide-react';

const Lobby = ({ onEnterRoom }) => {
  const [activeTab, setActiveTab] = useState('tutor'); // 'tutor' | 'student'
  const [title, setTitle] = useState('');
  const [passcode, setPasscode] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const backendUrl = 'http://localhost:8000';

  const handleCreateRoom = async (e) => {
    e.preventDefault();
    if (!passcode) {
      setError('Please provide a room passcode.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch(`${backendUrl}/api/rooms/create/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title || 'Tutoring Session',
          passcode
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create room.');

      onEnterRoom({
        roomCode: data.room_code,
        title: data.title,
        role: 'tutor'
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleJoinRoom = async (e) => {
    e.preventDefault();
    if (!roomCode || !passcode) {
      setError('Both Room Code and Passcode are required.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch(`${backendUrl}/api/rooms/join/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_code: roomCode.trim().toUpperCase(),
          passcode
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to join room.');

      onEnterRoom({
        roomCode: data.room_code,
        title: data.title,
        role: 'student'
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      backgroundColor: '#0f172a',
      padding: '20px'
    }}>
      <div style={{
        width: '100%',
        maxWidth: '440px',
        backgroundColor: '#1e293b',
        borderRadius: '16px',
        border: '1px solid #334155',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          padding: '28px 24px 20px',
          textAlign: 'center',
          background: 'linear-gradient(180deg, #1e293b 0%, #172033 100%)',
          borderBottom: '1px solid #334155'
        }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '52px',
            height: '52px',
            borderRadius: '14px',
            backgroundColor: '#2563eb',
            color: '#ffffff',
            marginBottom: '12px'
          }}>
            <BookOpen size={28} />
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#f8fafc' }}>
            Tutoring Assistant
          </h1>
          <p style={{ fontSize: '13px', color: '#94a3b8', marginTop: '4px' }}>
            Whiteboard, Camera & Audio Interactive Space
          </p>
        </div>

        {/* Tab Switcher */}
        <div style={{ display: 'flex', borderBottom: '1px solid #334155' }}>
          <button
            onClick={() => { setActiveTab('tutor'); setError(''); }}
            style={{
              flex: 1,
              padding: '12px',
              backgroundColor: activeTab === 'tutor' ? '#1e293b' : '#0f172a',
              color: activeTab === 'tutor' ? '#38bdf8' : '#64748b',
              fontWeight: 600,
              fontSize: '14px',
              borderBottom: activeTab === 'tutor' ? '2px solid #38bdf8' : 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}>
            <Users size={16} />
            Create as Tutor
          </button>

          <button
            onClick={() => { setActiveTab('student'); setError(''); }}
            style={{
              flex: 1,
              padding: '12px',
              backgroundColor: activeTab === 'student' ? '#1e293b' : '#0f172a',
              color: activeTab === 'student' ? '#38bdf8' : '#64748b',
              fontWeight: 600,
              fontSize: '14px',
              borderBottom: activeTab === 'student' ? '2px solid #38bdf8' : 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}>
            <Video size={16} />
            Join as Student
          </button>
        </div>

        {/* Error Notification */}
        {error && (
          <div style={{
            margin: '16px 24px 0',
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

        {/* Tutor: Create Form */}
        {activeTab === 'tutor' ? (
          <form onSubmit={handleCreateRoom} style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#cbd5e1', marginBottom: '6px' }}>
                Session Title (Optional)
              </label>
              <input
                type="text"
                placeholder="e.g. Calculus 101, Physics Lab"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  fontSize: '14px'
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#cbd5e1', marginBottom: '6px' }}>
                Room Passcode (Required)
              </label>
              <input
                type="password"
                placeholder="Set a password for student entry"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  fontSize: '14px'
                }}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: '8px',
                padding: '12px',
                borderRadius: '8px',
                backgroundColor: '#2563eb',
                color: '#ffffff',
                fontWeight: 600,
                fontSize: '14px',
                boxShadow: '0 4px 6px -1px rgba(37, 99, 235, 0.4)'
              }}>
              {loading ? 'Creating Room...' : 'Create & Launch Room'}
            </button>
          </form>
        ) : (
          /* Student: Join Form */
          <form onSubmit={handleJoinRoom} style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#cbd5e1', marginBottom: '6px' }}>
                Room Code
              </label>
              <input
                type="text"
                placeholder="e.g. A3F89C"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  fontSize: '14px',
                  textTransform: 'uppercase',
                  letterSpacing: '1px'
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#cbd5e1', marginBottom: '6px' }}>
                Room Passcode
              </label>
              <input
                type="password"
                placeholder="Enter room password"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  fontSize: '14px'
                }}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: '8px',
                padding: '12px',
                borderRadius: '8px',
                backgroundColor: '#059669',
                color: '#ffffff',
                fontWeight: 600,
                fontSize: '14px',
                boxShadow: '0 4px 6px -1px rgba(5, 150, 105, 0.4)'
              }}>
              {loading ? 'Joining Room...' : 'Join Session'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default Lobby;
