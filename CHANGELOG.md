# Changelog

## 2026.4.14

### Changed

- Aligned outbound local media handling with the host OpenClaw media pipeline by staging media through the shared loader before invoking `openzca`.
- Added a compatibility layer for standalone extension testing while preferring OpenClaw-managed temp media roots when available.
- Updated the bundled `openzca` skill docs to describe the current media and voice-send behavior.

### Fixed

- Allowed OpenClaw temp TTS media under the preferred OpenClaw temp root by default.
- Preserved relative `mediaPath` resolution against allowed roots before staging outbound media.
- Kept voice replies voice-only instead of sending an extra text message after a successful voice send.
- Removed the generic fallback that retried failed media sends as `msg upload`, so voice and other media sends now fail fast and surface the original error.

## 2026.3.31

- Previous packaged release.
