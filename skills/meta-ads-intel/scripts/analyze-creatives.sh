#!/bin/bash
set -e

# Extract visual artifacts (frames + metadata) from top/bottom performing ad creatives.
#
# Input: creative-targets.json — array of [{ad_id, ad_name, rank, roas, cpa}]
# Output: Frames and metadata in creatives/{ad_id}/ subdirectories + manifest.json
#
# Configuration (override via environment variables):
#   META_ADS_DATA_DIR  — Data directory (default: /tmp/meta-ads-intel)
#
# Dependencies: ffmpeg, ffprobe, curl, jq, python3
#
# Usage: analyze-creatives.sh [input-file]
#        Default input: $META_ADS_DATA_DIR/_period/creative-targets.json

export DATA_DIR="${META_ADS_DATA_DIR:-/tmp/meta-ads-intel}"
export CREATIVES_DIR="$DATA_DIR/_period/creatives"
CREATIVES_MASTER="$DATA_DIR/creatives-master.json"
CONFIG_FILE="$HOME/.config/meta-ads-cli/config.json"
API_VERSION="v21.0"
MAX_FRAMES=6

# Check dependencies
for cmd in ffmpeg ffprobe curl jq python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not installed." >&2
    exit 1
  fi
done

# Get access token
if [[ -n "$META_ADS_ACCESS_TOKEN" ]]; then
  TOKEN="$META_ADS_ACCESS_TOKEN"
elif [[ -f "$CONFIG_FILE" ]]; then
  TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['auth']['access_token'])")
else
  echo "Error: No access token. Set META_ADS_ACCESS_TOKEN or run 'meta-ads auth login'." >&2
  exit 1
fi

# Input file
export INPUT_FILE="${1:-$DATA_DIR/_period/creative-targets.json}"
if [[ ! -f "$INPUT_FILE" ]]; then
  echo "Error: Input file not found: $INPUT_FILE" >&2
  echo "The skill should write creative-targets.json before calling this script." >&2
  exit 1
fi

if [[ ! -f "$CREATIVES_MASTER" ]]; then
  echo "Error: creatives-master.json not found. Run pull-data.sh first." >&2
  exit 1
fi

# Clean previous artifacts
rm -rf "$CREATIVES_DIR"
mkdir -p "$CREATIVES_DIR"

TOTAL=$(jq length "$INPUT_FILE")
echo "Extracting creative artifacts for $TOTAL ads..."

for i in $(seq 0 $((TOTAL - 1))); do
  AD_ID=$(jq -r ".[$i].ad_id" "$INPUT_FILE")
  AD_NAME=$(jq -r ".[$i].ad_name" "$INPUT_FILE")
  RANK=$(jq -r ".[$i].rank" "$INPUT_FILE")

  AD_DIR="$CREATIVES_DIR/$AD_ID"
  mkdir -p "$AD_DIR"

  echo "  [$((i+1))/$TOTAL] $AD_NAME ($RANK)"

  # Look up creative_id from creatives-master.json
  CREATIVE_ID=$(jq -r --arg aid "$AD_ID" '(.data // .)[] | select(.id == $aid) | .creative_id // empty' "$CREATIVES_MASTER")
  if [[ -z "$CREATIVE_ID" ]]; then
    echo "    WARNING: No creative_id found for ad $AD_ID, skipping"
    echo '{"error": "no_creative_id"}' > "$AD_DIR/metadata.json"
    continue
  fi

  # Fetch creative details from Meta API.
  # Note: token appears in process list during curl execution — ephemeral and host-local.
  CREATIVE_JSON=$(curl -s "https://graph.facebook.com/$API_VERSION/$CREATIVE_ID?fields=object_story_spec,thumbnail_url,image_url&access_token=$TOKEN")

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
    VIDEO_JSON=$(curl -s "https://graph.facebook.com/$API_VERSION/$VIDEO_ID?fields=source,length&access_token=$TOKEN")

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
done

# Build artifacts manifest
echo "Building manifest..."
python3 << 'PYEOF'
import json, os, glob

creatives_dir = os.environ.get("CREATIVES_DIR", "/tmp/meta-ads-intel/_period/creatives")
input_file = os.environ.get("INPUT_FILE", "/tmp/meta-ads-intel/_period/creative-targets.json")

targets = json.load(open(input_file))
manifest = []
total_frames = 0

for ad in targets:
    ad_dir = os.path.join(creatives_dir, str(ad["ad_id"]))
    if not os.path.isdir(ad_dir):
        continue

    meta_path = os.path.join(ad_dir, "metadata.json")
    metadata = json.load(open(meta_path)) if os.path.exists(meta_path) else {}

    frames = sorted(glob.glob(os.path.join(ad_dir, "*.png")))
    frame_names = [os.path.basename(f) for f in frames]
    total_frames += len(frame_names)

    manifest.append({
        "ad_id": ad["ad_id"],
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

echo "Creative artifact extraction complete. Files in $CREATIVES_DIR/"
