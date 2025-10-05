import sys
import librosa
import numpy as np

def detect_gender(file_path):
    try:
        y, sr = librosa.load(file_path, sr=16000)
        pitches, _ = librosa.piptrack(y=y, sr=sr)
        valid_pitches = pitches[pitches > 0]
        if len(valid_pitches) == 0:
            return "unknown"
        avg_pitch = np.mean(valid_pitches)
        if avg_pitch < 165:
            return "male"
        elif avg_pitch >= 165:
            return "female"
        else:
            return "unknown"
    except Exception:
        return "unknown"

if __name__ == "__main__":
    if len(sys.argv) > 1:
        result = detect_gender(sys.argv[1])
        print(result)
