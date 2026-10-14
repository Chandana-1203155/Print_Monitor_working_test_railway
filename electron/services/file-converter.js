/**
 * File Converter Service
 * Converts Word, Excel, PowerPoint, Images, Text files to PDF
 * so they can be printed through SecurePrint.
 *
 * Conversion strategies:
 *   - Office files (.doc, .docx, .xls, .xlsx, .ppt, .pptx, .rtf)
 *       → Microsoft Office COM automation via PowerShell (primary)
 *       → LibreOffice headless mode (fallback)
 *   - Images (.jpg, .png, .bmp, .gif, .tiff)
 *       → PDFKit embedding
 *   - Text (.txt, .csv, .log)
 *       → PDFKit text rendering
 */

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const os = require('os');

const TEMP_DIR = path.join(os.tmpdir(), 'secureprint-convert');

const SUPPORTED_EXTENSIONS = {
  // Already PDF
  '.pdf': 'pdf',
  // Office documents
  '.doc': 'word', '.docx': 'word', '.rtf': 'word',
  '.xls': 'excel', '.xlsx': 'excel',
  '.ppt': 'powerpoint', '.pptx': 'powerpoint',
  // Images
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image',
  '.bmp': 'image', '.gif': 'image', '.tiff': 'image', '.tif': 'image',
  // Text
  '.txt': 'text', '.csv': 'text', '.log': 'text',
};

function isSupported(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext in SUPPORTED_EXTENSIONS;
}

function getFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS[ext] || null;
}

function getSupportedFormats() {
  return Object.keys(SUPPORTED_EXTENSIONS).map(e => e.replace('.', '')).join(', ');
}

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function getOutputPath(inputPath) {
  ensureTempDir();
  const baseName = path.basename(inputPath, path.extname(inputPath));
  return path.join(TEMP_DIR, `${baseName}_${Date.now()}.pdf`);
}

/**
 * Main conversion entry point.
 * Returns the path to a PDF file ready for printing.
 */
async function convertToPdf(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error('File not found: ' + filePath);
  }

  const fileType = getFileType(filePath);
  if (!fileType) {
    throw new Error(`Unsupported file format: ${path.extname(filePath)}. Supported: ${getSupportedFormats()}`);
  }

  if (fileType === 'pdf') return filePath;

  const outputPath = getOutputPath(filePath);

  switch (fileType) {
    case 'word':
    case 'excel':
    case 'powerpoint':
      await convertOfficeFile(filePath, outputPath, fileType);
      break;
    case 'image':
      await convertImageToPdf(filePath, outputPath);
      break;
    case 'text':
      await convertTextToPdf(filePath, outputPath);
      break;
    default:
      throw new Error('No converter available for type: ' + fileType);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error('Conversion failed — output file was not created.');
  }

  return outputPath;
}

// ─── Office Conversion via PowerShell COM ───

function convertOfficeFile(inputPath, outputPath, fileType) {
  // Try MS Office COM first, then LibreOffice fallback
  return convertWithOfficeCOM(inputPath, outputPath, fileType)
    .catch(() => convertWithLibreOffice(inputPath, outputPath));
}

