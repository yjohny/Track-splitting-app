"""Wrapper to run demucs with a patched torchaudio.save.

Newer torchaudio versions require torchcodec for saving audio, which
lacks wheels for some platforms (e.g. linux/aarch64). This wrapper
patches torchaudio.save to fall back to the soundfile library.
"""
import soundfile as sf
import torchaudio

_original_save = torchaudio.save


def _patched_save(filepath, src, sample_rate, **kwargs):
    try:
        return _original_save(filepath, src, sample_rate, **kwargs)
    except ImportError:
        sf.write(str(filepath), src.t().cpu().numpy(), sample_rate)


torchaudio.save = _patched_save

from demucs.__main__ import main  # noqa: E402

main()
