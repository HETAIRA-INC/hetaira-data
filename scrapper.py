from bs4 import BeautifulSoup
import html
import json
#import requests
from curl_cffi import requests

# Add ?_embed to automatically include image and category details
api_url = "https://goddessnichole.com/wp-json/wp/v2/posts/2500?_embed"

# Headers are required so Codespaces doesn't get blocked
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "application/json",
}

response = requests.get(api_url, headers=headers, impersonate="chrome120")
data = response.json()

# 1. Parse the embedded HTML content
content_html = data.get("content", {}).get("rendered", "")
soup = BeautifulSoup(content_html, "html.parser")

# 2. Extract Audio URL
audio_elem = soup.select_one("audio source")
audio_url = audio_elem.get("src") if audio_elem else None

# 3. Extract Description and Tags paragraphs
paragraphs = [p.get_text(strip=True) for p in soup.select("p")]
description = paragraphs[0] if len(paragraphs) > 0 else None
tags_text = paragraphs[1] if len(paragraphs) > 1 else None

# 4. Extract Image URL (from embedded data)
image_url = None
try:
    image_url = data["_embedded"]["wp:featuredmedia"][0]["source_url"]
except (KeyError, IndexError):
    pass

# 5. Extract Category Name (from embedded data)
category = None
try:
    category = data["_embedded"]["wp:term"][0][0]["name"]
except (KeyError, IndexError):
    pass

# Clean JSON Result
result = {
    "id": data.get("id"),
    "title": html.unescape(data.get("title", {}).get("rendered", "")),
    "date": data.get("date"),
    "post_url": data.get("link"),
    "category": category,
    "image_url": image_url,
    "audio_url": audio_url,
    "description": description,
    "tags": tags_text,
}

print(json.dumps(result, indent=2))