const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cleanText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function cellContent(cell) {
  const lists = cell.querySelectorAll('ul, ol');
  if (lists.length) {
    const items = [];
    lists.forEach((list) => {
      list.querySelectorAll('li').forEach((li) => {
        const text = cleanText(li.textContent);
        if (text) items.push(`• ${escapeHtml(text)}`);
      });
    });
    return items.join('<br>');
  }
  return escapeHtml(cleanText(cell.textContent));
}

function getSpan(cell, attribute) {
  const raw = Number.parseInt(cell.getAttribute(attribute), 10);
  return Number.isFinite(raw) && raw > 1 ? raw : 1;
}

function columnCount(rows) {
  let max = 0;
  rows.forEach((row) => {
    let count = 0;
    row.querySelectorAll('th, td').forEach((cell) => {
      count += getSpan(cell, 'colspan');
    });
    max = Math.max(max, count);
  });
  return Math.max(max, 1);
}

function isSourceOrNoteRow(row) {
  const cells = Array.from(row.querySelectorAll('th, td'));
  if (!cells.length) return false;
  const text = cleanText(cells.map((cell) => cell.textContent).join(' '));
  return /^(source|note|notes)\s*:/i.test(text);
}

function isTitleRow(row, maxColumns, rowIndex) {
  if (rowIndex > 1) return false;
  const cells = Array.from(row.querySelectorAll('th, td'));
  if (cells.length !== 1) return false;
  const span = getSpan(cells[0], 'colspan');
  return span >= maxColumns || cells[0].tagName.toLowerCase() === 'th';
}

function normalizeTable(tableHTML, tableNumber) {
  const dom = new JSDOM(tableHTML);
  const document = dom.window.document;
  const table = document.querySelector('table');
  if (!table) return '';

  const rows = Array.from(table.querySelectorAll('tr'));
  const maxColumns = columnCount(rows);

  let html = '<div class="table-card">';
  html += `<div class="table-card__header"><h2>Table ${tableNumber}</h2><button type="button" class="download-btn" data-table-index="${tableNumber - 1}">Download</button></div>`;
  html += '<div class="table-scroll"><table class="pro-table">';

  rows.forEach((row, rowIndex) => {
    const originalCells = Array.from(row.querySelectorAll('th, td'));
    if (!originalCells.length) return;

    if (isSourceOrNoteRow(row)) {
      const sourceText = cellContent({
        textContent: originalCells.map((cell) => cell.textContent).join(' '),
        querySelectorAll: () => [],
      });
      html += `<tr class="source-row"><td colspan="${maxColumns}">${sourceText}</td></tr>`;
      return;
    }

    const titleRow = isTitleRow(row, maxColumns, rowIndex);
    html += titleRow ? '<tr class="title-row">' : '<tr>';

    originalCells.forEach((cell) => {
      const tagName = cell.tagName.toLowerCase() === 'th' || rowIndex <= 1 || titleRow ? 'th' : 'td';
      const colspan = getSpan(cell, 'colspan');
      const rowspan = titleRow ? 1 : getSpan(cell, 'rowspan');
      const attrs = [];
      if (colspan > 1) attrs.push(`colspan="${colspan}"`);
      if (rowspan > 1) attrs.push(`rowspan="${rowspan}"`);
      html += `<${tagName}${attrs.length ? ' ' + attrs.join(' ') : ''}>${cellContent(cell)}</${tagName}>`;
    });

    html += '</tr>';
  });

  html += '</table></div></div>';
  return html;
}

function extractTables(html) {
  const dom = new JSDOM(html);
  const tables = Array.from(dom.window.document.querySelectorAll('table'));
  return tables.map((table, index) => normalizeTable(table.outerHTML, index + 1)).filter(Boolean);
}

app.post('/upload', upload.array('files'), async (req, res) => {
  const uploadedFiles = req.files || [];
  if (!uploadedFiles.length) {
    return res.status(400).json({ error: 'Please upload at least one DOCX file.' });
  }

  try {
    const allTables = [];

    for (const file of uploadedFiles) {
      const result = await mammoth.convertToHtml({ path: file.path });
      allTables.push(...extractTables(result.value));
      fs.unlink(file.path, () => {});
    }

    return res.json({ tables: allTables });
  } catch (error) {
    uploadedFiles.forEach((file) => fs.unlink(file.path, () => {}));
    console.error(error);
    return res.status(500).json({ error: 'DOCX conversion failed. Please check the file and try again.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
