"use strict";

/**
 * server.js — Render service (DOCX/PDF)
 *
 * Endpoints:
 *  - GET  /health
 *  - POST /render         (template: .docx, data: JSON string) -> docx
 *  - POST /replace-image  (docx: .docx, data: { obraz_url })   -> docx
 *  - POST /stamp          (pdf: .pdf,  data: { obraz_url })    -> pdf
 *
 * ENV (opcjonalnie):
 *  - PORT=3001
 *  - CORS_ORIGINS=*  (albo lista po przecinku)
 *  - MAX_UPLOAD_MB=25
 *  - MAX_REMOTE_MB=10
 *  - AXIOS_TIMEOUT_MS=8000
 *  - ALLOWED_IMAGE_HOSTS=example.com,cdn.example.com (opcjonalnie allowlist hostów)
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const net = require("net");

const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const axios = require("axios");

const ImageModule = require("open-docxtemplater-image-module");
const sizeOf = require("image-size");
const { PDFDocument } = require("pdf-lib");

const app = express();
app.disable("x-powered-by");

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3001);

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const MAX_UPLOAD_BYTES = Math.max(1, MAX_UPLOAD_MB) * 1024 * 1024;

const MAX_REMOTE_MB = Number(process.env.MAX_REMOTE_MB || 10);
const MAX_REMOTE_BYTES = Math.max(1, MAX_REMOTE_MB) * 1024 * 1024;

const AXIOS_TIMEOUT_MS = Number(process.env.AXIOS_TIMEOUT_MS || 8000);

const ALLOWED_IMAGE_HOSTS = String(process.env.ALLOWED_IMAGE_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- Middleware ----------
app.use(
  cors({
    origin: (origin, cb) => {
      // brak origin (np. curl/postman) -> OK
      if (!origin) return cb(null, true);

      // "*" -> zezwalaj wszystkim
      if (CORS_ORIGINS.length === 1 && CORS_ORIGINS[0] === "*") return cb(null, true);

      // lista -> dopuszczaj tylko wskazane
      const ok = CORS_ORIGINS.includes(origin);
      return cb(ok ? null : new Error("CORS blocked"), ok);
    },
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// ---------- Helpers ----------
function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

function badRequest(res, message, extra) {
  return res.status(400).json({ error: message, ...(extra ? { details: extra } : {}) });
}

function serverError(res, err, extra) {
  return res
    .status(500)
    .json({ error: err?.message || "Server error", ...(extra ? { details: extra } : {}) });
}

function parseDataJson(req, res) {
  const raw = req.body?.data;
  if (!raw) return { ok: false, res: badRequest(res, "Missing 'data' field") };
  try {
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, res: badRequest(res, "Invalid JSON in 'data' field") };
  }
}

/**
 * Minimalny SSRF-guard:
 * - tylko http/https
 * - blokada localhost + oczywistych prywatnych IP (jeśli host jest IP)
 * - opcjonalna allowlista hostów (ALLOWED_IMAGE_HOSTS)
 *
 * Uwaga: bez DNS-resolve nie wykryje hosta, który wskazuje na prywatne IP.
 * Do produkcji: resolve DNS + blokada prywatnych zakresów po resolve.
 */
function isPrivateIPv4(ip) {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)

  return false;
}

function isPrivateIPv6(host) {
  const h = host.toLowerCase();
  if (h === "::1") return true; // loopback
  if (h.startsWith("fe80:")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local fc00::/7
  return false;
}

function assertSafeHttpUrl(inputUrl) {
  let u;
  try {
    u = new URL(String(inputUrl));
  } catch {
    throw new Error("Invalid URL for obraz_url");
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed for obraz_url");
  }

  const host = (u.hostname || "").toLowerCase();
  if (!host) throw new Error("Invalid URL hostname");

  // allowlist (jeśli ustawiona)
  if (ALLOWED_IMAGE_HOSTS.length > 0) {
    const ok = ALLOWED_IMAGE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    if (!ok) throw new Error("Host not allowed for obraz_url");
  }

  // blokada localhost w nazwie
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("Localhost is not allowed for obraz_url");
  }

  // blokada prywatnych IP, jeśli host jest IP
  const ipType = net.isIP(host);
  if (ipType === 4 && isPrivateIPv4(host)) throw new Error("Private IPv4 is not allowed for obraz_url");
  if (ipType === 6 && isPrivateIPv6(host)) throw new Error("Private IPv6 is not allowed for obraz_url");

  return u.toString();
}

