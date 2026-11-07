// Configurable sample rates for all media feeds
// Modify here or inject via environment/settings for report generation
export const STREAM_CONFIG = {
  // Video snapshot interval: every 0.5s (500ms) as requested
  VIDEO_SNAPSHOT_INTERVAL_MS: 500,

  // Whiteboard content monitoring interval (e.g. every 3 seconds)
  WHITEBOARD_SNAPSHOT_INTERVAL_MS: 3000,

  // Audio slicing interval for live transcription chunking (e.g. every 3 seconds)
  AUDIO_CHUNK_INTERVAL_MS: 3000,

  // Video resolution for snapshots
  VIDEO_WIDTH: 480,
  VIDEO_HEIGHT: 360,
  VIDEO_QUALITY: 0.65
};
