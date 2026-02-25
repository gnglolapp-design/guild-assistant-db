import argparse
import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

EMBED_COLOR = 0xF2C94C  # jaune
UA = "Mozilla/5.0 (GuildAssistantDB/1.0)"

@dataclass
class Entity:
  kind: str
  name: str
  slug: str
  url: str
  image_url: str
  embeds: List[Dict[str, Any]]
  page_hash: str


def slugify(s: str) -> str:
  s = (s or "").strip().lower()
  s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
  s = re.sub(r"[\s_-]+", "_", s)
  return s.strip("_")


def clean_block_text(s: str) -> str:
  s = re.sub(r"\s+", " ", (s or "").strip())
  return s


def textify(el) -> str:
  if el is None:
    return ""
  return el.get_text("\n", strip=True)


def digest_lines(lines: List[str], max_chars: int) -> str:
  out = []
  total = 0
  for ln in lines:
    if not ln:
      continue
    if total + len(ln) + 1 > max_chars:
      break
    out.append(ln)
    total += len(ln) + 1
  return "\n".join(out).strip()


def write_json(path: Path, obj: Any) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  with path.open("w", encoding="utf-8") as f:
    json.dump(obj, f, ensure_ascii=False, indent=2)


def sha1_text(s: str) -> str:
  return hashlib.sha1((s or "").encode("utf-8")).hexdigest()


def make_embed(title: str, url: str = "", description: str = "", fields: Optional[List[Dict[str, Any]]] = None,
               thumbnail_url: str = "", image_url: str = "", footer: str = "") -> Dict[str, Any]:
  e: Dict[str, Any] = {
    "title": title[:256],
    "color": EMBED_COLOR,
  }
  # Note : on évite d'ajouter `url` par défaut pour empêcher la "redirection" (titre cliquable) dans Discord.
  if url:
    e["url"] = url
  if description:
    e["description"] = description[:4096]
  if fields:
    e["fields"] = fields[:25]
  if thumbnail_url:
    e["thumbnail"] = {"url": thumbnail_url}
  if image_url:
    e["image"] = {"url": image_url}
  if footer:
    e["footer"] = {"text": footer[:2048]}
  return e


def extract_first_image(soup: BeautifulSoup) -> str:
  img = soup.select_one("main img")
  if img and img.get("src"):
    return img["src"]
  og = soup.find("meta", {"property": "og:image"})
  if og and og.get("content"):
    return og["content"]
  return ""


def extract_stats_table(soup: BeautifulSoup) -> Dict[str, str]:
  # Heuristique : si une table existe, on prend la première
  tbl = soup.select_one("main table")
  if not tbl:
    return {}
  out: Dict[str, str] = {}
  for row in tbl.select("tr"):
    cells = [clean_block_text(textify(td)) for td in row.select("th,td")]
    if len(cells) >= 2:
      k, v = cells[0], cells[1]
      if k and v:
        out[k] = v
  return out


def extract_sections(soup: BeautifulSoup) -> List[Tuple[str, str]]:
  # On découpe par h2/h3 en gardant le texte dessous
  main = soup.select_one("main")
  if not main:
    return []
  headers = main.find_all(["h2", "h3"])
  out: List[Tuple[str, str]] = []
  for h in headers:
    title = clean_block_text(textify(h))
    body_lines: List[str] = []
    for sib in h.find_all_next():
      if sib.name in ["h2", "h3"]:
        break
      if sib.name in ["p", "ul", "ol", "table"]:
        txt = clean_block_text(textify(sib))
        if txt:
          body_lines.append(txt)
    body = digest_lines(body_lines, 3500)
    if title and body:
      out.append((title, body))
  return out


def scrape_hideout(url: str, browser) -> Tuple[str, BeautifulSoup]:
  page = browser.new_page(user_agent=UA)
  page.goto(url, wait_until="domcontentloaded", timeout=60000)
  page.wait_for_timeout(800)
  html = page.content()
  page.close()
  soup = BeautifulSoup(html, "lxml")
  return html, soup


