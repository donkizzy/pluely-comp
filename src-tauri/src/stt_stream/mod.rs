// Streaming speech-to-text over WebSocket (Deepgram Live, AssemblyAI
// Universal-Streaming). Audio goes directly from the device to the provider;
// there is no proxy. Both providers are normalized to the same events:
//
//   "stt-stream-open"   ()                 socket connected
//   "stt-transcript"    TranscriptEvent    partial or final text of the current turn
//   "stt-stream-error"  String             connection or provider error (stream is over)

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
use tracing::{debug, info, warn};

pub const STREAM_SAMPLE_RATE: u32 = 16_000;
// ~100 ms of 16 kHz audio per WebSocket frame (both providers accept 50-1000 ms).
const FRAME_SAMPLES: usize = 1_600;
// Frames buffered between capture and socket before we start dropping audio.
const QUEUE_FRAMES: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StreamingProvider {
    Deepgram,
    Assemblyai,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingSttConfig {
    pub provider: StreamingProvider,
    pub api_key: String,
    pub model: Option<String>,
    pub language: Option<String>,
    #[serde(default)]
    pub keyterms: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEvent {
    // Full text of the current turn so far.
    pub text: String,
    // True once the provider has decided the speaker finished this turn.
    pub end_of_turn: bool,
}

// Sender side held by the capture loop. Dropping it closes the stream.
pub struct SttStreamHandle {
    tx: mpsc::Sender<Vec<i16>>,
    pending: Vec<i16>,
}

impl SttStreamHandle {
    // Queue 16 kHz mono samples. Never blocks the capture loop: if the socket
    // falls behind, audio is dropped rather than delaying capture.
    pub fn push(&mut self, samples: &[f32]) {
        self.pending.extend(
            samples
                .iter()
                .map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16),
        );
        while self.pending.len() >= FRAME_SAMPLES {
            let frame: Vec<i16> = self.pending.drain(..FRAME_SAMPLES).collect();
            if self.tx.try_send(frame).is_err() {
                warn!("Streaming STT queue full or closed; dropping audio frame");
            }
        }
    }
}

pub fn spawn(app: AppHandle, config: StreamingSttConfig) -> SttStreamHandle {
    let (tx, rx) = mpsc::channel(QUEUE_FRAMES);
    tokio::spawn(async move {
        if let Err(err) = run(app.clone(), config, rx).await {
            warn!("Streaming STT ended with error: {}", err);
            let _ = app.emit("stt-stream-error", err);
        }
    });
    SttStreamHandle {
        tx,
        pending: Vec::with_capacity(FRAME_SAMPLES * 2),
    }
}

fn build_request(
    config: &StreamingSttConfig,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    let rate = STREAM_SAMPLE_RATE.to_string();
    let url = match config.provider {
        StreamingProvider::Deepgram => {
            let model = config.model.clone().filter(|m| !m.trim().is_empty());
            let mut params: Vec<(&str, String)> = vec![
                ("model", model.unwrap_or_else(|| "nova-3".to_string())),
                ("encoding", "linear16".to_string()),
                ("sample_rate", rate),
                ("channels", "1".to_string()),
                ("interim_results", "true".to_string()),
                ("smart_format", "true".to_string()),
                ("endpointing", "300".to_string()),
                ("utterance_end_ms", "1000".to_string()),
                ("vad_events", "true".to_string()),
                (
                    "language",
                    config.language.clone().unwrap_or_else(|| "en".to_string()),
                ),
            ];
            params.extend(config.keyterms.iter().map(|k| ("keyterm", k.clone())));
            reqwest::Url::parse_with_params("wss://api.deepgram.com/v1/listen", &params)
        }
        StreamingProvider::Assemblyai => {
            let mut params: Vec<(&str, String)> = vec![
                ("sample_rate", rate),
                ("encoding", "pcm_s16le".to_string()),
                ("format_turns", "true".to_string()),
            ];
            if !config.keyterms.is_empty() {
                params.push((
                    "keyterms_prompt",
                    serde_json::to_string(&config.keyterms).unwrap_or_default(),
                ));
            }
            reqwest::Url::parse_with_params("wss://streaming.assemblyai.com/v3/ws", &params)
        }
    }
    .map_err(|e| format!("Invalid streaming URL: {}", e))?;

    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("Invalid streaming request: {}", e))?;
    let auth = match config.provider {
        StreamingProvider::Deepgram => format!("Token {}", config.api_key.trim()),
        StreamingProvider::Assemblyai => config.api_key.trim().to_string(),
    };
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&auth).map_err(|_| "Invalid API key characters".to_string())?,
    );
    Ok(request)
}

