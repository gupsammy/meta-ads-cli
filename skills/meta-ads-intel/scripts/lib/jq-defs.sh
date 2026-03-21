#!/bin/bash
# Shared jq function definitions for metric extraction.
# Source this file and inject $JQ_DEFS at the start of jq filters.
#
# Provides:
#   attr_guard      — filters out attribution-window duplicates from actions arrays
#   omni_first($t)  — picks the first matching action_type from a priority list
#   extract_metrics — extracts ~20 flat numeric fields from a verbose insights row
#   add_derived     — computes CPA, CPE, CPL, CPI, link_click_ctr, link_click_cpc

# shellcheck disable=SC2034
JQ_DEFS='
  def attr_guard: (. // []) as $raw | ($raw | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw else . end;
  def omni_first($types): [.[] | select(.action_type as $t | $types | index($t) != null)] | sort_by(.action_type as $t | $types | index($t)) | .[0].value // "0" | tonumber;
  def extract_metrics:
    (.actions | attr_guard) as $actions |
    (.action_values | attr_guard) as $action_vals |
    {
      spend: ((.spend // "0") | tonumber),
      impressions: ((.impressions // "0") | tonumber),
      clicks: ((.clicks // "0") | tonumber),
      cpc: ((.cpc // "0") | tonumber),
      ctr: ((.ctr // "0") | tonumber),
      cpm: ((.cpm // "0") | tonumber),
      frequency: ((.frequency // "0") | tonumber),
      reach: ((.reach // "0") | tonumber),
      purchases: ($actions | omni_first(["omni_purchase", "purchase"])),
      revenue: ($action_vals | omni_first(["omni_purchase", "purchase"])),
      roas: (.purchase_roas | attr_guard | omni_first(["omni_purchase", "purchase"])),
      add_to_cart: ($actions | omni_first(["omni_add_to_cart", "add_to_cart"])),
      initiate_checkout: ($actions | omni_first(["omni_initiated_checkout", "initiate_checkout"])),
      view_content: ($actions | omni_first(["omni_view_content", "view_content"])),
      link_clicks: ($actions | omni_first(["link_click"])),
      landing_page_views: ($actions | omni_first(["landing_page_view"])),
      post_engagement: ($actions | omni_first(["post_engagement"])),
      page_engagement: ($actions | omni_first(["page_engagement"])),
      lead: ($actions | omni_first(["onsite_conversion.lead_grouped", "lead"])),
      app_install: ($actions | omni_first(["omni_app_install", "mobile_app_install", "app_install"])),
      video_view: ($actions | omni_first(["video_view"]))
    };
  def add_derived:
    . + {
      cpa: (if .purchases > 0 then (.spend / .purchases) else null end),
      cpe: (if .post_engagement > 0 then (.spend / .post_engagement) else null end),
      cpl: (if .lead > 0 then (.spend / .lead) else null end),
      cpi: (if .app_install > 0 then (.spend / .app_install) else null end),
      link_click_ctr: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else 0 end),
      link_click_cpc: (if .link_clicks > 0 then (.spend / .link_clicks | . * 100 | round / 100) else null end)
    };
'