def list_pages_hideout(base_list_url: str, browser) -> List[str]:
  # Récupère tous les liens internes qui ressemblent à des pages de détails
  html, soup = scrape_hideout(base_list_url, browser)
  links = []
  for a in soup.select("main a[href]"):
    href = a.get("href") or ""
    if href.startswith("/"):
      href = "https://hideoutgacha.com" + href
    if href.startswith("https://hideoutgacha.com/") and "/games/seven-deadly-sins-origin/" in href:
      links.append(href.split("#")[0])
  # dédupe
  seen = set()
  out = []
  for u in links:
    if u not in seen:
      seen.add(u)
      out.append(u)
  return out


def parse_hideout_character(url: str, browser) -> Optional[Entity]:
  html, soup = scrape_hideout(url, browser)
  canon = url
  title = soup.find("h1")
  name = clean_block_text(textify(title)) or "Personnage"
  image_url = extract_first_image(soup)

  stats = extract_stats_table(soup)
  sections = extract_sections(soup)

  kind = "character"
  embeds: List[Dict[str, Any]] = []
  footer = "Guild Assistant DB • Source : HideoutGacha"

  main = soup.select_one("main")

  # 1) Fiche (Résumé + À retenir si dispo)
  intro_lines: List[str] = []
  # Heuristique : premiers <p> du main
  if main:
    for p in main.find_all("p", limit=3):
      t = clean_block_text(textify(p))
      if t:
        intro_lines.append(t)
  intro = digest_lines(intro_lines, 1500)

  # On essaie de récupérer une section "À retenir" / "Key takeaways" si elle existe
  takeaways_body = ""
  takeaways_key = ""
  for t, body in sections:
    key = slugify(t)
    if ("retenir" in key) or ("takeaway" in key) or ("key_points" in key) or ("keypoint" in key) or (key in ["notes", "tips"]):
      takeaways_body = body.strip()
      takeaways_key = key
      break

  def normalize_bullets(s: str) -> str:
    lines = [ln.strip() for ln in s.splitlines() if ln.strip()]
    out: List[str] = []
    for ln in lines:
      if ln.startswith(("•", "-", "*", "1.", "2.", "3.")):
        out.append(ln)
      else:
        out.append("• " + ln)
    return "\n".join(out).strip()

  desc_parts: List[str] = []
  if intro:
    desc_parts.append(f"Résumé : {intro}")
  else:
    desc_parts.append("Résumé : fiche générée automatiquement à partir de la source.")

  if takeaways_body:
    desc_parts.append("À retenir :\n" + normalize_bullets(takeaways_body))

  fiche_desc = "\n\n".join([p for p in desc_parts if p]).strip()
  embeds.append(make_embed(
    title=f"{name} (Fiche)",
    description=fiche_desc[:3800],
    image_url=image_url,       # image principale (si dispo)
    thumbnail_url=image_url,   # fallback / affichage compact
    footer=footer,
  ))

  # 2) Stats (si dispo)
  if stats:
    fields = []
    for k, v in list(stats.items())[:18]:
      fields.append({"name": k[:256], "value": (v or "-")[:1024], "inline": True})
    embeds.append(make_embed(
      title="Stats",
      fields=fields,
      thumbnail_url=image_url,
      footer=footer,
    ))

  # 3) Sections (on filtre un minimum pour éviter doublons/bruit)
  seen_titles = set(["fiche", "stats"])
  if takeaways_key:
    seen_titles.add(takeaways_key)
  for t, body in sections:
    key = slugify(t)
    if not key or key in seen_titles:
      continue
    if any(x in key for x in ["commentaires", "sources", "credits", "footer"]):
      continue
    seen_titles.add(key)
    embeds.append(make_embed(
      title=t[:256],
      description=body[:3800],
      footer=footer,
    ))
    if len(embeds) >= 24:
      break

  slug = slugify(canon.split("/")[-1] or name)
  return Entity(kind=kind, name=name, slug=slug, url=canon, image_url=image_url, embeds=embeds, page_hash=sha1_text(html))


