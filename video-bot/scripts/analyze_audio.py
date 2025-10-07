import sys
import json
import librosa
import numpy as np
from pydub import AudioSegment
from pyannote.audio import Pipeline
import torch
import os

# Получаем токен из переменных окружения
HF_TOKEN = os.environ.get("HF_TOKEN")

def analyze_audio(file_path):
    try:
        if not HF_TOKEN:
            raise ValueError("Hugging Face token not found. Please set the HF_TOKEN environment variable.")

        # 1. Диаризация: "Кто и когда говорил"
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=HF_TOKEN
        )
        # Принудительно используем CPU, чтобы избежать проблем без GPU
        pipeline.to(torch.device("cpu"))

        diarization = pipeline(file_path)

        # 2. Определение пола каждого спикера
        audio = AudioSegment.from_wav(file_path)
        speakers = {}
        for segment, _, speaker_id in diarization.itertracks(yield_label=True):
            if speaker_id not in speakers:
                speaker_segment = audio[segment.start * 1000 : segment.end * 1000]

                if len(speaker_segment) < 100:
                    continue

                samples = np.array(speaker_segment.get_array_of_samples()).astype(np.float32)

                f0, _, _ = librosa.pyin(y=samples, fmin=60, fmax=400, sr=speaker_segment.frame_rate)
                mean_f0 = np.nanmean(f0)

                gender = "unknown"
                if mean_f0 and not np.isnan(mean_f0):
                    gender = "male" if mean_f0 < 165 else "female"

                speakers[speaker_id] = {"gender": gender}

        segments_list = [
            {"speaker": speaker_id, "start": round(segment.start, 3), "end": round(segment.end, 3)}
            for segment, _, speaker_id in diarization.itertracks(yield_label=True)
        ]

        return {"speakers": speakers, "segments": segments_list}

    except Exception as e:
        return {"speakers": {}, "segments": [], "error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) > 1:
        analysis_result = analyze_audio(sys.argv[1])
        print(json.dumps(analysis_result, indent=2))
