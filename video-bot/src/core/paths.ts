import * as path from 'path';

export const paths = {
  scripts: {
    analyzeAudio: path.join(process.cwd(), 'scripts', 'analyze_audio.py'),
    humeAnalyze: path.join(process.cwd(), 'scripts', 'hume_analyze.py'),
  },
  session: {
    originalAudio: (sessionDir: string, videoId: string) => path.join(sessionDir, `${videoId}.wav`),
    dubbedAudio: (sessionDir: string, videoId: string) => path.join(sessionDir, `${videoId}.dub.mp3`),
    finalVideo: (sessionDir: string, videoId: string) => path.join(sessionDir, `${videoId}.final.mp4`),
  },
};
