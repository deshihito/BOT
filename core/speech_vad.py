"""WebRTC VAD wrapper for Discord's 48 kHz stereo PCM voice packets."""
from __future__ import annotations

import numpy as np
import webrtcvad
from scipy.signal import resample_poly

SAMPLE_RATE = 16_000
FRAME_MS = 20
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2


class SpeechDetector:
    """Accumulate arbitrary PCM chunks and classify complete 20 ms frames."""

    def __init__(self, aggressiveness: int = 2):
        self._vad = webrtcvad.Vad(aggressiveness)
        self._pending = bytearray()

    def reset(self) -> None:
        """Discard a partial frame after a packet gap."""
        self._pending.clear()

    def has_speech(self, pcm_48k_stereo: bytes) -> bool:
        samples = np.frombuffer(pcm_48k_stereo, dtype=np.int16)
        usable = len(samples) - len(samples) % 2
        if usable < 2:
            return False
        stereo = samples[:usable].reshape(-1, 2).astype(np.float32)
        mono = stereo.mean(axis=1)
        mono_16k = np.clip(resample_poly(mono, 1, 3), -32768, 32767).astype(np.int16)
        self._pending.extend(mono_16k.tobytes())

        detected = False
        while len(self._pending) >= FRAME_BYTES:
            frame = bytes(self._pending[:FRAME_BYTES])
            del self._pending[:FRAME_BYTES]
            detected = self._vad.is_speech(frame, SAMPLE_RATE) or detected
        return detected