function convertWithOfficeCOM(inputPath, outputPath, fileType) {
  const escapedInput = inputPath.replace(/'/g, "''");
  const escapedOutput = outputPath.replace(/'/g, "''");

  let psScript;

  if (fileType === 'word') {
    psScript = `
      $ErrorActionPreference = 'Stop'
      $word = New-Object -ComObject Word.Application
      $word.Visible = $false
      $word.DisplayAlerts = 0
      try {
        $doc = $word.Documents.Open('${escapedInput}')
        $doc.SaveAs([ref]'${escapedOutput}', [ref]17)
        $doc.Close([ref]$false)
      } finally {
        $word.Quit()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
      }
    `;
  } else if (fileType === 'excel') {
    psScript = `
      $ErrorActionPreference = 'Stop'
      $excel = New-Object -ComObject Excel.Application
      $excel.Visible = $false
      $excel.DisplayAlerts = $false
      try {
        $wb = $excel.Workbooks.Open('${escapedInput}')
        $wb.ExportAsFixedFormat(0, '${escapedOutput}')
        $wb.Close($false)
      } finally {
        $excel.Quit()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
      }
    `;
  } else if (fileType === 'powerpoint') {
    psScript = `
      $ErrorActionPreference = 'Stop'
      $ppt = New-Object -ComObject PowerPoint.Application
      try {
        $pres = $ppt.Presentations.Open('${escapedInput}', $true, $false, $false)
        $pres.SaveAs('${escapedOutput}', 32)
        $pres.Close()
      } finally {
        $ppt.Quit()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
      }
    `;
  }

  return runPowerShell(psScript);
}

function convertWithLibreOffice(inputPath, outputPath) {
  const outDir = path.dirname(outputPath);
  // Try common LibreOffice paths
  const librePaths = [
    'soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice'
  ];

  return new Promise((resolve, reject) => {
    let tried = 0;
    function tryNext() {
      if (tried >= librePaths.length) {
        return reject(new Error(
          'Neither Microsoft Office nor LibreOffice found. Install one of them to convert this file format.'
        ));
      }
      const soffice = librePaths[tried++];
      const cmd = `"${soffice}" --headless --convert-to pdf --outdir "${outDir}" "${inputPath}"`;
      exec(cmd, { timeout: 60000 }, (err) => {
        if (err) return tryNext();
        // LibreOffice names the output after the input file
        const libreOutput = path.join(outDir, path.basename(inputPath, path.extname(inputPath)) + '.pdf');
        if (fs.existsSync(libreOutput)) {
          if (libreOutput !== outputPath) {
            fs.renameSync(libreOutput, outputPath);
          }
          resolve(outputPath);
        } else {
          tryNext();
        }
      });
    }
    tryNext();
  });
}

// ─── Image Conversion ───

async function convertImageToPdf(imagePath, outputPath) {
  const PDFDocument = require('pdfkit');

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ autoFirstPage: false });
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      const img = doc.openImage(imagePath);
      // Fit image to A4 page with margins
      const pageWidth = 595.28;   // A4 width in points
      const pageHeight = 841.89;  // A4 height in points
      const margin = 36;          // 0.5 inch margin
      const maxW = pageWidth - 2 * margin;
      const maxH = pageHeight - 2 * margin;

      let w = img.width;
      let h = img.height;
      const scale = Math.min(maxW / w, maxH / h, 1);
      w *= scale;
      h *= scale;

      doc.addPage({ size: 'A4' });
      const x = (pageWidth - w) / 2;
      const y = (pageHeight - h) / 2;
      doc.image(imagePath, x, y, { width: w, height: h });

      doc.end();
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

// ─── Text Conversion ───

async function convertTextToPdf(textPath, outputPath) {
  const PDFDocument = require('pdfkit');

  return new Promise((resolve, reject) => {
    try {
      const text = fs.readFileSync(textPath, 'utf-8');
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 }
      });
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      doc.fontSize(10).font('Courier');

      // Add file name as header
      doc.fontSize(12).font('Helvetica-Bold')
        .text(path.basename(textPath), { align: 'center' })
        .moveDown(0.5);

      doc.fontSize(9).fillColor('#666')
        .text(`Converted by SecurePrint — ${new Date().toLocaleString()}`, { align: 'center' })
        .moveDown(1);

      // Add text content
      doc.fontSize(10).font('Courier').fillColor('#000');
      const lines = text.split('\n');
      for (const line of lines) {
        if (doc.y > 780) {
          doc.addPage();
        }
        doc.text(line || ' ', { width: 495 });
      }

      doc.end();
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

// ─── Utility ───

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const escaped = script.replace(/"/g, '\\"');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${escaped}"`;
    exec(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error('PowerShell conversion failed: ' + (stderr || err.message)));
      } else {
        resolve(stdout);
      }
    });
  });
}

function cleanupTempFiles() {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      const files = fs.readdirSync(TEMP_DIR);
      const now = Date.now();
      for (const f of files) {
        const fp = path.join(TEMP_DIR, f);
        const stat = fs.statSync(fp);
        // Delete temp files older than 1 hour
        if (now - stat.mtimeMs > 3600000) {
          fs.unlinkSync(fp);
        }
      }
    }
  } catch (e) { /* ignore cleanup errors */ }
}

module.exports = {
  convertToPdf,
  isSupported,
  getFileType,
  getSupportedFormats,
  cleanupTempFiles,
  SUPPORTED_EXTENSIONS
};
