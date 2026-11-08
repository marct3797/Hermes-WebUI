"""Sammelt die deutschen Meldungen des BFF (Fehlertexte) für die Übersetzung: schreibt src/locales/_backend.json.
f-Strings werden zu Vorlagen mit {name}; das Frontend gleicht Meldungen per Muster ab (tm in src/i18n.ts)."""
import ast, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parents[2] / "backend" / "app"
OUT = pathlib.Path(__file__).resolve().parents[1] / "src" / "locales" / "_backend.json"
GERMAN = re.compile(r"[äöüÄÖÜß]|\b(nicht|der|die|das|und|oder|kein|keine|ist|wird|für|mit|bitte|Fehler|fehlt|ungültig)\b", re.I)


def is_german(s: str) -> bool:
    return " " in s.strip() and bool(GERMAN.search(s)) and not s.lstrip().startswith(("SELECT ", "http"))


def template(node: ast.JoinedStr) -> str:
    used: set[str] = set()
    out = []
    for v in node.values:
        if isinstance(v, ast.Constant):
            out.append(str(v.value).replace("{", "{{").replace("}", "}}") if False else str(v.value))
            continue
        text = ast.unparse(v.value)
        m = re.findall(r"[A-Za-z_]\w*", text)
        base = re.sub(r"\d+$", "", m[-1]) if m else "v"
        base = base if re.fullmatch(r"\w+", base) and base not in {"str", "int", "type", "name"} or base == "name" else "v"
        name, i = base or "v", 2
        while name in used:
            name = f"{base}{i}"; i += 1
        used.add(name)
        out.append("{" + name + "}")
    return "".join(out)


def main() -> None:
    keys: set[str] = set()
    for f in ROOT.rglob("*.py"):
        for n in ast.walk(ast.parse(f.read_text())):
            cands = []
            if isinstance(n, ast.Call):
                cands = list(n.args) + [k.value for k in n.keywords]
            elif isinstance(n, ast.Assign):
                cands = [n.value]
            for a in cands:
                if isinstance(a, ast.Constant) and isinstance(a.value, str) and is_german(a.value):
                    keys.add(a.value)
                elif isinstance(a, ast.JoinedStr):
                    t = template(a)
                    if is_german(re.sub(r"\{\w+\}", "", t)):
                        keys.add(t)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = sorted(k.strip() if False else k for k in keys)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    print(len(data), "Meldungen,", sum("{" in k for k in data), "mit Platzhaltern")


if __name__ == "__main__":
    sys.exit(main())
