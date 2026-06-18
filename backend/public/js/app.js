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
  return lines.join('\n');
}

function buildDownloadHtml(tableSectionHtml) {
  const tableOnlyHtml = beautifyTableHtml(tableSectionHtml);

  return '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'  <meta charset="UTF-8" />\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
'  <title>Table Export</title>\n' +
'  <style>\n' +
'    body {\n' +
'      font-family: Arial, sans-serif;\n' +
'      margin: 24px;\n' +
'      color: #172033;\n' +
'    }\n\n' +
'    .pro-table {\n' +
'      width: 100%;\n' +
'      border-collapse: collapse;\n' +
'      background: #ffffff;\n' +
'    }\n\n' +
'    .pro-table th,\n' +
'    .pro-table td {\n' +
'      border: 1px solid #000;\n' +
'      padding: 10px 12px;\n' +
'      text-align: left;\n' +
'      vertical-align: top;\n' +
'      line-height: 1.45;\n' +
'      background: transparent;\n' +
'      color: inherit;\n' +
'    }\n\n' +
'    .pro-table th {\n' +
'      font-weight: 700;\n' +
'    }\n\n' +
'    .pro-table ul,\n' +
'    .pro-table ol {\n' +
'      margin: 0;\n' +
'      padding-left: 22px;\n' +
'    }\n\n' +
'    .pro-table li {\n' +
'      margin: 4px 0;\n' +
'    }\n' +
'  </style>\n' +
'</head>\n' +
'<body>\n\n' +
tableOnlyHtml + '\n\n' +
'</body>\n' +
'</html>\n';
}

fileInput.addEventListener('change', () => {
  setStatus(selectedFilesText());
});

['dragenter', 'dragover'].forEach(eventName => {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
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
