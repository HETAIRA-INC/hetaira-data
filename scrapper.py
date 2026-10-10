"""
Fetch WordPress posts and print a JSON ARRAY ready to paste into the admin's "Batch Ingest" dialog.

    python scrapper.py https://goddessnichole.com 2500 2501 > posts.json

Needs: pip install beautifulsoup4 curl_cffi
"""
import html
import json
import sys

from bs4 import BeautifulSoup
from curl_cffi import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "application/json",
}


def fetch_post(site: str, post_id: str) -> dict:
    # ?_embed includes the featured image and category details in one request
    api_url = f"{site.rstrip('/')}/wp-json/wp/v2/posts/{post_id}?_embed"
    response = requests.get(api_url, headers=HEADERS, impersonate="chrome120", timeout=60)
    if response.status_code != 200:
        raise RuntimeError(f"{api_url} -> HTTP {response.status_code}")
    data = response.json()

    soup = BeautifulSoup(data.get("content", {}).get("rendered", ""), "html.parser")
    audio_elem = soup.select_one("audio source") or soup.select_one("audio[src]")
    audio_url = (audio_elem.get("src") if audio_elem else None) or None

    paragraphs = [p.get_text(strip=True) for p in soup.select("p")]
    description = paragraphs[0] if len(paragraphs) > 0 else None
    tags_text = paragraphs[1] if len(paragraphs) > 1 else None

    embedded = data.get("_embedded", {})
    try:
        image_url = embedded["wp:featuredmedia"][0]["source_url"]
    except (KeyError, IndexError, TypeError):
        image_url = None
    try:
        category = embedded["wp:term"][0][0]["name"]
    except (KeyError, IndexError, TypeError):
        category = None

    return {
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


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 1
    site, ids = sys.argv[1], sys.argv[2:]
    results, failed = [], 0
    for post_id in ids:
        try:
            results.append(fetch_post(site, post_id))
        except Exception as exc:  # keep going; report at the end
            failed += 1
            print(f"! post {post_id}: {exc}", file=sys.stderr)
    print(json.dumps(results, indent=2, ensure_ascii=False))
    return 1 if failed and not results else 0


if __name__ == "__main__":
    sys.exit(main())
