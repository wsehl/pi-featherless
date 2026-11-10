# @wsehl/pi-featherless

## 1.1.0

### Minor Changes

- 651e5d8: Fix replies being truncated after compaction. Requests no longer send `max_tokens`, so Featherless sizes the output from the real prompt length. Qwen3-family models now support thinking levels, so level `off` really turns thinking off. Models whose catalog entry has `image_input` accept images. Older cached catalogs are refetched on the next session start.
