import json
import asyncio
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup
import sqlite3

BASE_URL = "https://play.toornament.com"
TOURNAMENT_ID = "2425613637680488447"
MATCHES_URL = f"{BASE_URL}/de/tournaments/{TOURNAMENT_ID}/matches/"


def scrape_matches(url: str = MATCHES_URL) -> list[dict]:
    """Return all upcoming matches for a toornament matches URL.

    Each entry: {"stage": [str, ...], "team1": str, "team2": str, "url": str}
    stage is a list of path components, e.g. ["Erste Liga", "Division 1", "Day 5"].
    """
    return asyncio.run(_scrape_upcoming(url))


async def _scrape_upcoming(url: str) -> list[dict]:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto(url, wait_until="domcontentloaded")
        await page.wait_for_timeout(3000)

        btn = page.locator("text=Anstehend")
        await btn.wait_for(state="visible", timeout=5000)
        await btn.click()
        await page.wait_for_timeout(3000)

        while True:
            more = page.locator("text=Mehr laden")
            try:
                await more.wait_for(state="visible", timeout=3000)
            except Exception:
                break
            await more.scroll_into_view_if_needed()
            await more.click()
            await page.wait_for_timeout(2500)

        html = await page.content()
        await browser.close()

    return _parse_matches(html, url)


def _parse_matches(html: str, base_url: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    dl_lists = soup.select(".dl-list")
    main_dl = next((dl for dl in dl_lists if dl.select(".match.format-header")), None)
    if not main_dl:
        return []

    matches = []
    for block in main_dl.children:
        if not hasattr(block, "select"):
            continue
        match = block.select_one(".match.format-header")
        if not match:
            continue

        text_divs = [
            d.get_text(strip=True)
            for d in block.find_all("div", class_=lambda c: c and "text" in c and "sized" in c)
        ]
        stage = "/".join(t for t in text_divs if t not in ("/", "-"))
        stage.replace("/Stage", "/Day")

        t1 = match.select_one(".opponent-1 .name")
        t2 = match.select_one(".opponent-2 .name")
        img1 = match.select_one(".opponent-1 img")
        img2 = match.select_one(".opponent-2 img")
        link = block.select_one('a[href*="/matches/"]')

        if not t1 or not t2:
            continue

        team1 = t1.get_text(strip=True)
        team2 = t2.get_text(strip=True)

        if team1 == "NF" or team2 == "NF":
            continue

        matches.append({
            "stage": stage,
            "team1": team1,
            "team2": team2,
            "logo1": img1.get("src", "") if img1 else "",
            "logo2": img2.get("src", "") if img2 else "",
        })

    return matches


if __name__ == "__main__":
    results = scrape_matches()
    with open("matches.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    with open("matches.json", "r", encoding="utf-8") as f:
        results = json.load(f)

    lowest_day = float('inf')
    for result in results:
        day = int(result["stage"].split(" ")[-1])
        if day < lowest_day:
            print(result["stage"])
            lowest_day = day

    con = sqlite3.connect("db.sqlite3")

    for result in results:
        if not result["stage"].endswith(str(lowest_day)):
            continue
        print(result)
        con.execute('INSERT INTO matches (TeamA, TeamB, LogoA, LogoB, Section) VALUES (?, ?, ?, ?, ?)',
                    (result["team1"], result["team2"], result["logo1"], result["logo2"], result["stage"]))
    con.commit()
