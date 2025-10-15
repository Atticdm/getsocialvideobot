#!/usr/bin/env python3
"""
Analyze audio with Hume Batch API and return speaker segments including gender.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

HUME_BATCH_URL = "https://api.hume.ai/v0/batch/jobs"
POLL_INTERVAL_SECONDS = 5
POLL_TIMEOUT_SECONDS = 15 * 60  # 15 minutes being generous for long clips


def _env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _submit_job(audio_path: Path, api_key: str) -> str:
    with audio_path.open("rb") as audio_file:
        files = {"file": (audio_path.name, audio_file, "audio/wav")}
        payload = {
            "models": {
                "prosody": {
                    "identify_speakers": True,
                },
            },
        }

        response = requests.post(
            HUME_BATCH_URL,
            headers={"X-Hume-Api-Key": api_key},
            data={"json": json.dumps(payload)},
            files=files,
            timeout=60,
        )
    response.raise_for_status()
    job = response.json()
    job_id = job.get("job_id")
    if not job_id:
        raise RuntimeError(f"Hume response missing job_id: {job}")
    return job_id


def _poll_job(job_id: str, api_key: str) -> Dict[str, Any]:
    deadline = time.time() + POLL_TIMEOUT_SECONDS
    status_url = f"{HUME_BATCH_URL}/{job_id}"

    while time.time() < deadline:
        response = requests.get(status_url, headers={"X-Hume-Api-Key": api_key}, timeout=30)
        response.raise_for_status()
        job = response.json()
        status = job.get("state", {}).get("status")
        if status == "COMPLETED":
            return job
        if status in {"FAILED", "CANCELED"}:
            raise RuntimeError(f"Hume job {job_id} failed: {job}")
        time.sleep(POLL_INTERVAL_SECONDS)

    raise TimeoutError(f"Hume job {job_id} polling timed out after {POLL_TIMEOUT_SECONDS} seconds")


def _extract_results(job: Dict[str, Any]) -> Dict[str, Any]:
    # Batch job results are nested under "state" -> "results" -> list of results.
    results = job.get("state", {}).get("results") or []
    if not results:
        raise RuntimeError(f"Hume job missing results: {job}")

    speakers: Dict[str, Dict[str, str]] = {}
    segments: List[Dict[str, Any]] = []

    for result in results:
        prosody_predictions = (
            result.get("models", {})
            .get("prosody", {})
            .get("grouped_predictions", [])
        )
        for prediction in prosody_predictions:
            speaker_id = prediction.get("speaker")
            if not speaker_id:
                speaker_id = prediction.get("track", {}).get("id") or "unknown"

            # Gender is stored under prediction["speaker_info"]["gender"] when identify_speakers=True
            gender = (
                prediction.get("speaker_info", {}).get("gender")
                or prediction.get("speaker_info", {}).get("sex")
                or "unknown"
            )

            if speaker_id not in speakers:
                speakers[speaker_id] = {"gender": gender or "unknown"}

            for chunk in prediction.get("predictions", []):
                start = chunk.get("time", {}).get("start")
                end = chunk.get("time", {}).get("end")
                if start is None or end is None:
                    continue
                segments.append(
                    {
                        "speaker": speaker_id,
                        "start": round(float(start), 3),
                        "end": round(float(end), 3),
                        "type": "speech",
                        "emotions": chunk.get("emotions"),
                    }
                )

    segments.sort(key=lambda s: s["start"])

    return {
        "speakers": speakers,
        "segments": segments,
    }


def analyze_audio(file_path: str) -> Dict[str, Any]:
    debug: Dict[str, Any] = {}
    try:
        api_key = _env("HUME_API_KEY")
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"Audio file does not exist: {file_path}")

        job_id = _submit_job(path, api_key)
        debug["jobId"] = job_id
        job = _poll_job(job_id, api_key)
        result = _extract_results(job)
        result["debug"] = debug
        return result
    except Exception as exc:
        return {
            "speakers": {},
            "segments": [],
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "debug": debug,
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: analyze_audio.py <audio_path>", file=sys.stderr)
        sys.exit(1)
    analysis = analyze_audio(sys.argv[1])
    print(json.dumps(analysis))
