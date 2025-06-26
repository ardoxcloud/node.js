const express = require('express');
const cheerio = require('cheerio');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const officegen = require('officegen');

const app = express();
const port = 5000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Fungsi Ekstraksi Artikel
async function extractArticle(url) {
  try {
    console.log(`🔍 Mengambil artikel dari: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9',
        'Referer': url,
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 500
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Judul artikel
    let title =
      $('h1').first().text() ||
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="title"]').attr('content') ||
      $('title').text();

    title = title ? title.trim() : 'Tanpa Judul';

    // Konten artikel
    let content = '';
    const selectors = [
      'article',
      '[class*="content"]',
      '[class*="article"]',
      '[id*="content"]',
      '[id*="article"]',
      'main',
      '.post-content',
      '.entry-content'
    ];

    for (let selector of selectors) {
      const element = $(selector);
      if (element.length > 0) {
        element.find('script, style, nav, footer, header, aside, .ads, .advertisement').remove();
        const paragraphs = element.find('p');
        if (paragraphs.length > 0) {
          paragraphs.each((i, el) => {
            const text = $(el).text().trim();
            if (text.length > 40) content += text + '\n\n';
          });
          break;
        }
      }
    }

    if (!content) {
      $('p').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 40) content += text + '\n\n';
      });
    }

    if (!content) throw new Error('Gagal mengekstrak konten artikel');

    return { title, content, url };
  } catch (err) {
    console.error('❌ Gagal mengekstrak artikel:', err.message);
    throw new Error('Gagal mengekstrak artikel: ' + err.message);
  }
}

// Fungsi DOCX
function createDocx(title, content) {
  return new Promise((resolve, reject) => {
    const docx = officegen('docx');
    const titleP = docx.createP();
    titleP.addText(title, { bold: true, font_size: 18 });

    content.split('\n\n').forEach(para => {
      if (para.trim()) {
        const p = docx.createP();
        p.addText(para.trim());
      }
    });

    const filename = `article_${Date.now()}.docx`;
    const filepath = path.join(__dirname, 'temp', filename);
    if (!fs.existsSync(path.join(__dirname, 'temp'))) fs.mkdirSync(path.join(__dirname, 'temp'));

    const out = fs.createWriteStream(filepath);
    docx.generate(out);

    out.on('close', () => resolve({ filename, filepath }));
    out.on('error', reject);
  });
}

// Fungsi PDF
async function createPdf(title, content) {
  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();

    // Escape karakter HTML spesial
    const escapeHtml = (unsafe) => unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    const safeTitle = escapeHtml(title);
    const safeContent = content
      .split('\n\n')
      .map(p => `<p>${escapeHtml(p.trim())}</p>`)
      .join('');

    const html = `
      <html><head><meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; font-size: 14px; color: #333; }
        h1 { font-size: 22px; text-align: center; margin-bottom: 30px; }
        p { margin: 10px 0; text-align: justify; line-height: 1.6; }
      </style>
      </head><body>
      <h1>${safeTitle}</h1>
      ${safeContent}
      </body></html>
    `;

    await page.setContent(html, { waitUntil: 'load' });

    const filename = `article_${Date.now()}.pdf`;
    const filepath = path.join(__dirname, 'temp', filename);
    if (!fs.existsSync(path.join(__dirname, 'temp'))) fs.mkdirSync(path.join(__dirname, 'temp'));

    await page.pdf({
      path: filepath,
      format: 'A4',
      printBackground: true,
      margin: { top: '40px', bottom: '40px', left: '30px', right: '30px' }
    });

    const stats = fs.statSync(filepath);
    console.log('✅ PDF berhasil dibuat:', filepath);
    console.log('📦 Ukuran file PDF:', stats.size, 'bytes');

    await browser.close();
    return { filename, filepath };
  } catch (err) {
    console.error('❌ Gagal membuat PDF:', err.message);
    throw new Error('Gagal membuat PDF: ' + err.message);
  }
}

// Fungsi HTML
function createHtml(title, content, origin = 'html') {
  const html = `
    <html><head><meta charset="UTF-8">
    <style>body{font-family:Georgia;margin:40px;} h1{color:#333;} p{text-align:justify;margin-bottom:20px;}</style>
    </head><body>
    <h1>${title}</h1>
    ${content.split('\n\n').map(p => `<p>${p.trim()}</p>`).join('')}
    </body></html>
  `;
  const filename = `article_${Date.now()}.html`;
  const filepath = path.join(__dirname, 'temp', filename);
  if (!fs.existsSync(path.join(__dirname, 'temp'))) fs.mkdirSync(path.join(__dirname, 'temp'));
  fs.writeFileSync(filepath, html);
  return { filename, filepath };
}

// API: Ekstraksi artikel
app.post('/api/extract-article', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL tidak boleh kosong' });
    const data = await extractArticle(url);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Download artikel
app.post('/api/download-article', async (req, res) => {
  try {
    const { title, content, format } = req.body;
    if (!title || !content || !format) return res.status(400).json({ error: 'Data tidak lengkap' });

    let fileData;
    if (format === 'docx') fileData = await createDocx(title, content);
    else if (format === 'pdf') fileData = await createPdf(title, content);
    else fileData = createHtml(title, content);

    res.download(fileData.filepath, fileData.filename, err => {
      if (err) console.error('Download error:', err);
      setTimeout(() => fs.unlink(fileData.filepath, () => {}), 3000);
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Test
app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend berjalan!', time: new Date().toISOString() });
});

// Root route
app.get('/', (req, res) => {
  res.send('<h1>Article Downloader API</h1><p>Coba POST ke /api/extract-article</p>');
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Server berjalan di http://localhost:${port}`);
});
