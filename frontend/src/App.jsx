import React, { useState } from 'react';
import Lobby from './components/Lobby';
import MeetingRoom from './components/MeetingRoom';

function App() {
  const [currentSession, setCurrentSession] = useState(null);

  return (
    <div className="app-container">
      {!currentSession ? (
        <Lobby onEnterRoom={(session) => setCurrentSession(session)} />
      ) : (
        <MeetingRoom 
          session={currentSession} 
          onLeave={() => setCurrentSession(null)} 
        />
      )}
    </div>
  );
}

export default App;
