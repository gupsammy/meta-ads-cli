#!/bin/bash
set -euo pipefail
umask 077

# Extract visual artifacts (frames + metadata) from top/bottom performing ad creatives.
#
# Input: creative-media.json from the latest run directory (auto-detected via latest.json)
# Output: Frames and metadata in ~/.meta-ads-intel/creatives/{ad_id}/ + manifest.json
#
# Configuration (override via environment variables):
#   META_ADS_DATA_DIR  — Data directory (default: ~/.meta-ads-intel/data)
#
# Dependencies: ffmpeg, ffprobe, curl, jq, python3
#
# Usage: analyze-creatives.sh [input-file]
#        Default input: auto-detected from latest run directory

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/http-helpers.sh"

export DATA_DIR="${META_ADS_DATA_DIR:-$HOME/.meta-ads-intel/data}"
export CREATIVES_DIR="$(dirname "${META_ADS_DATA_DIR:-$HOME/.meta-ads-intel/data}")/creatives"
CREATIVES_MASTER="$DATA_DIR/creatives-master.json"
CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/meta-ads-cli/config.json"
API_VERSION="${META_ADS_API_VERSION:-v21.0}"
MAX_FRAMES=6

# Check dependencies
for cmd in ffmpeg ffprobe curl jq python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not installed." >&2
    exit 1
  fi
done

# Get access token
if [[ -n "${META_ADS_ACCESS_TOKEN:-}" ]]; then
  TOKEN="$META_ADS_ACCESS_TOKEN"
elif [[ -f "$CONFIG_FILE" ]]; then
  TOKEN=$(jq -r '.auth.access_token' "$CONFIG_FILE")
else
  echo "Error: No access token. Set META_ADS_ACCESS_TOKEN or run 'meta-ads auth login'." >&2
  exit 1
fi

# Input file — auto-detect from latest run dir if not specified
if [[ -n "${1:-}" ]]; then
  export INPUT_FILE="$1"
else
  # Find latest run directory
  LATEST_FILE="$DATA_DIR/latest.json"
  if [[ ! -f "$LATEST_FILE" ]]; then
    echo "Error: No latest.json found. Run pull-data.sh first." >&2
    exit 1
  fi
  LATEST_RUN=$(jq -r '.latest' "$LATEST_FILE")
  export INPUT_FILE="$DATA_DIR/$LATEST_RUN/creative-media.json"
fi

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "Error: Input file not found: $INPUT_FILE" >&2
  echo "Run pull-data.sh first to generate creative-media.json." >&2
  exit 1
fi

if [[ ! -f "$CREATIVES_MASTER" ]]; then
  echo "Error: creatives-master.json not found. Run pull-data.sh first." >&2
  exit 1
fi

# Atomic swap: write to temp dir, swap on success
export CREATIVES_TMP="${CREATIVES_DIR}._tmp_$$"
trap 'rm -rf "$CREATIVES_TMP"' EXIT
rm -rf "$CREATIVES_TMP"
mkdir -p "$CREATIVES_TMP"

# Pre-extract all ad data in one jq pass (avoids N*3 jq spawns in the loop)
TOTAL=$(jq length "$INPUT_FILE")
echo "Extracting creative artifacts for $TOTAL ads..."

AD_TSV="$CREATIVES_TMP/_ads.tsv"
jq -r '.[] | [(.ad_id // .ad_name | tostring), (.ad_name // ""), (.rank // "")] | @tsv' \
  "$INPUT_FILE" > "$AD_TSV"

# Build creative_id lookup: ad_id -> creative_id (single jq pass instead of per-ad)
CREATIVE_LOOKUP_FILE="$CREATIVES_TMP/_creative_ids.json"
jq 'INDEX((.data // .)[]; .id) | map_values(.creative_id // "")' \
  "$CREATIVES_MASTER" > "$CREATIVE_LOOKUP_FILE"

