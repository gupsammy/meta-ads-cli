#!/bin/bash
# HTTP helpers for Meta Ads Intel scripts.
# Provides retry-aware curl wrapper with exponential backoff.

# fetch_with_retry <url> [curl_args...]
# Outputs response body to stdout. Returns 0 on success, 1 on failure.
fetch_with_retry() {
  local url="$1"; shift
  local max_retries=3
  local attempt=0
  local wait_time=1
  local tmp_headers tmp_body http_code retry_after

  tmp_headers=$(mktemp)
  tmp_body=$(mktemp)
  trap 'rm -f "$tmp_headers" "$tmp_body"' RETURN

  while [[ $attempt -le $max_retries ]]; do
    http_code=$(curl -s -o "$tmp_body" -D "$tmp_headers" -w '%{http_code}' "$@" "$url")

    # Success
    if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
      cat "$tmp_body"
      return 0
    fi

    # Non-retryable client errors (except 429)
    if [[ "$http_code" -ge 400 && "$http_code" -lt 500 && "$http_code" -ne 429 ]]; then
      cat "$tmp_body"
      return 1
    fi

    # Retryable: 429 or 5xx
    attempt=$((attempt + 1))
    if [[ $attempt -gt $max_retries ]]; then
      echo "Error: HTTP $http_code after $max_retries retries for $url" >&2
      cat "$tmp_body"
      return 1
    fi

    # Honor Retry-After header if present (429)
    retry_after=$(grep -i '^retry-after:' "$tmp_headers" | head -1 | tr -d '\r' | awk '{print $2}')
    if [[ -n "$retry_after" && "$retry_after" =~ ^[0-9]+$ ]]; then
      echo "  Retry-After: ${retry_after}s (attempt $attempt/$max_retries)" >&2
      sleep "$retry_after"
    else
      echo "  HTTP $http_code, retrying in ${wait_time}s (attempt $attempt/$max_retries)" >&2
      sleep "$wait_time"
    fi

    wait_time=$((wait_time * 2))
  done

  return 1
}
