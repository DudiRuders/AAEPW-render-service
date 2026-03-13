## Third-party
This project uses open-source packages, including: Express, Docxtemplater, pdf-lib, axios, multer.
License

## Compatibility
Tested on: Windows 10/11 + Node 18/20, Docker Desktop.

# DOCX Render API Service

A lightweight, standalone Node.js microservice designed to handle dynamic document generation. It accepts raw JSON data and a base `.docx` template, maps the data to placeholders, and returns a fully customized document.

## 🎯 Purpose
In enterprise automation, rendering documents directly within an orchestrator (like n8n or Make) can be resource-heavy and limited. This dedicated microservice offloads the rendering process, allowing for complex formatting, image replacements, and custom logic via REST API.

## ⚙️ Core Endpoints
* `POST /render` - Ingests a `.docx` template and a JSON payload to replace text placeholders with actual data.
* `POST /replace-image` - Replaces image placeholders within the document (e.g., dynamic QR codes, logos, or signatures).
* `POST /stamp` - Adds a digital stamp or watermark to the generated PDF.

## 🚀 Usage in Architecture
This service acts as the rendering engine for the larger **Document Automation Engine**. An orchestrator (e.g., n8n) sends the raw data and template to this API, receives the finalized `.docx`, and then passes it along for PDF conversion and cloud storage.
