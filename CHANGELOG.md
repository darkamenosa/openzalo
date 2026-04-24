# Changelog

## 2026.4.24

### Fixed

- Resolved OpenClaw `MEDIA:media/outbound/...` reply attachments against the state media store before invoking `openzca`, fixing generated image delivery in OpenZalo group chats.
- Forwarded host-provided media access metadata through the OpenZalo outbound adapter so workspace-relative media paths can be loaded by the shared OpenClaw media pipeline.

## 2026.4.23

### Changed

- Aligned OpenZalo reply media delivery with OpenClaw's shared payload media sequencing helper while preserving OpenZalo-specific dedupe, receipt tracking, and caption handling.
- Added opt-in reply media trace logging for diagnosing payload normalization and delivery paths.

### Fixed

- Recovered stripped `MEDIA:` directives from the active OpenClaw session when the channel receives a text-only reply payload, allowing generated images to be delivered to Zalo instead of only sending the caption text.

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