LINE_NUM=0
while IFS=$'\t' read -r RAW_AD_ID AD_NAME RANK; do
  LINE_NUM=$((LINE_NUM + 1))
  AD_ID=$(echo "$RAW_AD_ID" | tr -cd '[:alnum:]_-' | cut -c1-64)

  AD_DIR="$CREATIVES_TMP/$AD_ID"
  mkdir -p "$AD_DIR"

  echo "  [$LINE_NUM/$TOTAL] $AD_NAME ($RANK)"

  # Look up creative_id from pre-built lookup
  CREATIVE_ID=$(jq -r --arg aid "$AD_ID" '.[$aid] // empty' "$CREATIVE_LOOKUP_FILE")
  if [[ -z "$CREATIVE_ID" ]]; then
    echo "    WARNING: No creative_id found for ad $AD_ID, skipping"
    echo '{"error": "no_creative_id"}' > "$AD_DIR/metadata.json"
    continue
  fi

  # Fetch creative details from Meta API
  CREATIVE_JSON=$(fetch_with_retry "https://graph.facebook.com/$API_VERSION/$CREATIVE_ID?fields=object_story_spec,thumbnail_url,image_url" -H "Authorization: Bearer $TOKEN") || true

  # Check for API errors
  API_ERROR=$(echo "$CREATIVE_JSON" | jq -r '.error.message // empty')
  if [[ -n "$API_ERROR" ]]; then
    echo "    WARNING: API error: $API_ERROR"
    jq -n --arg msg "$API_ERROR" '{"error": "api_error", "message": $msg}' > "$AD_DIR/metadata.json"
    continue
  fi

  # Determine media type: video or image
  VIDEO_ID=$(echo "$CREATIVE_JSON" | jq -r '.object_story_spec.video_data.video_id // empty')
  LINK_IMAGE=$(echo "$CREATIVE_JSON" | jq -r '.object_story_spec.link_data.image_hash // empty')
  THUMBNAIL_URL=$(echo "$CREATIVE_JSON" | jq -r '.thumbnail_url // empty')

  if [[ -n "$VIDEO_ID" ]]; then
    # === VIDEO AD ===
    VIDEO_JSON=$(fetch_with_retry "https://graph.facebook.com/$API_VERSION/$VIDEO_ID?fields=source,length" -H "Authorization: Bearer $TOKEN") || true

    SOURCE_URL=$(echo "$VIDEO_JSON" | jq -r '.source // empty')
    DURATION=$(echo "$VIDEO_JSON" | jq -r '.length // 0')

    if [[ -z "$SOURCE_URL" ]]; then
      echo "    WARNING: No video source URL available, falling back to thumbnail"
      if [[ -n "$THUMBNAIL_URL" ]]; then
        curl -s -L -o "$AD_DIR/thumbnail.png" "$THUMBNAIL_URL"
        echo '{"type": "video", "error": "no_source_url", "fallback": "thumbnail"}' > "$AD_DIR/metadata.json"
      else
        echo '{"type": "video", "error": "no_source_url"}' > "$AD_DIR/metadata.json"
      fi
      continue
    fi

    TMP_RAW="$AD_DIR/_raw.mp4"
    TMP_VIDEO="$AD_DIR/_video.mp4"
    echo "    Downloading video (${DURATION}s)..."
    if ! curl -s -L -o "$TMP_RAW" "$SOURCE_URL" || [[ ! -s "$TMP_RAW" ]]; then
      echo "    WARNING: Download failed, skipping"
      echo '{"type": "video", "error": "download_failed"}' > "$AD_DIR/metadata.json"
      rm -f "$TMP_RAW"
      continue
    fi
    # Transcode to 480px wide, low bitrate, no audio, max 60s
    if ! ffmpeg -i "$TMP_RAW" -vf scale=480:-1 -b:v 300k -an -t 60 -y -loglevel error "$TMP_VIDEO" 2>/dev/null; then
      echo "    WARNING: ffmpeg transcode failed, using raw file"
      mv "$TMP_RAW" "$TMP_VIDEO"
    else
      rm -f "$TMP_RAW"
    fi

    # Extract metadata via ffprobe
    ffprobe -v quiet -print_format json -show_format -show_streams "$TMP_VIDEO" | \
      python3 -c "
import json, sys
data = json.load(sys.stdin)
fmt = data.get('format', {})
stream = data.get('streams', [{}])[0]
meta = {
    'type': 'video',
    'duration': round(float(fmt.get('duration', 0)), 1),
    'width': stream.get('width'),
    'height': stream.get('height'),
    'aspect_ratio': stream.get('display_aspect_ratio', ''),
    'codec': stream.get('codec_name', '')
}
w, h = meta['width'] or 0, meta['height'] or 0
if w and h:
    ratio = w / h
    if ratio > 1.2: meta['orientation'] = 'landscape'
    elif ratio < 0.8: meta['orientation'] = 'portrait'
    else: meta['orientation'] = 'square'