async fn run(
    app: AppHandle,
    config: StreamingSttConfig,
    mut rx: mpsc::Receiver<Vec<i16>>,
) -> Result<(), String> {
    if config.api_key.trim().is_empty() {
        return Err("Streaming speech provider needs an API key".to_string());
    }
    let request = build_request(&config)?;
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "Timed out connecting to the streaming speech provider".to_string())?
    .map_err(|e| format!("Could not connect to the streaming speech provider: {}", e))?;
    info!("Streaming STT connected ({:?})", config.provider);
    let _ = app.emit("stt-stream-open", ());

    let (mut write, mut read) = socket.split();
    let provider = config.provider;

    // Writer: forward audio until capture stops, then ask the provider to
    // flush and close.
    let writer = async move {
        while let Some(frame) = rx.recv().await {
            let bytes: Vec<u8> = frame.iter().flat_map(|s| s.to_le_bytes()).collect();
            if write.send(Message::binary(bytes)).await.is_err() {
                return;
            }
        }
        let close = match provider {
            StreamingProvider::Deepgram => r#"{"type":"CloseStream"}"#,
            StreamingProvider::Assemblyai => r#"{"type":"Terminate"}"#,
        };
        let _ = write.send(Message::text(close.to_string())).await;
    };

    // Reader: normalize provider messages into TranscriptEvents.
    let reader_app = app.clone();
    let reader = async move {
        let mut normalizer = Normalizer::default();
        while let Some(message) = read.next().await {
            let text = match message {
                Ok(Message::Text(text)) => text,
                Ok(Message::Close(frame)) => {
                    // 1000 is a normal close after our CloseStream/Terminate.
                    return match frame {
                        Some(f) if u16::from(f.code) != 1000 => {
                            Err(format!("Speech provider closed the stream: {}", f.reason))
                        }
                        _ => Ok(()),
                    };
                }
                Ok(_) => continue,
                Err(e) => return Err(format!("Streaming speech connection lost: {}", e)),
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            // Raw provider messages, for diagnosing turn handling (debug only).
            debug!(
                "provider message: type={:?} is_final={:?} speech_final={:?} end_of_turn={:?} text={:?}",
                value.get("type"),
                value.get("is_final"),
                value.get("speech_final"),
                value.get("end_of_turn"),
                value
                    .pointer("/channel/alternatives/0/transcript")
                    .or_else(|| value.get("transcript"))
            );
            let event = match provider {
                StreamingProvider::Deepgram => normalizer.deepgram(&value),
                StreamingProvider::Assemblyai => normalizer.assemblyai(&value)?,
            };
            if let Some(event) = event {
                debug!("emit stt-transcript: {:?}", event);
                let _ = reader_app.emit("stt-transcript", event);
            }
        }
        Ok(())
    };

    let reader = tokio::spawn(reader);
    writer.await;
    // Give the provider a moment to send its last results after we close.
    match tokio::time::timeout(Duration::from_secs(3), reader).await {
        Ok(Ok(result)) => result,
        _ => Ok(()),
    }
}

// Turns provider-specific messages into "whole turn so far" events.
#[derive(Default)]
struct Normalizer {
    // Deepgram: finalized segments of the current turn.
    finals: Vec<String>,
}

impl Normalizer {
    fn current(&self, interim: &str) -> String {
        let mut parts: Vec<&str> = self.finals.iter().map(String::as_str).collect();
        if !interim.is_empty() {
            parts.push(interim);
        }
        parts.join(" ")
    }

    fn end_turn(&mut self) -> Option<TranscriptEvent> {
        let text = self.current("");
        self.finals.clear();
        (!text.is_empty()).then_some(TranscriptEvent {
            text,
            end_of_turn: true,
        })
    }

