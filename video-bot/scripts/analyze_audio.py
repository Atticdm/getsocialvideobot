import sys
import json
import os
import traceback

from huggingface_hub import login


def analyze_audio(file_path: str) -> dict:
    debug_info: dict[str, object] = {}

    try:
        import numpy as np  # type: ignore
        import librosa  # type: ignore
        from pydub import AudioSegment  # type: ignore
        from pyannote.audio import Pipeline  # type: ignore
        from pyannote.audio import Model  # type: ignore
        import torch  # type: ignore
        debug_info["numpyVersion"] = np.__version__
    except Exception as import_error:
        return {
            "speakers": {},
            "segments": [],
            "error": f"Failed to import required modules: {import_error}",
            "traceback": traceback.format_exc(),
            "stage": "imports",
            "debug": debug_info,
        }

    hf_token = os.environ.get("HF_TOKEN")

    try:
        if not hf_token:
            raise ValueError("Hugging Face token not found. Please set the HF_TOKEN environment variable.")

        login(hf_token)

        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization")
        debug_info["pipeline"] = "pyannote/speaker-diarization"

        # Ensure embedding model is available (pyannote>=3.2)
        Model.from_pretrained("pyannote/embedding")
        pipeline.to(torch.device("cpu"))

        diarization = pipeline(file_path)

        audio = AudioSegment.from_wav(file_path)
        speakers: dict[str, dict[str, str]] = {}
        segments_list = []

        for segment, _, speaker_id in diarization.itertracks(yield_label=True):
            if speaker_id not in speakers:
                speaker_segment = audio[segment.start * 1000: segment.end * 1000]

                if len(speaker_segment) < 100:
                    continue

                samples = np.array(speaker_segment.get_array_of_samples()).astype(np.float32)

                f0, _, _ = librosa.pyin(y=samples, fmin=60, fmax=400, sr=speaker_segment.frame_rate)
                mean_f0 = np.nanmean(f0)

                gender = "unknown"
                if mean_f0 and not np.isnan(mean_f0):
                    gender = "male" if mean_f0 < 165 else "female"

                speakers[speaker_id] = {"gender": gender}

            segments_list.append({
                "speaker": speaker_id,
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
            })

        debug_info.update({
            "speakersCount": len(speakers),
            "segmentsCount": len(segments_list),
        })
        return {"speakers": speakers, "segments": segments_list, "debug": debug_info}

    except Exception as e:
        return {
            "speakers": {},
            "segments": [],
            "error": str(e),
            "traceback": traceback.format_exc(),
            "stage": "pipeline",
            "debug": debug_info,
        }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        analysis_result = analyze_audio(sys.argv[1])
        print(json.dumps(analysis_result))
