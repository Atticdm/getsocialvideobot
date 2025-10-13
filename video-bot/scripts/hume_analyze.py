#!/usr/bin/env python3
"""
Collect prosody and transcription insights from Hume AI and print a JSON payload
for the TypeScript translation pipeline.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from hume.client import HumeClient
from hume.core import ApiError
from hume.expression_measurement.batch.types.inference_base_request import InferenceBaseRequest
from hume.expression_measurement.batch.types.models import Models
from hume.expression_measurement.batch.types.prosody import Prosody
from hume.expression_measurement.batch.types.transcription import Transcription
from hume.expression_measurement.batch.types.union_predict_result import UnionPredictResult


class AnalysisError(Exception):
    """Raised when the Hume pipeline does not produce a usable payload."""


def _read_duration_seconds(audio_path: Path) -> Optional[float]:
    try:
        with wave.open(str(audio_path), "rb") as wav:
            frames = wav.getnframes()
            rate = wav.getframerate()
            if rate:
                return frames / float(rate)
    except Exception:
        pass
    return None


def _search_for_gender(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        for key, val in value.items():
            if isinstance(key, str) and key.lower() in {"gender", "speaker_gender", "bio_gender"}:
                if isinstance(val, str):
                    normalised = val.lower()
                    if normalised in {"male", "female"}:
                        return normalised
            nested = _search_for_gender(val)
            if nested:
                return nested
    elif isinstance(value, list):
        for item in value:
            nested = _search_for_gender(item)
            if nested:
                return nested
    return None


def _infer_primary_gender(raw_sections: Iterable[Dict[str, Any]]) -> str:
    for section in raw_sections:
        gender = _search_for_gender(section)
        if gender:
            return gender
    return "unknown"


def _collect_analysis(predictions: List[UnionPredictResult], duration: Optional[float]) -> Dict[str, Any]:
    segments: List[Dict[str, Any]] = []
    transcript_parts: List[str] = []
    emotion_overview: List[Dict[str, Any]] = []
    raw_dump: List[Dict[str, Any]] = []

    first_speaker: Optional[str] = None

    for result in predictions:
        raw_dump.append(result.model_dump(exclude_none=True))

        if result.error or not result.results:
            continue

        for prediction in result.results.predictions:
            prosody = prediction.models.prosody if prediction.models else None
            if not prosody:
                continue

            grouped = getattr(prosody, "grouped_predictions", None) or []
            for group in grouped:
                speaker_id = getattr(group, "id", None) or "speaker_0"
                if first_speaker is None:
                    first_speaker = speaker_id

                for entry in group.predictions:
                    time_info = getattr(entry, "time", None)
                    start = float(getattr(time_info, "begin", 0.0) or 0.0)
                    end = float(getattr(time_info, "end", start) or start)
                    emotions = [
                        {"name": emotion.name, "score": emotion.score}
                        for emotion in getattr(entry, "emotions", []) or []
                    ]

                    segments.append(
                        {
                            "speaker": speaker_id,
                            "start": start,
                            "end": end,
                            "type": "speech",
                            "text": getattr(entry, "text", "") or "",
                            "emotions": emotions,
                        }
                    )

                    if entry.text:
                        transcript_parts.append(entry.text.strip())

                    if emotions:
                        strongest = max(emotions, key=lambda emo: emo["score"])
                        emotion_overview.append(
                            {
                                "speaker": speaker_id,
                                "start": start,
                                "end": end,
                                "dominantEmotion": strongest["name"],
                                "confidence": strongest["score"],
                            }
                        )

    if not segments:
        speaker_id = first_speaker or "speaker_0"
        segments = [
            {
                "speaker": speaker_id,
                "start": 0.0,
                "end": float(duration or 0.0),
                "type": "speech",
                "text": "",
                "emotions": [],
            }
        ]

    segments.sort(key=lambda item: item.get("start", 0.0))

    primary_speaker = first_speaker or segments[0]["speaker"]
    gender = _infer_primary_gender(raw_dump)

    return {
        "duration": duration,
        "speakers": {primary_speaker: {"gender": gender}},
        "segments": segments,
        "transcript": " ".join(transcript_parts).strip(),
        "emotions": emotion_overview,
        "raw": raw_dump,
    }


def _start_job(client: HumeClient, audio_path: Path) -> str:
    request = InferenceBaseRequest(
        models=Models(
            prosody=Prosody(identify_speakers=True),
        ),
        transcription=Transcription(identify_speakers=True),
    )
    file_name = audio_path.name or "audio.wav"
    mime_type = _guess_mime(audio_path)
    with audio_path.open("rb") as audio_file:
        file_tuple = (file_name, audio_file, mime_type)
        return client.expression_measurement.batch.start_inference_job_from_local_file(
            file=[file_tuple],
            json=request.model_dump(mode="json", exclude_none=True),
        )


def _guess_mime(audio_path: Path) -> str:
    suffix = audio_path.suffix.lower()
    if suffix in {".wav", ".wave"}:
        return "audio/wav"
    if suffix == ".mp3":
        return "audio/mpeg"
    if suffix in {".m4a", ".aac"}:
        return "audio/mp4"
    if suffix == ".ogg":
        return "audio/ogg"
    if suffix == ".flac":
        return "audio/flac"
    return "application/octet-stream"


def _log_ffprobe(audio_path: Path) -> None:
    try:
        size_bytes = audio_path.stat().st_size
        print(f"[hume_analyze] audio file: path={audio_path} size_bytes={size_bytes}", file=sys.stderr)
    except Exception as exc:  # pragma: no cover - diagnostics only
        print(f"[hume_analyze] failed to stat audio file: {exc}", file=sys.stderr)

    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                str(audio_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        stdout = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()
        if stdout:
            preview = stdout if len(stdout) <= 2000 else stdout[:2000] + "..."
            print(f"[hume_analyze] ffprobe stdout:\n{preview}", file=sys.stderr)
        if stderr:
            preview_err = stderr if len(stderr) <= 2000 else stderr[:2000] + "..."
            print(f"[hume_analyze] ffprobe stderr:\n{preview_err}", file=sys.stderr)
    except FileNotFoundError:
        print("[hume_analyze] ffprobe not available in PATH", file=sys.stderr)
    except Exception as exc:  # pragma: no cover
        print(f"[hume_analyze] ffprobe invocation failed: {exc}", file=sys.stderr)


def _wait_for_completion(client: HumeClient, job_id: str, timeout_seconds: float, poll_seconds: float) -> None:
    deadline = time.time() + timeout_seconds
    while True:
        job = client.expression_measurement.batch.get_job_details(job_id)
        status = getattr(job.state, "status", "").upper()
        if status == "COMPLETED":
            return
        if status == "FAILED":
            message = getattr(job.state, "message", "Unknown failure")
            raise AnalysisError(f"Hume job failed: {message}")
        if time.time() >= deadline:
            raise AnalysisError("Timed out waiting for Hume job to complete")
        time.sleep(poll_seconds)


def _run(audio_path: Path) -> Dict[str, Any]:
    api_key = os.getenv("HUME_API_KEY")
    if not api_key:
        raise AnalysisError("HUME_API_KEY is not set")

    client = HumeClient(api_key=api_key)

    _log_ffprobe(audio_path)

    job_id = _start_job(client, audio_path)
    timeout_seconds = float(os.getenv("HUME_ANALYZE_TIMEOUT", "180"))
    poll_seconds = float(os.getenv("HUME_ANALYZE_POLL_SECONDS", "1.5"))
    _wait_for_completion(client, job_id, timeout_seconds, poll_seconds)

    predictions = client.expression_measurement.batch.get_job_predictions(job_id)
    duration = _read_duration_seconds(audio_path)
    return _collect_analysis(predictions, duration)


def main(argv: List[str]) -> int:
    if len(argv) != 2:
        print(json.dumps({"error": "Usage: hume_analyze.py <path-to-audio>"}))
        return 1

    audio_path = Path(argv[1])
    if not audio_path.is_file():
        print(json.dumps({"error": f"Audio file not found: {audio_path}"}))
        return 1

    try:
        analysis = _run(audio_path)
    except AnalysisError as error:
        print(json.dumps({"error": str(error)}))
        return 2
    except ApiError as error:
        details: Dict[str, Any] = {
            "message": getattr(error, "body", None) or str(error),
            "status_code": getattr(error, "status_code", None),
        }
        print(json.dumps({"error": "Hume API error", "details": details}))
        return 3
    except Exception as exc:  # pragma: no cover - defensive guard
        print(json.dumps({"error": "Unexpected failure", "details": str(exc)}))
        return 4

    print(json.dumps(analysis))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