    fn deepgram(&mut self, value: &Value) -> Option<TranscriptEvent> {
        match value.get("type").and_then(Value::as_str) {
            Some("Results") => {
                let transcript = value
                    .pointer("/channel/alternatives/0/transcript")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let is_final = value.get("is_final").and_then(Value::as_bool).unwrap_or(false);
                let speech_final = value
                    .get("speech_final")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !is_final {
                    return (!transcript.is_empty()).then(|| TranscriptEvent {
                        text: self.current(&transcript),
                        end_of_turn: false,
                    });
                }
                if !transcript.is_empty() {
                    self.finals.push(transcript);
                }
                if speech_final {
                    self.end_turn()
                } else {
                    let text = self.current("");
                    (!text.is_empty()).then_some(TranscriptEvent {
                        text,
                        end_of_turn: false,
                    })
                }
            }
            Some("UtteranceEnd") => self.end_turn(),
            _ => None,
        }
    }

    fn assemblyai(&mut self, value: &Value) -> Result<Option<TranscriptEvent>, String> {
        match value.get("type").and_then(Value::as_str) {
            Some("Turn") => {
                let text = value
                    .get("transcript")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let end_of_turn = value
                    .get("end_of_turn")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let formatted = value
                    .get("turn_is_formatted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                // With format_turns, the end of a turn arrives twice: wait for
                // the formatted copy.
                if text.is_empty() || (end_of_turn && !formatted) {
                    return Ok(None);
                }
                Ok(Some(TranscriptEvent { text, end_of_turn }))
            }
            Some("Error") => Err(value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Speech provider error")
                .to_string()),
            _ => Ok(None),
        }
    }
}

// Streaming box-filter downsampler, so chunked capture audio can be
// converted to 16 kHz without drift between chunks.
pub struct Downsampler {
    step: f64,
    position: f64,
    next_boundary: f64,
    sum: f32,
    count: u32,
}

impl Downsampler {
    pub fn new(from_rate: u32, to_rate: u32) -> Self {
        let step = (from_rate as f64 / to_rate as f64).max(1.0);
        Self {
            step,
            position: 0.0,
            next_boundary: step,
            sum: 0.0,
            count: 0,
        }
    }

    pub fn process(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        for &sample in samples {
            self.sum += sample;
            self.count += 1;
            self.position += 1.0;
            if self.position >= self.next_boundary {
                out.push(self.sum / self.count as f32);
                self.sum = 0.0;
                self.count = 0;
                self.next_boundary += self.step;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn downsampler_keeps_rate_across_chunks() {
        let mut down = Downsampler::new(48_000, 16_000);
        let mut out = Vec::new();
        for _ in 0..100 {
            down.process(&[0.5; 1024], &mut out);
        }
        // 102_400 input samples at a 3:1 ratio
        assert_eq!(out.len(), 102_400 / 3);
        assert!(out.iter().all(|s| (*s - 0.5).abs() < 1e-6));
    }

    #[test]
    fn deepgram_segments_accumulate_into_one_turn() {
        let mut n = Normalizer::default();
        let results = |text: &str, is_final: bool, speech_final: bool| {
            json!({"type": "Results", "is_final": is_final, "speech_final": speech_final,
                   "channel": {"alternatives": [{"transcript": text}]}})
        };
        let partial = n.deepgram(&results("tell me", false, false)).unwrap();
        assert_eq!(partial.text, "tell me");
        assert!(!partial.end_of_turn);
        n.deepgram(&results("tell me about", true, false));
        let partial = n.deepgram(&results("a time", false, false)).unwrap();
        assert_eq!(partial.text, "tell me about a time");
        let end = n.deepgram(&results("a time you failed", true, true)).unwrap();
        assert_eq!(end.text, "tell me about a time you failed");
        assert!(end.end_of_turn);
        assert!(n.deepgram(&json!({"type": "UtteranceEnd"})).is_none());
    }

    #[test]
    fn assemblyai_waits_for_formatted_end_of_turn() {
        let mut n = Normalizer::default();
        let turn = |text: &str, end: bool, formatted: bool| {
            json!({"type": "Turn", "transcript": text, "end_of_turn": end, "turn_is_formatted": formatted})
        };
        let partial = n.assemblyai(&turn("how would you", false, false)).unwrap().unwrap();
        assert!(!partial.end_of_turn);
        assert!(n.assemblyai(&turn("how would you design it", true, false)).unwrap().is_none());
        let end = n.assemblyai(&turn("How would you design it?", true, true)).unwrap().unwrap();
        assert_eq!(end.text, "How would you design it?");
        assert!(end.end_of_turn);
        assert!(n.assemblyai(&json!({"type": "Error", "error": "bad key"})).is_err());
    }
}
