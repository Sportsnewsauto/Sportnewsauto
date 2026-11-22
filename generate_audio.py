
import os
import sys
import time
import traceback
from pathlib import Path

CPU_THREADS = max(1, min(int(os.getenv("KOKORO_TORCH_THREADS", "4")), os.cpu_count() or 1))
os.environ.setdefault("OMP_NUM_THREADS", str(CPU_THREADS))
os.environ.setdefault("MKL_NUM_THREADS", str(CPU_THREADS))
os.environ.setdefault("OPENBLAS_NUM_THREADS", str(CPU_THREADS))

import numpy as np
import soundfile as sf
import torch
from kokoro import KPipeline


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output" / "episode"
NARRATION_FILE = OUTPUT_DIR / "narration.txt"
AUDIO_FILE = OUTPUT_DIR / "podcast.wav"

# Kokoro English voices (American and British).
SUPPORTED_ENGLISH_VOICES = {
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica",
    "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
}
VOICE = os.getenv("KOKORO_VOICE", "af_heart")

SAMPLE_RATE = 24000
SILENCE_BETWEEN_SEGMENTS_SECONDS = 0.15


def main():
    if not NARRATION_FILE.exists():
        raise FileNotFoundError(
            f"Narration file not found: {NARRATION_FILE}. "
            "Generate and validate the script first."
        )

    narration = NARRATION_FILE.read_text(
        encoding="utf-8"
    ).strip()

    if not narration:
        raise ValueError("The narration file is empty.")
    if VOICE not in SUPPORTED_ENGLISH_VOICES:
        raise ValueError(f"Unsupported Kokoro English voice: {VOICE}")

    OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    print("=" * 55, flush=True)
    print("KOKORO LOCAL PODCAST AUDIO GENERATOR", flush=True)
    print(f"Voice: {VOICE}", flush=True)
    print(f"Narration characters: {len(narration)}", flush=True)
    print("Final output: one complete podcast.wav", flush=True)
    print("=" * 55, flush=True)

    torch.set_num_threads(CPU_THREADS)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass

    print(f"Kokoro CPU threads: {CPU_THREADS} intra-op / 1 inter-op", flush=True)

    print(
        "Loading Kokoro model. The first run may download model files.",
        flush=True,
    )

    # If initialization fails, the outer exception handler
    # will print the complete traceback.
    # Kokoro uses "a" for American English voices and "b" for British English.
    pipeline = KPipeline(lang_code=VOICE[0])

    print("Kokoro is ready. Generating narration...", flush=True)

    temporary_audio = OUTPUT_DIR / "podcast_building.wav"
    temporary_audio.unlink(missing_ok=True)

    segment_count = 0
    total_samples = 0
    started = time.monotonic()

    try:
        with sf.SoundFile(
            str(temporary_audio),
            mode="w",
            samplerate=SAMPLE_RATE,
            channels=1,
            subtype="PCM_16",
        ) as audio_file:

            # Generate manageable segments and write them
            # directly into one continuous WAV file.
            with torch.inference_mode():
                for _, _, audio in pipeline(
                    narration,
                    voice=VOICE,
                    speed=1.0,
                ):
                    if audio is None:
                        continue

                    if hasattr(audio, "detach"):
                        audio = audio.detach().cpu().numpy()

                    samples = np.asarray(
                        audio,
                        dtype=np.float32,
                    ).reshape(-1)

                    if samples.size == 0:
                        continue

                    if segment_count > 0:
                        silence_samples = int(
                            SAMPLE_RATE
                            * SILENCE_BETWEEN_SEGMENTS_SECONDS
                        )

                        audio_file.write(
                            np.zeros(
                                silence_samples,
                                dtype=np.float32,
                            )
                        )
                        total_samples += silence_samples

                    audio_file.write(samples)

                    segment_count += 1
                    total_samples += samples.size

                    if segment_count == 1 or segment_count % 10 == 0:
                        elapsed = time.monotonic() - started
                        audio_minutes = (
                            total_samples / SAMPLE_RATE / 60
                        )

                        print(
                            f"Segments generated: {segment_count} | "
                            f"Audio created: {audio_minutes:.1f} minutes | "
                            f"Elapsed: {elapsed / 60:.1f} minutes",
                            flush=True,
                        )

            audio_file.flush()

        if segment_count == 0:
            raise RuntimeError(
                "Kokoro did not generate any audio segments."
            )

        if (
            not temporary_audio.exists()
            or temporary_audio.stat().st_size == 0
        ):
            raise RuntimeError(
                "The temporary audio file is empty."
            )

        # Validate the WAV before publishing the final file.
        with sf.SoundFile(
            str(temporary_audio),
            mode="r",
        ) as check:
            duration_seconds = len(check) / check.samplerate

        os.replace(
            str(temporary_audio),
            str(AUDIO_FILE),
        )

        print("", flush=True)
        print("=" * 55, flush=True)
        print("PODCAST AUDIO GENERATION COMPLETE", flush=True)
        print(f"Voice: {VOICE}", flush=True)
        print(f"Segments processed: {segment_count}", flush=True)
        print(
            f"Audio duration: {duration_seconds / 60:.1f} minutes",
            flush=True,
        )
        print(
            f"Processing time: "
            f"{(time.monotonic() - started) / 60:.1f} minutes",
            flush=True,
        )
        print(f"Audio file: {AUDIO_FILE}", flush=True)
        print(
            f"File size: "
            f"{AUDIO_FILE.stat().st_size / (1024 * 1024):.2f} MB",
            flush=True,
        )
        print("=" * 55, flush=True)

    finally:
        # Remove an incomplete recording after failure.
        temporary_audio.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(
            f"ERROR: {type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
        print(
            "Full traceback follows:",
            file=sys.stderr,
            flush=True,
        )
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