async function downloadImageBytes(obrazUrl) {
  const safeUrl = assertSafeHttpUrl(obrazUrl);

  const resp = await axios.get(safeUrl, {
    responseType: "arraybuffer",
    timeout: AXIOS_TIMEOUT_MS,
    maxContentLength: MAX_REMOTE_BYTES,
    maxBodyLength: MAX_REMOTE_BYTES,
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const bytes = Buffer.from(resp.data);
  const contentType = String(resp.headers?.["content-type"] || "").toLowerCase();

  return { bytes, contentType, url: safeUrl };
}

function repairBrokenTags(xml) {
  // Docxtemplater tagi potrafią się “porozrywać” w <w:t> przez Worda.
  // Ta funkcja skleja ciągi, usuwając zamknięcia/otwarcia między fragmentami tagu.
  let prev;
  do {
    prev = xml;

    xml = xml.replace(
      /<\/w:t>\s*<\/w:r>\s*(?:<w:r[^>]*>\s*)*<w:t[^>]*>/g,
      ""
    );

    xml = xml.replace(
      /<\/w:t>\s*<\/w:r>\s*<w:proofErr[^>]*\/>\s*<w:r[^>]*>\s*<w:t[^>]*>/g,
      ""
    );
  } while (xml !== prev);

  return xml;
}

function ensureDocxZipAndRepair(buffer) {
  const zip = new PizZip(buffer);

  // Napraw XML w dokumencie + nagłówkach/stopkach (jeśli tam też są tagi)
  Object.keys(zip.files).forEach((name) => {
    const isMain = name === "word/document.xml";
    const isHeader = /^word\/header\d+\.xml$/.test(name);
    const isFooter = /^word\/footer\d+\.xml$/.test(name);

    if (isMain || isHeader || isFooter) {
      const xml = zip.files[name].asText();
      zip.file(name, repairBrokenTags(xml));
    }
  });

  return zip;
}

// ---------- Routes ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "aaepw-render-service",
    maxUploadMB: MAX_UPLOAD_MB,
    maxRemoteMB: MAX_REMOTE_MB,
    timeoutMs: AXIOS_TIMEOUT_MS,
  });
});

/**
 * /render
 * multipart/form-data:
 *  - template: .docx
 *  - data: JSON string
 */
app.post("/render", upload.single("template"), async (req, res) => {
  try {
    if (!req.file) return badRequest(res, "Missing 'template' file");

    const parsed = parseDataJson(req, res);
    if (!parsed.ok) return parsed.res;
    const data = parsed.data;

    // Image module (opcjonalnie — jeśli używasz {%obraz} i w data.obraz masz base64)
    const imageModule = new ImageModule({
      centered: false,
      fileType: "docx",
      getImage: function (tagValue) {
        if (!tagValue) return null;

        // akceptuj: "data:image/png;base64,..." albo sam base64
        const base64 =
          typeof tagValue === "string" && tagValue.startsWith("data:")
            ? tagValue.split(",")[1]
            : tagValue;

        return Buffer.from(base64, "base64");
      },
      getSize: function (img) {
        const d = sizeOf(img);
        const maxW = 500;
        const scale = d.width > maxW ? maxW / d.width : 1;
        return [Math.round(d.width * scale), Math.round(d.height * scale)];
      },
    });

    const zip = ensureDocxZipAndRepair(req.file.buffer);

    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: "{{", end: "}}" },
      modules: [imageModule],
    });

    doc.setData(data);

    try {
      doc.render();
    } catch (e) {
      // Docxtemplater ma często użyteczne e.properties
      return serverError(res, e, e?.properties || null);
    }

    const out = doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader("Content-Disposition", "attachment; filename=rendered.docx");
    return res.send(out);
  } catch (e) {
    return serverError(res, e);
  }
});

/**
 * /replace-image
 * multipart/form-data:
 *  - docx: .docx
 *  - data: JSON string { obraz_url }
 *
 * Placeholder: obraz w Wordzie z ALT (Title lub Description) = "REPLACE_ME"
 * Mechanizm:
 *  - szuka docPr z ALT
 *  - wyciąga rId (z a:blip r:embed)
 *  - w rels znajduje Target
 *  - podmienia bytes w word/media/...
 */
