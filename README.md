# AAEPW Render Service (DOCX/PDF)

Mały serwis HTTP do:
- renderowania DOCX z szablonu (podmiana pól)
- podmiany obrazów w DOCX (placeholder ALT)
- stemplowania PDF obrazkiem (np. pieczątka)

## Run locally
Requirements: Node.js 18+

```bash
npm install
npm start
# http://localhost:3001
# AAEPW-render-service
curl http://localhost:3001/health
