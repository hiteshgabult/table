const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const app = express();
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cleanText(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSpan(cell, attr) {
  const value = Number.parseInt(cell.getAttribute(attr), 10);
  return Number.isFinite(value) && value > 1 ? value : 1;
}

function renderInlineNode(node) {
  if (node.nodeType === 3) return escapeHtml(node.textContent);
  if (node.nodeType !== 1) return '';

  const tag = node.tagName.toLowerCase();
  const content = Array.from(node.childNodes).map(renderInlineNode).join('');

  if (tag === 'br') return '<br>';
  if (['strong', 'b', 'em', 'i', 'u', 'sup', 'sub'].includes(tag)) {
    return `<${tag}>${content}</${tag}>`;
  }

  return content;
}

function renderList(list) {
  const tag = list.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul';

  const items = Array.from(list.children)
    .filter(child => child.tagName && child.tagName.toLowerCase() === 'li')
    .map(li => {
      const liParts = [];

      Array.from(li.childNodes).forEach(child => {
        if (child.nodeType === 1 && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
          liParts.push(renderList(child));
        } else {
          const html = renderInlineNode(child).trim();
          if (html) liParts.push(html);
        }
      });

      const content = liParts.join('').trim();
      return content ? `<li>${content}</li>` : '';
    })
    .filter(Boolean)
    .join('');

  return items ? `<${tag}>${items}</${tag}>` : '';
}

function getCellHtml(cell) {
  const parts = [];

  Array.from(cell.childNodes).forEach(node => {
    if (node.nodeType === 3) {
      const text = cleanText(node.textContent);
      if (text) parts.push(escapeHtml(text));
      return;
    }

    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();

    if (tag === 'ul' || tag === 'ol') {
      const listHtml = renderList(node);
      if (listHtml) parts.push(listHtml);
      return;
    }

    if (tag === 'p' || tag === 'div') {
      const innerParts = [];

      Array.from(node.childNodes).forEach(child => {
        if (child.nodeType === 1 && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
          const listHtml = renderList(child);
          if (listHtml) innerParts.push(listHtml);
        } else {
          const html = renderInlineNode(child).trim();
          if (html) innerParts.push(html);
        }
      });

      if (innerParts.length) parts.push(innerParts.join(''));
      return;
    }

    const html = renderInlineNode(node).trim();
    if (html) parts.push(html);
  });

  return parts.length ? parts.join('<br>') : escapeHtml(cleanText(cell.textContent));
}

function getColumnCount(rows) {
  let max = 0;

  rows.forEach(row => {
    let count = 0;

    row.querySelectorAll('th,td').forEach(cell => {
      count += getSpan(cell, 'colspan');
    });

    max = Math.max(max, count);
  });

  return Math.max(max, 1);
}

function shouldSkipTable(table) {
  const rows = Array.from(table.querySelectorAll('tr'));
  const cells = Array.from(table.querySelectorAll('th,td'));
  const text = cleanText(table.textContent);

  if (!rows.length || !cells.length) return true;
  if (/Callout--root|Callout--container|COPY HERE/i.test(text)) return true;

  const maxColumns = getColumnCount(rows);
  if (rows.length === 1 && maxColumns === 1) return true;

  return false;
}

function isSourceOrNoteRow(cells) {
  if (!cells.length) return false;
  const text = cleanText(cells.map(cell => cell.textContent).join(' '));
  return /^(source|note|notes|footnote)\s*:/i.test(text);
}

function isTitleRow(cells, maxColumns, rowIndex) {
  if (rowIndex > 1 || cells.length !== 1) return false;
  const cell = cells[0];
  return cell.tagName.toLowerCase() === 'th' || getSpan(cell, 'colspan') >= maxColumns;
}

function normalizeTable(table, tableNumber) {
  if (shouldSkipTable(table)) return null;

  const rows = Array.from(table.querySelectorAll('tr'));
  const maxColumns = getColumnCount(rows);
  let body = '';

  rows.forEach((row, rowIndex) => {
    const cells = Array.from(row.querySelectorAll('th,td'));
    if (!cells.length) return;

    if (isSourceOrNoteRow(cells)) {
      const text = escapeHtml(cleanText(cells.map(cell => cell.textContent).join(' ')));
      body += `<tr class="source-row"><td colspan="${maxColumns}">${text}</td></tr>`;
      return;
    }

    const titleRow = isTitleRow(cells, maxColumns, rowIndex);
    body += titleRow ? '<tr class="title-row">' : '<tr>';

    cells.forEach(cell => {
      const tag = titleRow || cell.tagName.toLowerCase() === 'th' || rowIndex === 0 ? 'th' : 'td';
      const attrs = [];

      const colspan = titleRow ? maxColumns : getSpan(cell, 'colspan');
      const rowspan = titleRow ? 1 : getSpan(cell, 'rowspan');

      if (colspan > 1) attrs.push(`colspan="${colspan}"`);
      if (rowspan > 1) attrs.push(`rowspan="${rowspan}"`);

      body += `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${getCellHtml(cell)}</${tag}>`;
    });

    body += '</tr>';
  });

  if (!body) return null;

  return `
<section class="table-card" data-table-no="${tableNumber}">
  <div class="table-card__header">
    <h2>Table ${tableNumber}</h2>
    <button type="button" class="download-btn" data-table-index="${tableNumber - 1}">Download HTML</button>
  </div>
  <div class="table-scroll">
    <table class="pro-table">${body}</table>
  </div>
</section>`;
}

function extractTables(html) {
  const dom = new JSDOM(html);
  const tables = Array.from(dom.window.document.querySelectorAll('table'));
  const output = [];

  tables.forEach(table => {
    const normalized = normalizeTable(table, output.length + 1);
    if (normalized) output.push(normalized);
  });

  return output;
}

app.post('/upload', upload.array('files'), async (req, res) => {
  const files = req.files || [];

  if (!files.length) {
    return res.status(400).json({ error: 'Please choose at least one DOCX file.' });
  }

  try {
    const tables = [];

    for (const file of files) {
      const result = await mammoth.convertToHtml({ path: file.path });
      tables.push(...extractTables(result.value));
      fs.unlink(file.path, () => {});
    }

    return res.json({ tables });
  } catch (error) {
    files.forEach(file => fs.unlink(file.path, () => {}));
    console.error(error);
    return res.status(500).json({ error: 'DOCX conversion failed. Please upload a valid DOCX file.' });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Table Converter Pro</title>
  <style>
    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #f5f7fb;
      color: #172033;
    }

    .app-shell {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 36px 0;
    }

    .hero {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 22px;
      margin-bottom: 24px;
    }

    .panel,
    .table-card {
      background: #fff;
      border: 1px solid #d8e0ec;
      border-radius: 16px;
      box-shadow: 0 14px 34px rgba(15, 23, 42, 0.08);
    }

    .intro,
    .upload-card {
      padding: 28px;
    }

    .badge {
      display: inline-block;
      padding: 7px 11px;
      border-radius: 999px;
      background: #eef4ff;
      color: #1d4ed8;
      font-weight: 700;
      font-size: 13px;
    }

    h1 {
      margin: 16px 0 10px;
      font-size: 42px;
      line-height: 1.05;
      letter-spacing: -0.04em;
    }

    p {
      margin: 0;
      color: #64748b;
      line-height: 1.65;
    }

    .drop-zone {
      display: block;
      border: 2px dashed #a9b8d0;
      border-radius: 14px;
      padding: 28px;
      text-align: center;
      background: #f8fafc;
      cursor: pointer;
    }

    .drop-zone strong {
      display: block;
      font-size: 18px;
      margin-bottom: 6px;
    }

    .drop-zone span {
      color: #64748b;
      font-size: 14px;
    }

    input[type="file"] {
      display: none;
    }

    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 16px;
    }

    button,
    .file-label {
      border: 0;
      border-radius: 10px;
      padding: 12px 16px;
      font-weight: 700;
      cursor: pointer;
      font-size: 14px;
    }

    .primary-btn,
    .file-label,
    .download-btn {
      background: #2563eb;
      color: #fff;
    }

    .secondary-btn {
      background: #e8eef8;
      color: #1e293b;
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .status {
      min-height: 22px;
      margin-top: 14px;
      color: #64748b;
      font-weight: 650;
    }

    .status.error { color: #dc2626; }
    .status.success { color: #15803d; }

    .results {
      display: grid;
      gap: 22px;
    }

    .empty-state {
      padding: 34px;
      text-align: center;
      color: #64748b;
    }

    .table-card {
      overflow: hidden;
    }

    .table-card__header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      padding: 16px 18px;
      border-bottom: 1px solid #d8e0ec;
    }

    .table-card__header h2 {
      margin: 0;
      font-size: 19px;
    }

    .table-scroll {
      overflow-x: auto;
      padding: 18px;
    }

    .pro-table {
      width: 100%;
      border-collapse: collapse;
      background: #ffffff;
      font-size: 15px;
    }

    .pro-table th,
    .pro-table td {
      border: 1px solid #000;
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
      line-height: 1.45;
      background: transparent;
      color: inherit;
    }

    .pro-table th {
      font-weight: 700;
    }

    .pro-table .title-row th,
    .pro-table .source-row td {
      background: transparent;
      color: inherit;
    }

    .pro-table ul,
    .pro-table ol {
      margin: 0;
      padding-left: 22px;
    }

    .pro-table li {
      margin: 4px 0;
    }

    @media (max-width: 860px) {
      .hero {
        grid-template-columns: 1fr;
      }

      h1 {
        font-size: 32px;
      }
    }
  </style>
</head>
<body>
  <main class="app-shell">
    <section class="hero">
      <div class="panel intro">
      <img style="display:block; margin-bottom:10px" width="150" src="https://www.lendingtree.com/content/uploads/2025/03/LendingTree-Logo.webp" alt="LendingTree Logo" class="aligncenter size-full wp-image-1462639" />
        <span class="badge">Created By : Hitesh Gabu (Sr. Software Engineer)</span>
        <h1>Generate clean HTML tables.</h1>
       
      </div>

      <div class="panel upload-card">
        <label class="drop-zone" id="dropZone" for="fileInput">
          <strong>Drop DOCX files here</strong>
          <span>or click to browse. Multiple files supported.</span>
        </label>

        <input type="file" id="fileInput" multiple accept=".docx" />

        <div class="actions">
          <label class="file-label" for="fileInput">Choose files</label>
          <button class="primary-btn" id="uploadBtn" type="button">Generate Tables</button>
          <button class="secondary-btn" id="clearBtn" type="button">Clear</button>
        </div>

        <div class="status" id="status">No file selected.</div>
      </div>
    </section>

    <section id="output" class="results">
      <div class="panel empty-state">Converted tables will appear here.</div>
    </section>
  </main>

  <script>
    const fileInput = document.getElementById('fileInput');
    const uploadBtn = document.getElementById('uploadBtn');
    const clearBtn = document.getElementById('clearBtn');
    const output = document.getElementById('output');
    const statusBox = document.getElementById('status');
    const dropZone = document.getElementById('dropZone');

    let tablesData = [];

    function setStatus(message, type = '') {
      statusBox.textContent = message;
      statusBox.className = 'status' + (type ? ' ' + type : '');
    }

    function selectedFilesText() {
      const files = Array.from(fileInput.files || []);
      if (!files.length) return 'No file selected.';
      return files.map(file => file.name).join(', ');
    }

    function attrString(element) {
      return Array.from(element.attributes || [])
        .map(attr => attr.name + '="' + attr.value + '"')
        .join(' ');
    }

    function openTag(element) {
      const attrs = attrString(element);
      return attrs ? '<' + element.tagName.toLowerCase() + ' ' + attrs + '>' : '<' + element.tagName.toLowerCase() + '>';
    }

    function beautifyTableHtml(rawHtml) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = rawHtml;

      const table = wrapper.querySelector('table');
      if (!table) return rawHtml.trim();

      const lines = [];
      lines.push(openTag(table));

      Array.from(table.rows).forEach(row => {
        lines.push('  ' + openTag(row));

        Array.from(row.cells).forEach(cell => {
          const tagName = cell.tagName.toLowerCase();
          const attrs = attrString(cell);
          const startTag = attrs ? '<' + tagName + ' ' + attrs + '>' : '<' + tagName + '>';
          lines.push('    ' + startTag + cell.innerHTML.trim() + '</' + tagName + '>');
        });

        lines.push('  </tr>');
      });

      lines.push('</table>');
      return lines.join('\\n');
    }

    function buildDownloadHtml(tableSectionHtml) {
      const tableOnlyHtml = beautifyTableHtml(tableSectionHtml);

      return '<!DOCTYPE html>\\n' +
'<html lang="en">\\n' +
'<head>\\n' +
'  <meta charset="UTF-8" />\\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\\n' +
'  <title>Table Export</title>\\n' +
'  <style>\\n' +
'    body {\\n' +
'      font-family: Arial, sans-serif;\\n' +
'      margin: 24px;\\n' +
'      color: #172033;\\n' +
'    }\\n\\n' +
'    .pro-table {\\n' +
'      width: 100%;\\n' +
'      border-collapse: collapse;\\n' +
'      background: #ffffff;\\n' +
'    }\\n\\n' +
'    .pro-table th,\\n' +
'    .pro-table td {\\n' +
'      border: 1px solid #000;\\n' +
'      padding: 10px 12px;\\n' +
'      text-align: left;\\n' +
'      vertical-align: top;\\n' +
'      line-height: 1.45;\\n' +
'      background: transparent;\\n' +
'      color: inherit;\\n' +
'    }\\n\\n' +
'    .pro-table th {\\n' +
'      font-weight: 700;\\n' +
'    }\\n\\n' +
'    .pro-table ul,\\n' +
'    .pro-table ol {\\n' +
'      margin: 0;\\n' +
'      padding-left: 22px;\\n' +
'    }\\n\\n' +
'    .pro-table li {\\n' +
'      margin: 4px 0;\\n' +
'    }\\n' +
'  </style>\\n' +
'</head>\\n' +
'<body>\\n\\n' +
tableOnlyHtml + '\\n\\n' +
'</body>\\n' +
'</html>\\n';
    }

    fileInput.addEventListener('change', () => {
      setStatus(selectedFilesText());
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, event => {
        event.preventDefault();
        dropZone.style.borderColor = '#2563eb';
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, event => {
        event.preventDefault();
        dropZone.style.borderColor = '#a9b8d0';
      });
    });

    dropZone.addEventListener('drop', event => {
      fileInput.files = event.dataTransfer.files;
      setStatus(selectedFilesText());
    });

    uploadBtn.addEventListener('click', upload);

    clearBtn.addEventListener('click', () => {
      fileInput.value = '';
      tablesData = [];
      output.innerHTML = '<div class="panel empty-state">Converted tables will appear here.</div>';
      setStatus('No file selected.');
    });

    output.addEventListener('click', event => {
      const button = event.target.closest('.download-btn');
      if (!button) return;
      download(Number(button.dataset.tableIndex));
    });

    async function upload() {
      const files = Array.from(fileInput.files || []);

      if (!files.length) {
        setStatus('Please select at least one DOCX file.', 'error');
        return;
      }

      const formData = new FormData();
      files.forEach(file => formData.append('files', file));

      uploadBtn.disabled = true;
      setStatus('Converting tables...');
      output.innerHTML = '<div class="panel empty-state">Processing your document...</div>';

      try {
        const response = await fetch('/upload', {
          method: 'POST',
          body: formData
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Upload failed.');
        }

        tablesData = data.tables || [];

        if (!tablesData.length) {
          output.innerHTML = '<div class="panel empty-state">No tables found in the uploaded document.</div>';
          setStatus('No tables found.', 'error');
          return;
        }

        output.innerHTML = tablesData.join('');
        setStatus(tablesData.length + ' table(s) converted successfully.', 'success');
      } catch (error) {
        output.innerHTML = '<div class="panel empty-state">Conversion failed. Please try another DOCX file.</div>';
        setStatus(error.message, 'error');
      } finally {
        uploadBtn.disabled = false;
      }
    }

    function download(index) {
      const table = tablesData[index];
      if (!table) return;

      const html = buildDownloadHtml(table);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const link = document.createElement('a');

      link.href = URL.createObjectURL(blob);
      link.download = 'table_' + (index + 1) + '.html';
      link.click();

      URL.revokeObjectURL(link.href);
    }
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
