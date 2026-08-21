import json
import os
from pathlib import Path

import requests
from requests.auth import HTTPBasicAuth
from dotenv import load_dotenv


# ============================================================
# Configuration
# ============================================================

BASE_DIR = Path(__file__).resolve().parent

load_dotenv(BASE_DIR / ".env")

CLIENT_ID = os.getenv("QF_CLIENT_ID")
CLIENT_SECRET = os.getenv("QF_CLIENT_SECRET")

# PRODUCTION
OAUTH_URL = "https://oauth2.quran.foundation/oauth2/token"
API_BASE = "https://apis.quran.foundation/content/api/v4"

OUTPUT_FILE = BASE_DIR / "quran_pages.json"

MUSHAF_ID = 1


# ============================================================
# Get access token
# ============================================================

def get_access_token():

    response = requests.post(
        OAUTH_URL,
        auth=HTTPBasicAuth(
            CLIENT_ID,
            CLIENT_SECRET
        ),
        data={
            "grant_type": "client_credentials",
            "scope": "content"
        },
        timeout=30
    )

    if not response.ok:
        print()
        print("ERROR: Authentication failed.")
        print(f"Status: {response.status_code}")
        print(response.text)
        response.raise_for_status()

    return response.json()["access_token"]


# ============================================================
# Get page boundaries
# ============================================================

def get_page(page_number, access_token):

    url = f"{API_BASE}/verses/by_page/{page_number}"

    headers = {
        "x-auth-token": access_token,
        "x-client-id": CLIENT_ID
    }

    params = {
        "mushaf": MUSHAF_ID,
        "per_page": 50
    }

    response = requests.get(
        url,
        headers=headers,
        params=params,
        timeout=30
    )

    if not response.ok:
        print()
        print(f"ERROR: Page {page_number} request failed.")
        print(f"Status: {response.status_code}")
        print(response.text)
        response.raise_for_status()

    return response.json()


# ============================================================
# Download all 604 pages
# ============================================================

def download_pages(access_token):

    pages = []

    for page_number in range(1, 605):

        print(
            f"Downloading page {page_number}/604...",
            end="\r"
        )

        try:
            data = get_page(
                page_number,
                access_token
            )

        except requests.RequestException as error:
            print()
            print(f"ERROR on page {page_number}:")
            print(error)
            print("Stopping immediately.")
            return None

        verses = data.get("verses", [])

        if not verses:
            print()
            print(
                f"ERROR: Page {page_number} returned no verses."
            )
            print("Stopping immediately.")
            return None

        first_verse = verses[0].get("verse_key")
        last_verse = verses[-1].get("verse_key")

        if not first_verse or not last_verse:
            print()
            print(
                f"ERROR: Page {page_number} is missing "
                "'verse_key' data."
            )
            print("Stopping immediately.")
            return None

        pages.append({
            "page": page_number,
            "from": first_verse,
            "to": last_verse
        })

    return pages


# ============================================================
# Main
# ============================================================

def main():

    if not CLIENT_ID:
        print("ERROR: QF_CLIENT_ID is missing from .env")
        return

    if not CLIENT_SECRET:
        print("ERROR: QF_CLIENT_SECRET is missing from .env")
        return

    print("Getting access token...")

    try:
        access_token = get_access_token()

    except requests.RequestException as error:
        print()
        print("ERROR: Could not authenticate.")
        print(error)
        return

    print("Authentication successful!")
    print()
    print("Downloading 604 page boundaries...")

    pages = download_pages(access_token)

    if pages is None:
        return

    # Final validation before writing the file
    if len(pages) != 604:
        print()
        print(
            f"ERROR: Expected 604 pages, got {len(pages)}."
        )
        print("Output file was NOT changed.")
        return

    for index, page in enumerate(pages, start=1):

        if page["page"] != index:
            print()
            print(
                f"ERROR: Page sequence is broken at page {index}."
            )
            print("Output file was NOT changed.")
            return

    # ========================================================
    # Save only after everything is valid
    # ========================================================

    with open(
        OUTPUT_FILE,
        "w",
        encoding="utf-8"
    ) as file:

        json.dump(
            pages,
            file,
            ensure_ascii=False,
            indent=2
        )

    print()
    print()
    print("Done!")
    print("Pages created: 604")
    print(f"Output: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()