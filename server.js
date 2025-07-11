const fs = require('fs');
const https = require('https');
const express = require('express');
const puppeteer = require('puppeteer');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const PDFDocument = require('pdfkit');
const { createClient } = require('@supabase/supabase-js');
const stream = require('stream');
require('dotenv').config(); // Load Supabase env vars

const app = express();
app.use(express.json());

// 🔐 Supabase credentials
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
const BUCKET_NAME = 'avatars';

// 🧠 Helper: Convert text to PDF and return a stream buffer
function generatePDFBuffer(text, title = 'Extracted Page') {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const bufferStream = new stream.PassThrough();
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.pipe(bufferStream);
    doc.fontSize(16).text(title, { underline: true });
    doc.moveDown().fontSize(12).text(text, { align: 'left' });
    doc.end();
  });
}

// 📥 Route: GET /extract?url=https://example.com
app.get('/extract', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing URL query param' });

  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const html = await page.content();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article?.textContent) {
      return res.status(422).json({ error: 'Could not extract content' });
    }

    const filename = `extracted-${Date.now()}.pdf`;

    // 📄 Generate PDF
    const pdfBuffer = await generatePDFBuffer(article.textContent, article.title || 'Extracted Page');

    // ☁️ Upload to Supabase
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filename, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (error) {
      console.error('❌ Supabase upload error:', error.message);
      return res.status(500).json({ error: 'Upload failed', detail: error.message });
    }

    const { data: publicUrlData } = supabase
      .storage
      .from(BUCKET_NAME)
      .getPublicUrl(filename);

    res.json({
      title: article.title,
      url: publicUrlData.publicUrl,
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// 🔐 HTTPS Setup
const sslOptions = {
  key: fs.readFileSync('/etc/ssl/private/selfsigned.key'),
  cert: fs.readFileSync('/etc/ssl/private/selfsigned.crt'),
};

const PORT = process.env.PORT || 3000;

https.createServer(sslOptions, app).listen(PORT, () => {
  console.log(`✅ HTTPS server running at https://<your-ip>:${PORT}/extract?url=https://example.com`);
});