app.post("/replace-image", upload.single("docx"), async (req, res) => {
  try {
    if (!req.file) return badRequest(res, "Missing 'docx' file");

    const parsed = parseDataJson(req, res);
    if (!parsed.ok) return parsed.res;

    const obrazUrl = parsed.data?.obraz_url;

    // brak URL = zwracamy bez zmian
    if (!obrazUrl) {
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      res.setHeader("Content-Disposition", "attachment; filename=out.docx");
      return res.send(req.file.buffer);
    }

    // pobierz obraz (z limitami + timeout)
    const { bytes: imgBytes, url: safeUrl } = await downloadImageBytes(obrazUrl);

    const zip = new PizZip(req.file.buffer);
    const ALT = "REPLACE_ME";

    // skanuj: dokument + header/footer
    const xmlCandidates = Object.keys(zip.files).filter((p) =>
      /^word\/(document|header\d+|footer\d+)\.xml$/.test(p)
    );

    function relsPathFor(xmlPath) {
      const base = xmlPath.split("/").pop(); // np header1.xml
      return `word/_rels/${base}.rels`;
    }

    function findRidNearAlt(xml) {
      // Szukamy docPr z title/descr=ALT, a potem w pobliżu a:blip r:embed="rIdX"
      const re = new RegExp(
        `<wp:docPr[^>]*(?:descr|title)="${ALT}"[^>]*\\/?>`,
        "g"
      );

      let m;
      while ((m = re.exec(xml)) !== null) {
        const start = m.index;
        const snippet = xml.slice(start, start + 8000); // wystarczy na jeden drawing
        const rid = snippet.match(/r:embed="(rId\d+)"/);
        if (rid) return rid[1];
      }
      return null;
    }

    let replaced = false;
    let replacedWhere = "";

    for (const xmlPath of xmlCandidates) {
      const relsPath = relsPathFor(xmlPath);
      if (!zip.files[relsPath]) continue;

      const xml = zip.files[xmlPath].asText();
      const relsXml = zip.files[relsPath].asText();

      const rId = findRidNearAlt(xml);
      if (!rId) continue;

      // Relationship Id=rIdX Target="media/imageY.ext"
      const relRe = new RegExp(
        `<Relationship[^>]*Id="${rId}"[^>]*Target="([^"]+)"[^>]*>`,
        "m"
      );
      const rm = relsXml.match(relRe);
      if (!rm) continue;

      const target = rm[1];
      const mediaPath = target.startsWith("media/")
        ? `word/${target}`
        : target.startsWith("../media/")
        ? `word/media/${target.split("/").pop()}`
        : `word/${target}`;

      if (!zip.files[mediaPath]) continue;

      zip.file(mediaPath, imgBytes);

      replaced = true;
      replacedWhere = `${xmlPath} -> ${mediaPath} (${rId}) from ${safeUrl}`;
      break;
    }

    if (!replaced) {
      log("REPLACE-IMAGE: ALT not found. Checked:", xmlCandidates);
      return res.status(400).json({
        error: `Placeholder image not found`,
        details: `Nie znalazłem obrazka z alt-text "${ALT}". Ustaw w Wordzie ALT (Title lub Description) dokładnie na "${ALT}".`,
      });
    }

    log("REPLACE-IMAGE OK:", replacedWhere);

    const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader("Content-Disposition", "attachment; filename=out.docx");
    return res.send(out);
  } catch (e) {
    return serverError(res, e);
  }
});

/**
 * /stamp
 * multipart/form-data:
 *  - pdf: PDF
 *  - data: JSON { obraz_url }
 * Zwrot: PDF z obrazem na stronie 1 (prawy-górny róg)
 */
app.post("/stamp", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return badRequest(res, "Missing 'pdf' file");

    const parsed = parseDataJson(req, res);
    if (!parsed.ok) return parsed.res;

    const obrazUrl = parsed.data?.obraz_url;

    if (!obrazUrl) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=stamped.pdf");
      return res.send(req.file.buffer);
    }

    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const page = pdfDoc.getPages()[0];
    const { width, height } = page.getSize();

    const { bytes: imgBytes, contentType } = await downloadImageBytes(obrazUrl);

    // embed png/jpg — gdy content-type jest słaby, rozpoznaj po sygnaturze
    const isPngByHeader =
      imgBytes.length >= 8 &&
      imgBytes[0] === 0x89 &&
      imgBytes[1] === 0x50 &&
      imgBytes[2] === 0x4e &&
      imgBytes[3] === 0x47;

    let embeddedImg;
    if (contentType.includes("png") || isPngByHeader) {
      embeddedImg = await pdfDoc.embedPng(imgBytes);
    } else {
      embeddedImg = await pdfDoc.embedJpg(imgBytes);
    }

    // rozmiar stempla
    const maxW = 260;
    const maxH = 160;
    const margin = 36;

    const imgW = embeddedImg.width;
    const imgH = embeddedImg.height;

    const scale = Math.min(1, maxW / imgW, maxH / imgH);
    const drawW = imgW * scale;
    const drawH = imgH * scale;

    const x = width - drawW - margin;
    const y = height - drawH - margin;

    page.drawImage(embeddedImg, { x, y, width: drawW, height: drawH });

    const outPdf = await pdfDoc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=stamped.pdf");
    return res.send(Buffer.from(outPdf));
  } catch (e) {
    return serverError(res, e);
  }
});

// ---------- Error handler (multer itp.) ----------
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(413).json({
      error: "Upload rejected",
      details: err.message,
    });
  }

  if (err && String(err.message || "").includes("CORS")) {
    return res.status(403).json({ error: "CORS blocked" });
  }

  if (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// ---------- Process guards ----------
process.on("unhandledRejection", (reason) => {
  log("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  log("UNCAUGHT EXCEPTION:", err);
});

// ---------- Listen ----------
app.listen(PORT, "0.0.0.0", () => {
  log(`aaepw-render-service listening on :${PORT}`);
});
