"""Conservative archive identities; never infer them from descriptions or a pin."""
import hashlib
import re
import unicodedata

DISTRICTS = frozenset({
    "Staré Město", "Nové Město", "Malá Strana", "Hradčany", "Holešovice",
    "Smíchov", "Josefov", "Vinohrady", "Bubeneč", "Dejvice", "Břevnov",
    "Troja", "Karlín", "Hlubočepy", "Žižkov", "Libeň", "Vyšehrad", "Košíře",
    "Strašnice", "Bohnice", "Jinonice", "Vysočany", "Braník", "Hostivař",
})
# Only these bare street labels have reviewed cosmetic/search variants.
STREET_ALIASES = {
    "Letenská": ["Letenská ulice", "Letenské", "Letenskou"],
    "Josefská": ["Josefská ulice"],
    "Karmelitská": ["Karmelitská ulice"],
}


def clean_text(value):
    return " ".join(unicodedata.normalize("NFC", str(value or "")).split())


def identity(kind, label, district=""):
    seed = "\x1f".join((kind, label.casefold(), district.casefold()))
    return kind + "_" + hashlib.sha256(seed.encode()).hexdigest()[:24]


def classify(term):
    label = clean_text(term)
    label = re.sub(r"^Praha\s*-\s*", "", label)
    district_label = re.sub(r"\s*\(Praha\)$", "", label)
    if district_label in DISTRICTS:
        return district_label, "district"
    street = re.sub(r"^ulice\s+|\s+ulice$", "", label)
    if street != label or street in STREET_ALIASES:
        return street, "street"
    return label, "other"


def normalize_archive_metadata(raw):
    """Return JSON-safe fields. Missing raw metadata produces unknown places."""
    raw = raw or {}
    terms = list(dict.fromkeys(
        entry["obsah"] for entry in raw.get("rejstříkové záznamy", [])
        if isinstance(entry, dict) and entry.get("typ") == "Místo"
        and isinstance(entry.get("obsah"), str) and clean_text(entry["obsah"])
    ))
    classified = [(term, *classify(term)) for term in terms]
    districts = sorted({label for _, label, kind in classified if kind == "district"})
    places = {}
    for term, label, kind in classified:
        district = districts[0] if kind == "street" and len(districts) == 1 else ""
        place_id = identity(kind, label, district)
        if place_id not in places:
            places[place_id] = {
                "id": place_id, "label": label, "kind": kind,
                "aliases": STREET_ALIASES.get(label, []) if kind == "street" else [],
                "source": "archive", "source_terms": [],
                "ambiguous": kind == "street" and len(districts) > 1,
            }
            if district:
                places[place_id]["district"] = district
        places[place_id]["source_terms"].append(term)
    author = raw.get("autor") or raw.get("author")
    authors = []
    if isinstance(author, str) and clean_text(author):
        label = clean_text(author)
        authors.append({"id": identity("author", label), "label": label,
                        "aliases": [], "source": "archive", "source_terms": [author]})
    return {"archive_place_terms": terms,
            "places": sorted(places.values(), key=lambda item: item["id"]),
            "authors": authors}
