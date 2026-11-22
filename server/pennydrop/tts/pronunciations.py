from __future__ import annotations

import re
import unicodedata

KOKORO_NAMES = {
    "L'Eguillette": "lAɡwijˈɛt",
    "Balaguier": "bˌɑlɑɡjˈA",
    "Saliceti": "sˌɑliʧˈɛti",
    "Carteaux": "kɑɹtˈO",
    "Dugommier": "dˌuɡɔmjˈA",
    "Vendemiaire": "vˌɑndAmjˈɛɹ",
    "Sablons": "sɑblˈɔn",
    "Muiron": "mwiɹˈɔn",
    "Fructidor": "fɹˌʌktidˈɔɹ",
    "Formio": "fˈɔɹmjO",
    "Kleber": "klAbˈɛɹ",
    "Sieyes": "sjAˈjɛs",
    "Fouche": "fuʃˈA",
    "Brumaire": "bɹumˈɛɹ",
    "Aboukir": "ˌɑbukˈiɹ",
    "Barras": "bɑɹˈɑs",
    "Beauharnais": "bˌOɑɹnˈA",
    "Ducos": "dukˈO",
    "Augustin": "ˌOɡustˈɛn",
    "Arcole": "ɑɹkˈOl",
    "Ajaccio": "ˌɑʒɑʧˈiO",
    "Bourrienne": "buɹjˈɛn",
    "Lucien": "lyˈsjɛn",
    "Joubert": "ʒubˈɛɹ",
    "Maximilien": "mˌɑksimiljˈɛn",
}
NAME_TOKEN = re.compile(r"(?<![\w'’])(" + "|".join(re.escape(name) for name in sorted(KOKORO_NAMES, key=len, reverse=True)) + r")('s|’s)?(?![\w])")


def _unaccented(text: str) -> str:
    return "".join(unicodedata.normalize("NFD", char)[0] for char in text)


def kokoro_names(text: str) -> str:
    folded = _unaccented(text)
    out: list[str] = []
    cursor = 0
    for match in NAME_TOKEN.finditer(folded):
        possessive = "z" if match.group(2) else ""
        out.append(text[cursor : match.start()])
        out.append(f"[{text[match.start() : match.end()]}](/{KOKORO_NAMES[match.group(1)]}{possessive}/)")
        cursor = match.end()
    out.append(text[cursor:])
    return "".join(out)
