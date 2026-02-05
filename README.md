## Third-party
This project uses open-source packages, including: Express, Docxtemplater, pdf-lib, axios, multer.
License

## Compatibility
Tested on: Windows 10/11 + Node 18/20, Docker Desktop.

# AAEPW Render Service (DOCX/PDF)

Lekki serwis HTTP do generowania dokumentów (DOCX/PDF) — komponent/demo do architektury **A.A.E.P.W**.  
Docs/architektura: https://github.com/DudiRuders/A.A.E.P.W
![Node](https://img.shields.io/badge/node-18%2B-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Co to robi
- **DOCX templating** — generuje dokumenty z szablonów `.docx` + dane JSON  
- **DOCX image replace** — podmienia obraz w DOCX przez placeholder (ALT = `REPLACE_ME`)  
- **PDF stamp** — dodaje obraz (np. “pieczątka”) na **pierwszej stronie** PDF

---

## Szybki start (lokalnie)
Wymagania: **Node.js 18+** (zalecane 20 LTS)

1) Instalacja: `npm install`  
2) Start: `npm start`  
3) Test: `curl.exe http://localhost:3001/health`  

Domyślny adres: `http://localhost:3001`

---

## API (skrót)

| Endpoint | Metoda | Co robi | Dane wejściowe |
|---|---:|---|---|
| `/health` | GET | Healthcheck | — |
| `/render` | POST | Render DOCX z szablonu | `template` (.docx) + `data` (JSON string) |
| `/replace-image` | POST | Podmiana obrazu w DOCX | `docx` (.docx) + `data.obraz_url` |
| `/stamp` | POST | Stempel na PDF (1 strona) | `pdf` (.pdf) + `data.obraz_url` |

---

## Jak przygotować pliki

### Szablon DOCX (templating)
Wstaw w treści pola w stylu: `{{imie}}`, `{{nazwisko}}` itd.

### Placeholder obrazu w DOCX
W Wordzie ustaw ALT obrazka-placeholdera dokładnie na: `REPLACE_ME`  
(Typowo: PPM na obraz → “Edytuj tekst alternatywny” → Title/Description)

---

## Przykłady użycia (zwijane)

<details>
  <summary><b>POST /render — generowanie DOCX</b></summary>

  <br/>

  **Windows (cmd.exe):**
  ```bat
  curl.exe -X POST "http://localhost:3001/render" ^
    -F "template=@template.docx" ^
    -F "data={\"imie\":\"Jan\",\"nazwisko\":\"Kowalski\"}" ^
    --output rendered.docx

