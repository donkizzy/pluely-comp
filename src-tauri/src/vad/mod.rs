// Neural speech detection with Silero VAD (C port, weights embedded, no
// runtime downloads). Fed 16 kHz mono audio; reports speech with hysteresis
// so brief dips mid-word don't end a segment.

use silero_vad_crs::SileroVad;
use tracing::warn;

// Silero's recommended thresholds: enter speech at 0.5, leave below 0.35.
const START_THRESHOLD: f32 = 0.5;
const END_THRESHOLD: f32 = 0.35;

// SileroVad holds a raw pointer to its C model, so it isn't Send. The model
// has no thread affinity and is only ever used by the one capture task that
// owns it, so moving it between tokio worker threads is sound.
struct OwnedVad(SileroVad);
unsafe impl Send for OwnedVad {}

pub struct SpeechDetector {
    vad: OwnedVad,
    in_speech: bool,
}

impl SpeechDetector {
    // None if the model can't be created; callers fall back to energy VAD.
    pub fn new() -> Option<Self> {
        match SileroVad::new() {
            Ok(vad) => Some(Self {
                vad: OwnedVad(vad),
                in_speech: false,
            }),
            Err(err) => {
                warn!("Silero VAD unavailable, using energy VAD: {}", err);
                None
            }
        }
    }

    // Feed 16 kHz samples; returns whether the audio is currently speech.
    // Samples shorter than one model window are buffered for the next call,
    // so the previous state is kept until enough audio arrives.
    pub fn process(&mut self, samples_16k: &[f32]) -> bool {
        match self.vad.0.push(samples_16k) {
            Ok(probabilities) => {
                for p in probabilities {
                    self.in_speech = if self.in_speech {
                        p >= END_THRESHOLD
                    } else {
                        p >= START_THRESHOLD
                    };
                }
            }
            Err(err) => warn!("Silero VAD inference failed: {}", err),
        }
        self.in_speech
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_is_not_speech() {
        let mut detector = SpeechDetector::new().expect("model loads");
        for _ in 0..50 {
            assert!(!detector.process(&[0.0; 341]));
        }
    }

    #[test]
    fn spoken_sentence_is_speech() {
        // 16 kHz mono, generated with macOS `say`.
        let mut reader =
            hound::WavReader::open(concat!(env!("CARGO_MANIFEST_DIR"), "/src/vad/testdata/speech_16k.wav"))
                .expect("fixture opens");
        let samples: Vec<f32> = reader
            .samples::<i16>()
            .map(|s| s.expect("valid sample") as f32 / i16::MAX as f32)
            .collect();
        let mut detector = SpeechDetector::new().expect("model loads");
        let chunks = samples.chunks(341).count();
        let speech = samples.chunks(341).filter(|c| detector.process(c)).count();
        assert!(
            speech * 2 > chunks,
            "only {speech} of {chunks} chunks of a spoken sentence detected as speech"
        );
    }

    #[test]
    fn steady_tone_is_not_speech() {
        let mut detector = SpeechDetector::new().expect("model loads");
        let tone: Vec<f32> = (0..16_000)
            .map(|i| 0.3 * (i as f32 * 2.0 * std::f32::consts::PI * 1_000.0 / 16_000.0).sin())
            .collect();
        let speech = tone.chunks(341).filter(|c| detector.process(c)).count();
        assert!(speech < 5, "pure tone flagged as speech in {speech} chunks");
    }
}