json.dump(meta, sys.stdout, indent=2)
" > "$AD_DIR/metadata.json"

    # Extract evenly-spaced frames
    VID_DURATION=$(jq -r '.duration' "$AD_DIR/metadata.json")
    INTERVAL=$(python3 -c "d=$VID_DURATION; n=$MAX_FRAMES; print(max(0.5, d / max(1, n - 1)))")

    echo "    Extracting frames (interval=${INTERVAL}s)..."
    ffmpeg -i "$TMP_VIDEO" \
      -vf "fps=1/$INTERVAL,scale=480:-1" \
      -vframes "$MAX_FRAMES" \
      -y -loglevel error \
      "$AD_DIR/frame_%02d.png" 2>/dev/null || true

    # Always grab the last frame explicitly (CTA/closing shot)
    ffmpeg -sseof -0.3 -i "$TMP_VIDEO" -vframes 1 -vf scale=480:-1 -y -loglevel error \
      "$AD_DIR/frame_last.png" 2>/dev/null || true

    # Clean up video files
    rm -f "$TMP_VIDEO" "$TMP_RAW"

    FRAME_COUNT=$(ls "$AD_DIR"/*.png 2>/dev/null | wc -l | tr -d ' ')
    echo "    Extracted $FRAME_COUNT frames (${VID_DURATION}s video)"

  else
    # === IMAGE AD ===
    IMG_URL="$THUMBNAIL_URL"
    if [[ -z "$IMG_URL" ]]; then
      IMG_URL=$(echo "$CREATIVE_JSON" | jq -r '.image_url // empty')
    fi

    if [[ -n "$IMG_URL" ]]; then
      echo "    Downloading image..."
      curl -s -L -o "$AD_DIR/image.png" "$IMG_URL"
      IMG_META=$(ffprobe -v quiet -print_format json -show_streams "$AD_DIR/image.png" 2>/dev/null || echo '{}')
      echo "$IMG_META" | python3 -c "
import json, sys
data = json.load(sys.stdin)
stream = data.get('streams', [{}])[0]
w, h = stream.get('width', 0), stream.get('height', 0)
orient = 'landscape' if w > h * 1.2 else ('portrait' if h > w * 1.2 else 'square')
json.dump({'type': 'image', 'width': w, 'height': h, 'orientation': orient}, sys.stdout, indent=2)
" > "$AD_DIR/metadata.json"
      echo "    Downloaded image"
    else
      echo "    WARNING: No media URL found"
      echo '{"type": "unknown", "error": "no_media_url"}' > "$AD_DIR/metadata.json"
    fi
  fi
done < "$AD_TSV"

# Clean up pre-extracted data
rm -f "$AD_TSV" "$CREATIVE_LOOKUP_FILE"

# Build artifacts manifest
echo "Building manifest..."
python3 << 'PYEOF'
import json, os, glob, re

creatives_dir = os.environ.get("CREATIVES_TMP", os.environ.get("CREATIVES_DIR", os.path.expanduser("~/.meta-ads-intel/creatives")))
input_file = os.environ.get("INPUT_FILE")

targets = json.load(open(input_file))
manifest = []
total_frames = 0

for ad in targets:
    ad_id = re.sub(r'[^a-zA-Z0-9_-]', '', str(ad.get("ad_id", ad.get("ad_name", ""))))[:64]
    ad_dir = os.path.join(creatives_dir, ad_id)
    if not os.path.isdir(ad_dir):
        continue

    meta_path = os.path.join(ad_dir, "metadata.json")
    metadata = json.load(open(meta_path)) if os.path.exists(meta_path) else {}

    frames = sorted(glob.glob(os.path.join(ad_dir, "*.png")))
    frame_names = [os.path.basename(f) for f in frames]
    total_frames += len(frame_names)

    manifest.append({
        "ad_id": ad_id,
        "ad_name": ad.get("ad_name", ""),
        "rank": ad.get("rank", ""),
        "roas": ad.get("roas", 0),
        "cpa": ad.get("cpa", 0),
        "media_type": metadata.get("type", "unknown"),
        "duration": metadata.get("duration"),
        "orientation": metadata.get("orientation", "unknown"),
        "frames": frame_names,
        "frame_count": len(frame_names),
        "artifacts_dir": ad_dir
    })

json.dump(manifest, open(os.path.join(creatives_dir, "manifest.json"), "w"), indent=2)
print(f"Manifest: {len(manifest)} creatives, {total_frames} total frames")
PYEOF

# Atomic swap: replace old creatives with new
rm -rf "$CREATIVES_DIR"
mv "$CREATIVES_TMP" "$CREATIVES_DIR"
trap - EXIT

echo "Creative artifact extraction complete. Files in $CREATIVES_DIR/"
