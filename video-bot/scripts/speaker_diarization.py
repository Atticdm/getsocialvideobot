#!/usr/bin/env python3
"""
Speaker Diarization and Gender Analysis Script
Анализирует аудиофайл для разделения спикеров и определения пола каждого спикера.
Возвращает JSON с информацией о спикерах и их речевых сегментах.
"""

import sys
import json
import librosa
import numpy as np
from typing import Dict, List, Any
from pydub import AudioSegment

try:
    from pyannote.audio import Pipeline
    PYANNOTE_AVAILABLE = True
except ImportError:
    PYANNOTE_AVAILABLE = False

def detect_gender_from_pitch(audio_segment: AudioSegment, start_time: float, end_time: float) -> str:
    """
    Определяет пол спикера на основе анализа высоты тона (F0).
    """
    try:
        # Извлекаем сегмент аудио
        start_ms = int(start_time * 1000)
        end_ms = int(end_time * 1000)
        segment = audio_segment[start_ms:end_ms]
        
        # Конвертируем в numpy array для librosa
        audio_data = np.array(segment.get_array_of_samples())
        if segment.channels == 2:
            audio_data = audio_data.reshape((-1, 2)).mean(axis=1)
        
        # Анализируем высоту тона
        pitches, _ = librosa.piptrack(y=audio_data, sr=segment.frame_rate)
        valid_pitches = pitches[pitches > 0]
        
        if len(valid_pitches) == 0:
            return "unknown"
        
        avg_pitch = np.mean(valid_pitches)
        # Мужские голоса обычно ниже 165 Гц, женские выше
        return "male" if avg_pitch < 165 else "female"
        
    except Exception:
        return "unknown"

def analyze_with_pyannote(audio_path: str) -> Dict[str, Any]:
    """
    Анализ с использованием pyannote.audio для speaker diarization.
    """
    try:
        # Инициализируем pipeline для speaker diarization
        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")
        
        # Загружаем аудио
        audio = AudioSegment.from_wav(audio_path)
        
        # Выполняем diarization
        diarization = pipeline(audio_path)
        
        # Собираем информацию о спикерах
        speakers_info = {}
        segments = []
        
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            speaker_id = str(speaker)
            start_time = turn.start
            end_time = turn.end
            
            # Если это первый сегмент спикера, определяем пол
            if speaker_id not in speakers_info:
                gender = detect_gender_from_pitch(audio, start_time, end_time)
                speakers_info[speaker_id] = {"gender": gender}
            
            segments.append({
                "speaker": speaker_id,
                "start": round(start_time, 2),
                "end": round(end_time, 2)
            })
        
        return {
            "speakers": speakers_info,
            "segments": segments
        }
        
    except Exception as e:
        return {
            "error": f"pyannote analysis failed: {str(e)}",
            "speakers": {},
            "segments": []
        }

def fallback_analysis(audio_path: str) -> Dict[str, Any]:
    """
    Fallback анализ без pyannote - определяем одного спикера для всего аудио.
    """
    try:
        audio = AudioSegment.from_wav(audio_path)
        total_duration = len(audio) / 1000.0  # в секундах
        
        # Определяем пол для всего аудио
        gender = detect_gender_from_pitch(audio, 0, total_duration)
        
        return {
            "speakers": {
                "SPEAKER_00": {"gender": gender}
            },
            "segments": [
                {
                    "speaker": "SPEAKER_00",
                    "start": 0.0,
                    "end": round(total_duration, 2)
                }
            ]
        }
        
    except Exception as e:
        return {
            "error": f"fallback analysis failed: {str(e)}",
            "speakers": {},
            "segments": []
        }

def main():
    """
    Основная функция для анализа аудиофайла.
    """
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: python3 speaker_diarization.py <audio_file_path>",
            "speakers": {},
            "segments": []
        }))
        sys.exit(1)
    
    audio_path = sys.argv[1]
    
    try:
        # Проверяем доступность pyannote
        if PYANNOTE_AVAILABLE:
            result = analyze_with_pyannote(audio_path)
        else:
            print("Warning: pyannote.audio not available, using fallback analysis", file=sys.stderr)
            result = fallback_analysis(audio_path)
        
        # Выводим результат в stdout
        print(json.dumps(result, indent=2))
        
    except Exception as e:
        error_result = {
            "error": f"Analysis failed: {str(e)}",
            "speakers": {},
            "segments": []
        }
        print(json.dumps(error_result))
        sys.exit(1)

if __name__ == "__main__":
    main()