def parse_hideout_boss(url: str, browser) -> Optional[Entity]:
  html, soup = scrape_hideout(url, browser)
  canon = url
  title = soup.find("h1")
  name = clean_block_text(textify(title)) or "Boss"
  image_url = extract_first_image(soup)

  kind = "boss"
  embeds: List[Dict[str, Any]] = []
  footer = "Guild Assistant DB • Source : HideoutGacha"

  main = soup.select_one("main")
  intro_lines: List[str] = []
  if main:
    for p in main.find_all("p", limit=5):
      t = clean_block_text(textify(p))
      if t:
        intro_lines.append(t)
  intro = digest_lines(intro_lines, 1800)
  if intro:
    embeds.append(make_embed(
      title=f"{name} (Boss)",
      description=intro,
      thumbnail_url=image_url,
      image_url=image_url,
      footer=footer,
    ))
  else:
    embeds.append(make_embed(
      title=f"{name} (Boss)",
      description="Fiche générée automatiquement à partir de la source.",
      thumbnail_url=image_url,
      image_url=image_url,
      footer=footer,
    ))

  sections = extract_sections(soup)
  seen = set(["boss"])
  for t, body in sections:
    key = slugify(t)
    if not key or key in seen:
      continue
    seen.add(key)
    embeds.append(make_embed(
      title=t[:256],
      description=body[:3800],
      footer=footer,
    ))
    if len(embeds) >= 24:
      break

  slug = slugify(canon.split("/")[-1] or name)
  return Entity(kind=kind, name=name, slug=slug, url=canon, image_url=image_url, embeds=embeds, page_hash=sha1_text(html))


def chunk_embeds(embeds: List[Dict[str, Any]], n: int = 10) -> List[List[Dict[str, Any]]]:
  out = []
  for i in range(0, len(embeds), n):
    out.append(embeds[i:i + n])
  return out


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--out", default="data", help="Output directory (default: data)")
  ap.add_argument("--max", type=int, default=0, help="Max pages per category (0 = no limit)")
  args = ap.parse_args()

  out_dir = Path(args.out)
  out_dir.mkdir(parents=True, exist_ok=True)

  base = "https://hideoutgacha.com/games/seven-deadly-sins-origin"
  list_char = base + "/characters"
  list_boss = base + "/bosses"

  with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    char_urls = list_pages_hideout(list_char, browser)
    boss_urls = list_pages_hideout(list_boss, browser)

    # garde uniquement les pages "profondes" (pas les pages de listing elles-mêmes)
    char_urls = [u for u in char_urls if u != list_char]
    boss_urls = [u for u in boss_urls if u != list_boss]

    if args.max and args.max > 0:
      char_urls = char_urls[:args.max]
      boss_urls = boss_urls[:args.max]

    print(f"Scraping {len(char_urls)} character pages ...")
    chars: List[Entity] = []
    for u in char_urls:
      try:
        ent = parse_hideout_character(u, browser)
        if ent:
          chars.append(ent)
      except Exception as e:
        print("CHAR FAIL", u, e)

    print(f"Scraping {len(boss_urls)} boss pages ...")
    bosses: List[Entity] = []
    for u in boss_urls:
      try:
        ent = parse_hideout_boss(u, browser)
        if ent:
          bosses.append(ent)
      except Exception as e:
        print("BOSS FAIL", u, e)

    browser.close()

  # index
  items = []
  for ent in chars:
    items.append({
      "type": ent.kind,
      "game": "7dso",
      "name": ent.name,
      "slug": ent.slug,
      "embeds_path": f"embeds/7dso/characters/{ent.slug}.json",
    })
  for ent in bosses:
    items.append({
      "type": ent.kind,
      "game": "7dso",
      "name": ent.name,
      "slug": ent.slug,
      "embeds_path": f"embeds/7dso/bosses/{ent.slug}.json",
    })

  idx = {
    "version": 1,
    "updated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "items": items,
  }
  write_json(out_dir / "index.json", idx)

  # write embeds
  for ent in chars:
    abs_path = out_dir / f"embeds/7dso/characters/{ent.slug}.json"
    messages = [{"embeds": chunk} for chunk in chunk_embeds(ent.embeds, 10)]
    write_json(abs_path, {"messages": messages})

  for ent in bosses:
    abs_path = out_dir / f"embeds/7dso/bosses/{ent.slug}.json"
    messages = [{"embeds": chunk} for chunk in chunk_embeds(ent.embeds, 10)]
    write_json(abs_path, {"messages": messages})


if __name__ == "__main__":
  main()