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

  if (['strong', 'b', 'em', 'i', 'u', 'sup', 'sub', 'br'].includes(tag)) {
    return tag === 'br' ? '<br>' : `<${tag}>${content}</${tag}>`;
  }

  return content;
}

function renderList(list) {
  const tag = list.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul';

  const items = Array.from(list.children)
    .filter(child => child.tagName && child.tagName.toLowerCase() === 'li')
    .map(li => {
      const liContent = Array.from(li.childNodes)
        .map(child => {
          if (child.nodeType === 1 && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
            return renderList(child);
          }
          return renderInlineNode(child);
        })
        .join('')
        .trim();

      return liContent ? `<li>${liContent}</li>` : '';
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
      const innerLists = Array.from(node.children).filter(child =>
        ['ul', 'ol'].includes(child.tagName.toLowerCase())
      );

      if (innerLists.length) {
        innerLists.forEach(list => {
          const listHtml = renderList(list);
          if (listHtml) parts.push(listHtml);
        });
      } else {
        const html = Array.from(node.childNodes).map(renderInlineNode).join('').trim();
        if (html) parts.push(`<p>${html}</p>`);
      }

      return;
    }

    const html = renderInlineNode(node).trim();
    if (html) parts.push(html);
  });

  if (!parts.length) return escapeHtml(cleanText(cell.textContent));

  return parts.join('');
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

  if (cells.length === 1 && /^<\/?(div|section|article|aside|p|h[1-6]|span|br)\b/i.test(text)) {
    return true;
  }

  if (/Callout--root|Callout--container|COPY HERE/i.test(text)) {
    return true;
  }

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
    <button type="button" class="download-btn" data-table-index="${tableNumber - 1}">Download</button>
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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});