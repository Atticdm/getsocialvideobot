import sys
import json
import librosa
import numpy as np
from pydub import AudioSegment, silence

def analyze_audio(file_path):
    try:
        y, sr = librosa.load(file_path, sr=16000)
        pitches, _ = librosa.piptrack(y=y, sr=sr)
        valid_pitches = pitches[pitches > 0]

        gender = "unknown"
        if len(valid_pitches) > 0:
            avg_pitch = np.mean(valid_pitches)
            gender = "male" if avg_pitch < 165 else "female"

        audio = AudioSegment.from_wav(file_path)
        segments = silence.detect_nonsilent(
            audio,
            min_silence_len=500,
            silence_thresh=-40,
            seek_step=1
        )

        timeline = []
        last_end = 0
        for start_ms, end_ms in segments:
            if start_ms > last_end:
                timeline.append({
                    "type": "pause",
                    "start": last_end / 1000.0,
                    "end": start_ms / 1000.0
                })
            timeline.append({
                "type": "speech",
                "start": start_ms / 1000.0,
                "end": end_ms / 1000.0
            })
            last_end = end_ms

        total_duration_ms = len(audio)
        if last_end < total_duration_ms:
            timeline.append({
                "type": "pause",
                "start": last_end / 1000.0,
                "end": total_duration_ms / 1000.0
            })

        return {"gender": gender, "timeline": timeline}

    except Exception as e:
        return {"gender": "unknown", "timeline": [], "error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) > 1:
        analysis_result = analyze_audio(sys.argv[1])
        print(json.dumps(analysis_result))
